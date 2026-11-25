"""Проверки правил и переходов без ожидания настоящих таймеров."""
from collections import Counter
import random
import unittest

from werewolf.game import GameService, Player, GameError, resolve_result
from werewolf.roles import default_deck, ROLES


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


class GameTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.game = GameService(self.clock, random.Random(42))
        self.room, self.host = self.game.create("Аня")
        self.players = [self.host]
        for name in ["Борис", "Вика"]:
            _, p = self.game.join(self.room.code, name)
            self.players.append(p)

    def command(self, p, action, **data):
        self.game.command(self.room, p, action, dict(stage=self.room.stage, **data))

    def deal(self, roles, center=None):
        center = center or ["villager"] * 3
        while len(self.players) < len(roles):
            _, p = self.game.join(self.room.code, f"Игрок {len(self.players)}")
            self.players.append(p)
        self.room.round = 1
        for p, role in zip(self.players, roles):
            p.card = p.original = role
        self.room.center = list(center)
        self.room.original_center = list(center)
        self.room.deck = roles + center
        from werewolf.roles import NIGHT_ORDER
        self.room.night_steps = [r for r in NIGHT_ORDER if r in self.room.deck]
        self.game.begin_night(self.room, self.clock())

    def advance(self):
        self.clock.now = self.room.deadline
        self.game.tick(self.room)

    def go_to(self, role):
        for _ in range(12):
            if self.room.night_role == role:
                return
            self.advance()
        self.fail(f"Не наступила очередь {role}")

    def test_default_decks_for_every_player_count(self):
        for size in range(3, 11):
            with self.subTest(size=size):
                deck = default_deck(size)
                self.game.validate_deck(deck, size)
                self.assertEqual(len(deck), size + 3)

    def test_start_and_ready_reveal(self):
        for p in self.players:
            self.command(p, "ready")
        self.command(self.host, "start")
        self.assertEqual(self.room.phase, "reveal")
        self.assertEqual(Counter(p.card for p in self.players) + Counter(self.room.center), Counter(self.room.deck))
        for p in self.players:
            self.command(p, "ready")
        self.assertEqual(self.room.phase, "night")

    def test_start_requires_all_ready(self):
        with self.assertRaises(GameError):
            self.command(self.host, "start")

    def test_role_limits_and_mason_pair(self):
        for deck in [["werewolf","seer","seer","villager","villager","villager"],
                     ["werewolf","mason","seer","robber","hunter","villager"],
                     ["villager"] * 6, ["werewolf"]]:
            with self.subTest(deck=deck), self.assertRaises(GameError):
                self.game.validate_deck(deck, 3)

    def test_custom_deck_size_after_player_joins(self):
        self.command(self.host, "settings", deck=list(self.room.deck))
        self.game.join(self.room.code, "Глеб")
        for p in self.room.players.values():
            self.command(p, "ready")
        with self.assertRaises(GameError):
            self.command(self.host, "start")

    def test_lone_wolf_sees_only_selected_center(self):
        self.deal(["werewolf","villager","seer"], ["robber","werewolf","drunk"])
        self.command(self.host,"night_action",mode="center",center=[1])
        self.assertIn("Оборотень", self.host.notes[-1]["text"])
        self.assertEqual(self.players[1].notes, [])
        self.assertIsNone(self.game.available_action(self.room,self.host))

    def test_two_wolves_cannot_look_at_center(self):
        self.deal(["werewolf","werewolf","seer"])
        self.assertIn(self.players[1].name,self.host.notes[-1]["text"])
        with self.assertRaises(GameError):
            self.command(self.host,"night_action",mode="center",center=[0])

    def test_minion_information_is_one_way(self):
        self.deal(["werewolf","minion","villager"])
        self.advance()
        self.assertIn(self.host.name,self.players[1].notes[-1]["text"])
        self.assertNotIn(self.players[1].name,str(self.host.notes))

    def test_masons_recognize_each_other(self):
        self.deal(["mason","mason","villager"])
        self.assertIn(self.players[1].name,self.host.notes[-1]["text"])

    def test_single_mason_knows_other_is_in_center(self):
        self.deal(["mason","villager","hunter"], ["mason","seer","werewolf"])
        self.go_to("mason")
        self.assertIn("в центре",self.host.notes[-1]["text"])

    def test_seer_player_and_cannot_repeat(self):
        self.deal(["seer","werewolf","robber"])
        self.go_to("seer")
        self.command(self.host,"night_action",mode="player",targets=[self.players[1].id])
        self.assertIn("Оборотень",self.host.notes[-1]["text"])
        with self.assertRaises(GameError):
            self.command(self.host,"night_action",mode="center",center=[0,1])

    def test_seer_center_and_no_duplicates(self):
        self.deal(["seer","villager","hunter"], ["werewolf","robber","drunk"])
        self.go_to("seer")
        with self.assertRaises(GameError):
            self.command(self.host,"night_action",mode="center",center=[0,0])
        self.command(self.host,"night_action",mode="center",center=[0,2])
        self.assertIn("Оборотень",self.host.notes[-1]["text"])
        self.assertIn("Пьяница",self.host.notes[-1]["text"])

    def test_robber_gains_card_but_not_night_action(self):
        self.deal(["robber","insomniac","werewolf"])
        self.go_to("robber")
        self.command(self.host,"night_action",mode="player",targets=[self.players[1].id])
        self.assertEqual(self.host.card,"insomniac")
        self.assertEqual(self.players[1].card,"robber")
        self.go_to("insomniac")
        self.assertIn("Вор",self.players[1].notes[-1]["text"])
        self.assertEqual(len(self.host.notes),1)

    def test_troublemaker_cannot_include_self_or_same_player(self):
        self.deal(["troublemaker","werewolf","seer"])
        self.go_to("troublemaker")
        for targets in [[self.host.id,self.players[1].id],[self.players[1].id]*2]:
            with self.assertRaises(GameError):
                self.command(self.host,"night_action",mode="players",targets=targets)
        self.command(self.host,"night_action",mode="players",targets=[p.id for p in self.players[1:]])
        self.assertEqual([p.card for p in self.players], ["troublemaker","seer","werewolf"])
        self.assertNotIn("Оборотень",self.host.notes[-1]["text"])

    def test_drunk_cannot_skip_and_cannot_see_new_card(self):
        self.deal(["drunk","villager","hunter"],["werewolf","seer","robber"])
        self.go_to("drunk")
        with self.assertRaises(GameError):
            self.command(self.host,"night_action",mode="skip")
        self.command(self.host,"night_action",mode="center",center=[0])
        self.assertEqual(self.host.card,"werewolf")
        self.assertEqual(self.room.center[0],"drunk")
        self.assertNotIn("Оборотень",str(self.host.notes))
        self.assertNotIn('card',self.game.view(self.room,self.host)['me'])

    def test_drunk_timeout_performs_exchange(self):
        self.deal(["drunk","villager","hunter"],["werewolf","seer","robber"])
        self.go_to("drunk")
        self.advance()
        self.assertIn("drunk",self.room.center)
        self.assertNotEqual(self.host.card,"drunk")

    def test_full_swap_order_and_insomniac(self):
        self.deal(["robber","troublemaker","drunk","insomniac","werewolf"], ["villager","seer","hunter"])
        self.go_to("robber")
        self.command(self.players[0],"night_action",mode="player",targets=[self.players[4].id])
        self.advance()
        self.command(self.players[1],"night_action",mode="players",targets=[self.players[0].id,self.players[3].id])
        self.advance()
        self.command(self.players[2],"night_action",mode="center",center=[0])
        self.advance()
        self.assertEqual([p.card for p in self.players], ["insomniac","troublemaker","villager","werewolf","robber"])
        self.assertIn("Оборотень",self.players[3].notes[-1]["text"])

    def test_absent_role_does_not_shorten_night(self):
        self.deal(["villager","villager","hunter"],["werewolf","seer","robber"])
        self.clock.now += self.room.settings["night_seconds"]-1
        self.game.tick(self.room)
        self.assertEqual(self.room.night_role,"werewolf")
        self.advance()
        self.assertEqual(self.room.night_role,"seer")

    def test_timeouts_work_without_active_connections(self):
        self.deal(["werewolf","seer","robber"])
        self.clock.now += 5000
        self.game.tick(self.room)
        self.assertEqual(self.room.phase,"results")
        self.assertEqual(self.room.result["teams"],["wolves"])

    def test_stale_stage_cannot_execute_next_action(self):
        self.deal(["werewolf","seer","robber"])
        old = self.room.stage
        self.advance()
        with self.assertRaises(GameError):
            self.game.command(self.room,self.players[1],"night_action",dict(stage=old,mode="player",targets=[self.host.id]))

    def test_host_privileges_and_transfer_after_disconnect(self):
        with self.assertRaises(GameError):
            self.command(self.players[1],"settings",automatic=True)
        with self.assertRaises(GameError):
            self.command(self.players[1],"claim_host")
        self.clock.now += 46
        self.command(self.players[1],"claim_host")
        self.assertEqual(self.room.host,self.players[1].id)

    def test_lobby_roster_and_settings_reset_readiness(self):
        self.command(self.host,"ready")
        self.game.join(self.room.code,"Глеб")
        self.assertFalse(self.host.ready)
        self.command(self.host,"ready")
        self.command(self.host,"settings",automatic=True,night_seconds=15)
        self.assertFalse(self.host.ready)

    def test_chat_limits_and_night_block(self):
        self.command(self.host,"chat",message="Привет!")
        with self.assertRaises(GameError):
            self.command(self.host,"chat",message="Спам")
        self.deal(["werewolf","seer","robber"])
        self.clock.now += 2
        with self.assertRaises(GameError):
            self.command(self.host,"chat",message="Я оборотень")

    def test_vote_is_final_secret_and_no_self_vote(self):
        self.deal(["werewolf","seer","robber"])
        self.room.phase,self.room.deadline = "voting", self.clock()+45
        with self.assertRaises(GameError):
            self.command(self.host,"vote",target=self.host.id)
        self.command(self.host,"vote",target=self.players[1].id)
        with self.assertRaises(GameError):
            self.command(self.host,"vote",target=self.players[2].id)
        view = self.game.view(self.room,self.players[1])
        self.assertEqual(view["voted_count"],1)
        self.assertNotIn("vote",view["players"][0])

    def test_reset_scrubs_private_state_and_preserves_members(self):
        self.deal(["werewolf","seer","robber"])
        self.command(self.host,"reset")
        self.assertEqual(len(self.room.players),3)
        self.assertEqual(self.room.phase,"lobby")
        self.assertFalse(self.room.center)
        self.assertTrue(all(p.card is None and not p.notes for p in self.players))

    def test_input_types_rejected_without_crashing(self):
        self.deal(["seer","werewolf","robber"])
        self.go_to("seer")
        for data in [dict(mode="player",targets=[{}]),dict(mode="center",center=[True,1]),dict(mode="center",center=[0,9]),dict(mode="player",targets=None)]:
            with self.subTest(data=data), self.assertRaises(GameError):
                self.command(self.host,"night_action",**data)

    def test_random_rounds_preserve_deck(self):
        rng = random.Random(123)
        for size in range(3,11):
            for iteration in range(12):
                g = GameService(self.clock,rng)
                room,p = g.create("P0")
                for i in range(1,size):
                    g.join(room.code,f"P{i}")
                for x in room.players.values():
                    x.ready=True
                g.command(room,p,"start",{})
                g.begin_night(room,self.clock())
                while room.phase=="night":
                    for x in room.players.values():
                        role=g.available_action(room,x)
                        others=[v for v in room.players if v!=x.id]
                        data=dict(stage=room.stage)
                        if role in ("werewolf","drunk"):
                            data.update(mode="center",center=[rng.randrange(3)])
                        elif role=="seer":
                            data.update(mode="center",center=rng.sample([0,1,2],2))
                        elif role=="robber":
                            data.update(mode="player",targets=[rng.choice(others)])
                        elif role=="troublemaker":
                            data.update(mode="players",targets=rng.sample(others,2))
                        if role:
                            g.command(room,x,"night_action",data)
                    self.clock.now=room.deadline
                    g.tick(room)
                self.assertEqual(Counter(x.card for x in room.players.values())+Counter(room.center),Counter(room.deck))
                room.phase="voting"
                for x in room.players.values():
                    g.command(room,x,"vote",dict(stage=room.stage,target=rng.choice([v for v in room.players if v!=x.id])))
                self.assertEqual(room.phase,"results")


