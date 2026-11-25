import unittest
from werewolf.game import GameService


class ScoreTests(unittest.TestCase):
    def setUp(self):
        self.game = GameService()
        self.room, self.host = self.game.create('Аня')
        self.players = [self.host]
        for name in ['Борис', 'Вика', 'Глеб']:
            self.players.append(self.game.join(self.room.code, name)[1])

    def finish(self, roles, votes):
        self.room.round += 1
        self.room.phase = 'voting'
        for p, role, vote in zip(self.players, roles, votes):
            p.original = p.card = role
            p.vote = self.players[vote].id if vote is not None else None
        self.game.finish(self.room)
        return [p.round_points for p in self.players]

    def test_village_and_swapped_roles(self):
        self.assertEqual(self.finish(['werewolf', 'villager', 'hunter', 'minion'], [1,0,0,0]), [0,1,1,0])
        self.players[0].original = 'villager'
        self.players[1].original = 'werewolf'
        self.room.round += 1
        self.game.finish(self.room)
        self.assertEqual([p.score for p in self.players], [0,2,2,0])

    def test_wolves_and_minion(self):
        self.assertEqual(self.finish(['werewolf','minion','villager','seer'], [2,2,0,2]), [2,2,0,0])

    def test_tanner_only(self):
        self.assertEqual(self.finish(['werewolf','tanner','villager','minion'], [1,0,1,1]), [0,3,0,0])

    def test_joint_victory_and_hunter(self):
        self.assertEqual(self.finish(['hunter','werewolf','tanner','villager'], [1,0,0,2]), [1,0,0,1])
        result = self.room.result['players']
        self.assertTrue(result[0]['executed'])
        self.assertTrue(result[1]['hunter_victim'])
        self.assertTrue(result[1]['dead'])
        self.assertEqual(self.finish(['werewolf','tanner','villager','hunter'], [1,0,0,1]), [0,3,1,1])

    def test_no_winner_and_no_execution(self):
        self.assertEqual(self.finish(['villager','seer','hunter','robber'], [1,0,1,1]), [0,0,0,0])
        self.assertEqual(self.finish(['villager','seer','hunter','robber'], [1,2,3,0]), [1,1,1,1])

    def test_idempotent_reset_and_public_view(self):
        self.finish(['werewolf','minion','villager','seer'], [2,2,0,2])
        for p in self.players:
            self.game.finish(self.room)
            board = self.game.view(self.room, p)['scoreboard']
            self.assertEqual([r['score'] for r in board['players']], [2,2,0,0])
            self.assertTrue(all(set(r) == {'id','name','score','points'} for r in board['players']))
        self.game.command(self.room, self.host, 'reset', {'stage':self.room.stage})
        self.assertEqual([p.score for p in self.players], [2,2,0,0])
        newcomer = self.game.join(self.room.code, 'Новый')[1]
        self.assertEqual(newcomer.score, 0)
        self.game.command(self.room, self.host, 'reset', {'stage':self.room.stage})
        self.assertEqual(self.host.score, 2)

    def test_timeout_awards_once(self):
        for p, role in zip(self.players, ['werewolf','minion','villager','seer']):
            p.card = p.original = role
        self.room.phase = 'voting'
        self.room.round = 1
        self.room.deadline = 0
        for p in self.players:
            self.game.view(self.room, p)
        self.assertEqual([p.score for p in self.players], [2,2,0,0])
