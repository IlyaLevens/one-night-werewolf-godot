"""Private card snapshots and safe streaming of user-provided music."""
import tempfile
from pathlib import Path
from urllib.parse import quote
import unittest

from app import create_app
from werewolf.game import GameService
from werewolf.roles import NIGHT_ORDER
from tests.test_game import Clock


class CardObservationTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.game = GameService(self.clock)
        self.room, self.me = self.game.create('Аня')
        self.players = [self.me]
        for name in ['Борис', 'Вика']:
            self.players.append(self.game.join(self.room.code, name)[1])

    def deal(self, roles, center=None):
        self.room.round = 1
        for p, role in zip(self.players, roles):
            p.original = p.card = role
        self.room.center = center or ['hunter', 'tanner', 'villager']
        self.room.original_center = list(self.room.center)
        self.room.deck = roles + self.room.center
        self.room.night_steps = [r for r in NIGHT_ORDER if r in self.room.deck]
        self.game.begin_night(self.room, self.clock())

    def go_to(self, role):
        while self.room.night_role != role:
            self.clock.now = self.room.deadline
            self.game.tick(self.room)

    def act(self, player, **data):
        self.game.command(self.room, player, 'night_action', dict(stage=self.room.stage, **data))

    def test_seer_player_snapshot_private_and_not_live(self):
        self.deal(['seer', 'robber', 'werewolf'])
        self.go_to('seer')
        self.act(self.me, mode='player', targets=[self.players[1].id])
        note = self.game.view(self.room, self.me)['me']['notes'][-1]
        self.assertEqual(note['cards'], [dict(key='player:' + self.players[1].id, role='robber')])
        self.assertEqual(note['swap'], [])
        self.assertEqual(self.game.view(self.room, self.players[1])['me']['notes'], [])
        self.players[1].card = 'tanner'
        self.assertEqual(self.game.view(self.room, self.me)['me']['notes'][-1]['cards'][0]['role'], 'robber')
        self.assertIsNone(self.game.view(self.room, self.players[1])['result'])
        self.go_to('robber')
        self.assertNotEqual(note['stage'], self.room.stage)

    def test_seer_two_center_cards_only(self):
        self.deal(['seer', 'villager', 'werewolf'])
        self.go_to('seer')
        self.act(self.me, mode='center', center=[0, 2])
        cards = self.me.notes[-1]['cards']
        self.assertEqual(cards, [dict(key='center:0', role='hunter'), dict(key='center:2', role='villager')])
        self.assertNotIn('center', self.game.view(self.room, self.me))

    def test_robber_only_sees_received_card(self):
        self.deal(['robber', 'seer', 'werewolf'])
        self.go_to('robber')
        self.act(self.me, mode='player', targets=[self.players[1].id])
        note = self.me.notes[-1]
        self.assertEqual(note['cards'], [dict(key='player:' + self.me.id, role='seer')])
        self.assertEqual(note['swap'], ['player:' + self.me.id, 'player:' + self.players[1].id])
        self.assertEqual(self.me.original, 'robber')
        self.assertTrue(all(not n['swap'] for n in self.players[1].notes))

    def test_blind_swaps_never_return_roles(self):
        for role in ['troublemaker', 'drunk']:
            with self.subTest(role=role):
                self.setUp()
                self.deal([role, 'villager', 'werewolf'])
                self.go_to(role)
                data = dict(mode='players', targets=[p.id for p in self.players[1:]]) if role == 'troublemaker' else dict(mode='center', center=[1])
                self.act(self.me, **data)
                note = self.me.notes[-1]
                self.assertEqual(note['cards'], [])
                self.assertEqual(len(note['swap']), 2)
                self.assertTrue(all(not n['swap'] for p in self.players[1:] for n in p.notes))

    def test_automatic_role_observations(self):
        for roles, stage, expected in [
            (['werewolf','werewolf','villager'], 'werewolf', ['werewolf']),
            (['minion','werewolf','villager'], 'minion', ['werewolf']),
            (['mason','mason','werewolf'], 'mason', ['mason']),
            (['insomniac','robber','werewolf'], 'insomniac', ['insomniac']),
        ]:
            with self.subTest(stage=stage):
                self.setUp(); self.deal(roles); self.go_to(stage)
                self.assertEqual([c['role'] for c in self.me.notes[-1]['cards']], expected)
                self.assertTrue(all(not n['cards'] for n in self.players[2].notes))

    def test_single_wolf_peek_and_reset(self):
        self.deal(['werewolf','villager','seer'])
        self.act(self.me, mode='center', center=[2])
        self.assertEqual(self.me.notes[-1]['cards'], [dict(key='center:2', role='villager')])
        self.assertEqual(len({n['id'] for n in self.me.notes}), len(self.me.notes))
        self.game.command(self.room, self.me, 'reset', dict(stage=self.room.stage))
        self.assertEqual(self.game.view(self.room, self.me)['me']['notes'], [])


class MusicTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.app = create_app()
        self.app.testing = True
        self.app.config['MUSIC_DIR'] = str(self.root / 'music')
        self.folder = self.root / 'music'
        self.folder.mkdir()
        self.client = self.app.test_client()

    def test_missing_or_empty_folder_and_live_refresh(self):
        self.assertEqual(self.client.get('/api/music').json, dict(tracks=[]))
        self.folder.rmdir()
        self.assertEqual(self.client.get('/api/music').json, dict(tracks=[]))
        self.folder.mkdir()
        (self.folder / 'Ночь.MP3').write_bytes(b'fake music')
        tracks = self.client.get('/api/music').json['tracks']
        self.assertEqual(tracks[0]['file'], 'Ночь.MP3')
        (self.folder / 'Ночь.MP3').unlink()
        self.assertEqual(self.client.get('/api/music').json, dict(tracks=[]))

    def test_unicode_filename_mime_range_and_head(self):
        filename = '01 — Ночь #1 & друзья.MP3'
        data = bytes(range(256)) * 10
        (self.folder / filename).write_bytes(data)
        track = self.client.get('/api/music').json['tracks'][0]
        with self.client.get(track['url'], headers={'Range':'bytes=10-49'}) as response:
            self.assertEqual(response.status_code, 206)
            self.assertEqual(response.data, data[10:50])
            self.assertEqual(response.mimetype, 'audio/mpeg')
            self.assertEqual(response.headers['Content-Range'], 'bytes 10-49/2560')
        with self.client.head(track['url']) as response:
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.content_length, len(data))
        self.assertEqual(self.client.get(track['url'], headers={'Range':'bytes=9999-10000'}).status_code, 416)

    def test_other_media_extensions_and_non_media_hidden(self):
        for name in ['song.mp4','song.m4a','song.mp3','song.ogg','song.wav','song.webm','secret.txt','README.txt']:
            (self.folder / name).write_bytes(b'test')
        self.assertEqual(len(self.client.get('/api/music').json['tracks']), 6)
        self.assertEqual(self.client.get('/music/secret.txt').status_code, 404)
        with self.client.get('/music/song.mp4') as response:
            self.assertEqual(response.mimetype, 'video/mp4')

    def test_path_traversal_subfolders_and_symlinks_are_rejected(self):
        (self.root / 'outside.mp3').write_bytes(b'private')
        (self.folder / 'nested').mkdir()
        (self.folder / 'nested/song.mp3').write_bytes(b'nested')
        try:
            (self.folder / 'link.mp3').symlink_to(self.root / 'outside.mp3')
        except OSError:
            pass  # Windows can require developer mode for symlinks.
        self.assertEqual(self.client.get('/api/music').json['tracks'], [])
        for path in ['../outside.mp3', '..%2Foutside.mp3', '..%5Coutside.mp3', 'nested/song.mp3', 'link.mp3']:
            self.assertEqual(self.client.get('/music/' + path).status_code, 404)


if __name__ == '__main__':
    unittest.main()