class OutcomeTests(unittest.TestCase):
    def result(self, roles, votes):
        ps={str(i):Player(str(i),f"P{i}",f"token{i}",0,original=r,card=r,vote=None if v is None else str(v)) for i,(r,v) in enumerate(zip(roles,votes))}
        return resolve_result(ps,[],[],[])

    def test_wolf_executed_village_wins(self):
        self.assertEqual(self.result(["werewolf","seer","robber"],[1,0,0])["teams"],["village"])

    def test_no_wolf_executed_wolves_win(self):
        self.assertEqual(self.result(["werewolf","minion","seer"],[1,2,1])["teams"],["wolves"])

    def test_each_player_gets_one_vote(self):
        r=self.result(["werewolf","seer","robber"],[1,2,0])
        self.assertEqual(r["teams"],["wolves"])
        self.assertFalse(any(p["dead"] for p in r["players"]))

    def test_tied_leaders_all_die(self):
        r=self.result(["werewolf","villager","seer","robber"],[1,0,1,0])
        self.assertEqual([p["id"] for p in r["players"] if p["dead"]],["0","1"])
        self.assertEqual(r["teams"],["village"])

    def test_hunter_shoots_werewolf(self):
        r=self.result(["werewolf","hunter","seer"],[1,0,1])
        self.assertEqual(r["teams"],["village"])
        self.assertTrue(r["players"][0]["hunter_victim"])

    def test_tanner_only(self):
        self.assertEqual(self.result(["werewolf","tanner","seer"],[1,0,1])["teams"],["tanner"])

    def test_tanner_and_village_joint_win(self):
        self.assertEqual(self.result(["werewolf","tanner","seer","robber"],[1,0,0,1])["teams"],["village","tanner"])

    def test_tanner_killed_by_hunter(self):
        self.assertEqual(self.result(["hunter","tanner","werewolf"],[1,0,0])["teams"],["tanner"])

    def test_no_wolves_no_deaths_village_wins(self):
        self.assertEqual(self.result(["villager","seer","robber"],[1,2,0])["teams"],["village"])

    def test_no_wolves_villager_dies_everyone_loses(self):
        self.assertEqual(self.result(["villager","seer","robber"],[1,0,0])["teams"],[])

    def test_no_wolves_minion_survives(self):
        self.assertEqual(self.result(["minion","seer","robber"],[1,2,1])["teams"],["wolves"])

    def test_no_wolves_minion_dies(self):
        self.assertEqual(self.result(["minion","seer","robber"],[1,0,0])["teams"],["village"])

    def test_no_wolves_minion_and_villager_tie(self):
        self.assertEqual(self.result(["minion","seer","robber","villager"],[1,0,1,0])["teams"],["village"])

    def test_no_wolves_minion_no_deaths(self):
        self.assertEqual(self.result(["minion","seer","robber"],[1,2,0])["teams"],["village"])

    def test_no_wolves_tanner_blocks_minion(self):
        self.assertEqual(self.result(["minion","tanner","robber"],[1,0,1])["teams"],["tanner"])

    def test_timeout_abstentions_never_kill_with_one_vote(self):
        r=self.result(["hunter","seer","robber"],[1,None,None])
        self.assertFalse(any(p["dead"] for p in r["players"]))


if __name__ == "__main__":
    unittest.main()
