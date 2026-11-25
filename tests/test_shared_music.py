"""Host authority, room isolation, late arrivals and the shared playback clock."""
from pathlib import Path
import tempfile
import unittest
import wave

from app import create_app
from werewolf.game import GameService
from tests.test_game import Clock


class SharedMusicTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.folder = Path(self.tmp.name)
        self.write_track('01 Ночь.wav', 10)
        self.write_track('02 Лес.wav', 20)
        self.clock = Clock()
        self.game = GameService(self.clock)
        self.app = create_app(self.game)
        self.app.testing = True
        self.app.config['MUSIC_DIR'] = str(self.folder)
        self.client = self.app.test_client()
        self.host = self.client.post('/api/rooms', json={'name':'Host'}).json
        self.code = self.host['code']
        self.guest = self.client.post(f'/api/rooms/{self.code}/join', json={'name':'Guest'}).json

    def write_track(self, filename, seconds):
        with wave.open(str(self.folder / filename), 'wb') as f:
            f.setnchannels(1); f.setsampwidth(2); f.setframerate(8000)
            f.writeframes(b'\0\0' * 8000 * seconds)

    def headers(self, who):
        return {'Authorization':'Bearer ' + who['token']}

    def view(self, who=None):
        who = who or self.host
        return self.client.get(f"/api/rooms/{who['code']}", headers=self.headers(who)).json

    def control(self, operation, who=None, **data):
        who = who or self.host
        revision = self.view(who)['music']['revision']
        return self.client.post(f"/api/rooms/{who['code']}/music", headers=self.headers(who),
                                json=dict(operation=operation, revision=revision, **data))

    def test_only_authenticated_host_can_control(self):
        for operation in ['play','pause','next','select']:
            self.assertEqual(self.control(operation, self.guest, file='02 Лес.wav').status_code, 403)
        self.assertEqual(self.client.post(f'/api/rooms/{self.code}/music',
                                         json=dict(operation='play', revision=1)).status_code, 401)
        self.assertFalse(self.view()['music']['playing'])

    def test_two_rooms_have_independent_music_and_tokens(self):
        other = self.client.post('/api/rooms', json={'name':'Other'}).json
        self.control('play')
        self.clock.now += 3
        self.assertEqual(self.view(self.guest)['music']['position'], 3)
        self.assertFalse(self.view(other)['music']['playing'])
        bad = self.client.post(f'/api/rooms/{self.code}/music', headers=self.headers(other),
                               json=dict(operation='pause', revision=2))
        self.assertEqual(bad.status_code, 401)

    def test_pause_and_resume_use_server_time_not_client_position(self):
        self.control('play', position=999999)
        self.clock.now += 4
        paused = self.control('pause').json['music']
        self.assertEqual(paused['position'], 4)
        self.clock.now += 100
        self.assertEqual(self.view(self.guest)['music']['position'], 4)
        self.control('play')
        self.clock.now += 3
        self.assertEqual(self.view(self.guest)['music']['position'], 7)

    def test_late_join_and_reconnect_follow_current_position(self):
        self.control('play')
        self.clock.now += 6
        late = self.client.post(f'/api/rooms/{self.code}/join', json={'name':'Late'}).json
        self.assertEqual(late['state']['music']['position'], 6)
        self.clock.now += 8
        self.assertEqual(self.view(late)['music']['file'], '02 Лес.wav')
        self.assertEqual(self.view(late)['music']['position'], 4)

    def test_automatic_playlist_loops_even_without_host_browser(self):
        self.control('play')
        self.clock.now += 65
        music = self.view(self.guest)['music']
        self.assertEqual(music['file'], '01 Ночь.wav')
        self.assertEqual(music['position'], 5)
        self.clock.now += 6
        music = self.view(self.guest)['music']
        self.assertEqual(music['file'], '02 Лес.wav')
        self.assertEqual(music['position'], 1)

    def test_select_next_keep_play_pause_state(self):
        selected = self.control('select', file='02 Лес.wav').json['music']
        self.assertFalse(selected['playing'])
        self.assertEqual(selected['position'], 0)
        self.control('play'); self.clock.now += 2
        next_track = self.control('next').json['music']
        self.assertTrue(next_track['playing'])
        self.assertEqual(next_track['file'], '01 Ночь.wav')
        self.assertEqual(next_track['position'], 0)

    def test_stale_controls_do_not_undo_newer_controls(self):
        revision = self.view()['music']['revision']
        self.control('play')
        stale = self.client.post(f'/api/rooms/{self.code}/music', headers=self.headers(self.host),
                                 json=dict(operation='pause', revision=revision))
        self.assertEqual(stale.status_code, 409)
        self.assertTrue(self.view()['music']['playing'])

    def test_unknown_files_invalid_commands_and_revision_are_rejected(self):
        self.assertEqual(self.control('select', file='../secret.wav').status_code, 404)
        self.assertEqual(self.control('select', file=['bad']).status_code, 404)
        self.assertEqual(self.control(['play']).status_code, 400)
        response = self.client.post(f'/api/rooms/{self.code}/music', headers=self.headers(self.host),
                                    json=dict(operation='play', revision=True))
        self.assertEqual(response.status_code, 409)

    def test_music_survives_game_phases_and_reset(self):
        self.client.post(f'/api/rooms/{self.code}/join', json={'name':'Third'})
        room = self.game.rooms[self.code]
        self.control('play')
        for p in room.players.values(): p.ready = True
        self.game.command(room, room.players[room.host], 'start', {})
        self.clock.now += 4
        self.game.command(room, room.players[room.host], 'reset', dict(stage=room.stage))
        self.assertEqual(self.view()['music']['position'], 4)
        self.assertTrue(self.view()['music']['playing'])

    def test_host_transfer_preserves_playback_and_transfers_authority(self):
        self.control('play')
        self.client.post(f'/api/rooms/{self.code}/leave', headers=self.headers(self.host), json={})
        self.clock.now += 2
        self.assertEqual(self.view(self.guest)['music']['position'], 2)
        self.assertEqual(self.control('pause', self.guest).status_code, 200)

    def test_deleted_and_replaced_files_and_empty_playlist(self):
        self.control('play'); self.clock.now += 3
        before = self.view()['music']['tracks'][0]['version']
        self.write_track('01 Ночь.wav', 11)
        music = self.view()['music']
        self.assertNotEqual(music['tracks'][0]['version'], before)
        self.assertEqual(music['position'], 0)
        (self.folder / '01 Ночь.wav').unlink()
        self.assertEqual(self.view()['music']['file'], '02 Лес.wav')
        (self.folder / '02 Лес.wav').unlink()
        music = self.view()['music']
        self.assertIsNone(music['file']); self.assertFalse(music['playing'])
        self.assertEqual(self.control('play').status_code, 400)

    def test_unreadable_duration_does_not_crash_or_loop_forever(self):
        (self.folder / '03 broken.mp3').write_bytes(b'not audio')
        self.assertEqual(self.control('select', file='03 broken.mp3').status_code, 200)
        self.control('play'); self.clock.now += 100000
        music = self.view()['music']
        self.assertEqual(music['file'], '03 broken.mp3')
        self.assertIsNone(music['tracks'][-1]['duration'])

    def test_catalog_exposes_duration_without_local_paths(self):
        tracks = self.view()['music']['tracks']
        self.assertEqual([t['duration'] for t in tracks], [10, 20])
        self.assertNotIn(str(self.folder), repr(tracks))


if __name__ == '__main__':
    unittest.main()
