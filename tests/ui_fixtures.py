"""Real server snapshots used by the optional browser regression tests."""
import json
from werewolf.game import GameService

game = GameService()
room, host = game.create('Аня')
players = [host]
for name in ['Борис', 'Вика', 'Глеб']:
    players.append(game.join(room.code, name)[1])
lobby = game.view(room, host)
room.round = 1
for p, role, target in zip(players, ['hunter', 'werewolf', 'tanner', 'villager'], [1, 0, 0, 2]):
    p.original = p.card = role
    p.vote = players[target].id
room.center = room.original_center = ['seer', 'robber', 'minion']
game.finish(room)
result = game.view(room, host)
print(json.dumps(dict(lobby=lobby, result=result)))
