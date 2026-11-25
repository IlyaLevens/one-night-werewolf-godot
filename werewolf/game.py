"""Авторитетный игровой сервер. Все изменения выполняются под одной RLock.

Клиент получает только view(), а не Room.__dict__. Начальные роли определяют
ночные действия; текущие карты определяют команду и победу в конце раунда.
"""
from collections import Counter
from dataclasses import dataclass, field
from typing import Optional
import random
import secrets
import threading
import time

from .roles import ROLES, NIGHT_ORDER, default_deck, role_name
from .music import MusicState


class GameError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def require(condition, message, status=400):
    if not condition:
        raise GameError(message, status)


def clean_text(value, limit, label):
    require(isinstance(value, str), f"{label}: нужен текст.")
    value = " ".join(value.split())
    require(1 <= len(value) <= limit, f"{label}: от 1 до {limit} символов.")
    require(all(ord(c) >= 32 for c in value), "Недопустимые символы.")
    return value


@dataclass
class Player:
    id: str
    name: str
    token: str
    last_seen: float
    ready: bool = False
    original: Optional[str] = None
    card: Optional[str] = None
    notes: list = field(default_factory=list)
    vote: Optional[str] = None
    chat_at: float = -999
    score: int = 0
    round_points: int = 0


@dataclass
class Room:
    code: str
    host: str
    players: dict
    updated: float
    phase: str = "lobby"
    round: int = 0
    deck: list = field(default_factory=list)
    custom_deck: bool = False
    settings: dict = field(default_factory=lambda: dict(night_seconds=20, discussion_seconds=180, vote_seconds=45))
    center: list = field(default_factory=list)
    original_center: list = field(default_factory=list)
    night_steps: list = field(default_factory=list)
    night_index: int = -1
    deadline: Optional[float] = None
    acted: set = field(default_factory=set)
    chat: list = field(default_factory=list)
    history: list = field(default_factory=list)
    result: Optional[dict] = None
    scored_round: int = -1
    music: MusicState = field(default_factory=MusicState)

    @property
    def night_role(self):
        return self.night_steps[self.night_index] if self.phase == "night" else None

    @property
    def stage(self):
        return f"{self.round}:{self.phase}:{self.night_role or '-'}"


def resolve_result(players, center, original_center, history):
    """Единственное место подсчёта победы, включая ничьи, охотника и кожевника."""
    counts = Counter(p.vote for p in players.values() if p.vote is not None)
    maximum = max(counts.values(), default=0)
    executed = {pid for pid, count in counts.items() if count == maximum and maximum >= 2}
    dead = set(executed)
    hunter_victims = set()
    for pid in list(dead):
        p = players[pid]
        if p.card == "hunter" and p.vote is not None:
            dead.add(p.vote)
            hunter_victims.add(p.vote)
    wolves = {p.id for p in players.values() if p.card == "werewolf"}
    minions = {p.id for p in players.values() if p.card == "minion"}
    tanners = {p.id for p in players.values() if p.card == "tanner"}
    wolf_dead = bool(wolves & dead)
    tanner_won = bool(tanners & dead)
    village_won = wolf_dead or (not wolves and (not dead or bool(minions & dead)))
    if tanner_won and not wolf_dead:
        village_won = False
    wolves_won = (bool(wolves) and not wolf_dead) or (
        not wolves and bool(minions) and not bool(minions & dead) and bool(dead))
    wolves_won = wolves_won and not tanner_won
    teams = []
    if village_won:
        teams.append("village")
    if wolves_won:
        teams.append("wolves")
    if tanner_won:
        teams.append("tanner")
    reasons = []
    if wolf_dead:
        reasons.append("Хотя бы один оборотень погиб: деревня победила.")
    elif wolves_won and wolves:
        reasons.append("Ни один оборотень не погиб: команда оборотней победила.")
    elif wolves_won:
        reasons.append("Оборотней у игроков нет. Приспешник выжил, а другой игрок погиб.")
    elif village_won:
        reasons.append("Оборотней у игроков нет: никто не погиб либо был казнён приспешник.")
    if tanner_won:
        reasons.append("Кожевник погиб и выполнил своё условие победы.")
    if not teams:
        reasons.append("Оборотней у игроков нет, но погиб мирный игрок. Никто не победил.")
    if maximum < 2:
        reasons.insert(0, "Никто не получил хотя бы два голоса: казни нет.")
    return dict(teams=teams, reasons=reasons, players=[
        dict(id=p.id, name=p.name, original=p.original, role=p.card, vote=p.vote,
             votes=counts[p.id], dead=p.id in dead, executed=p.id in executed,
             hunter_victim=p.id in hunter_victims, won=ROLES[p.card]["team"] in teams)
        for p in players.values()], center=list(center), original_center=list(original_center),
        history=list(history))


class GameService:
    def __init__(self, clock=None, rng=None):
        self.rooms = {}
        self.lock = threading.RLock()
        self.clock = clock or time.time
        self.rng = rng or random.SystemRandom()
        self.music_tracks = lambda: []

    def cleanup(self):
        now = self.clock()
        for code, room in list(self.rooms.items()):
            if now - room.updated > 6 * 3600:
                del self.rooms[code]

    def create(self, name):
        self.cleanup()
        require(len(self.rooms) < 200, "Сервер заполнен. Попробуйте позже.", 503)
        name = clean_text(name, 24, "Имя")
        alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
        while True:
            code = "".join(secrets.choice(alphabet) for _ in range(6))
            if code not in self.rooms:
                break
        player = Player(secrets.token_urlsafe(8), name, secrets.token_urlsafe(32), self.clock())
        room = Room(code, player.id, {player.id: player}, self.clock())
        room.deck = default_deck(3)
        self.rooms[code] = room
        return room, player

    def get_room(self, code):
        room = self.rooms.get(str(code).upper())
        require(room is not None, "Лобби не найдено или сервер был перезапущен.", 404)
        self.tick(room)
        return room

    def join(self, code, name):
        room = self.get_room(code)
        require(room.phase == "lobby", "Раунд уже начался. Подождите следующего.", 409)
        require(len(room.players) < 10, "В лобби уже 10 игроков.", 409)
        name = clean_text(name, 24, "Имя")
        require(all(p.name.casefold() != name.casefold() for p in room.players.values()), "Это имя уже занято.")
        p = Player(secrets.token_urlsafe(8), name, secrets.token_urlsafe(32), self.clock())
        room.players[p.id] = p
        self.roster_changed(room)
        return room, p

    def authenticate(self, room, token):
        require(isinstance(token, str) and token.isascii() and 1 <= len(token) <= 100, "Сессия не найдена.", 401)
        p = next((p for p in room.players.values() if secrets.compare_digest(p.token, token)), None)
        require(p is not None, "Сессия не найдена. Вернитесь на главную или восстановите вход.", 401)
        p.last_seen = room.updated = self.clock()
        return p

    def roster_changed(self, room):
        if not room.custom_deck:
            room.deck = default_deck(max(3, len(room.players)))
        for p in room.players.values():
            p.ready = False
        room.updated = self.clock()

    def host_only(self, room, p):
        require(p.id == room.host, "Это действие доступно создателю лобби.", 403)

    def validate_deck(self, deck, size):
        require(isinstance(deck, list) and all(isinstance(r, str) and r in ROLES for r in deck), "Некорректные роли.")
        require(len(deck) == size + 3, f"Нужно ровно {size + 3} карт: игроки + 3 в центре.")
        c = Counter(deck)
        require(all(n <= ROLES[r]["limit"] for r, n in c.items()), "Превышено количество карт одной роли.")
        require(c["mason"] in (0, 2), "Масоны добавляются только парой.")
        require(c["werewolf"] >= 1, "Добавьте хотя бы одного оборотня.")

    def command(self, room, p, action, data):
        if action not in ("chat", "claim_host", "leave", "kick", "settings", "reset", "start", "music"):
            require(data.get("stage") == room.stage, "Фаза уже сменилась. Повторите действие.", 409)
        if action == "music":
            self.host_only(room, p)
            tracks, now = self.music_tracks(), self.clock()
            music = room.music
            music.synchronize(tracks, now)
            require(type(data.get('revision')) is int and data['revision'] == music.revision,
                    "Музыка уже изменилась. Повторите действие.", 409)
            operation = data.get('operation')
            require(operation in ('play', 'pause', 'select', 'next'), "Неизвестная команда плеера.")
            if operation in ('select', 'next'):
                require(bool(tracks), "Добавьте MP3-файлы в папку music.")
                if operation == 'select':
                    track = next((t for t in tracks if t['file'] == data.get('file')), None)
                    require(track is not None, "Музыкальный файл не найден.", 404)
                else:
                    index = next(i for i, t in enumerate(tracks) if t['file'] == music.file)
                    track = tracks[(index + 1) % len(tracks)]
                music.set_track(track, now)
            else:
                require(operation == 'pause' or bool(tracks), "Добавьте MP3-файлы в папку music.")
                music.position, music.changed_at = music.elapsed(now), now
                music.playing = operation == 'play'
                music.revision += 1
        elif action == "settings":
            self.host_only(room, p)
            require(room.phase == "lobby", "Настройки доступны только в лобби.", 409)
            settings = {}
            for key, low, high in [("night_seconds", 10, 60), ("discussion_seconds", 30, 900), ("vote_seconds", 15, 180)]:
                value = data.get(key, room.settings[key])
                require(type(value) is int and low <= value <= high, f"{key}: число от {low} до {high}.")
                settings[key] = value
            auto = data.get("automatic", False)
            require(type(auto) is bool, "Некорректный режим колоды.")
            deck = default_deck(max(3, len(room.players))) if auto else data.get("deck", room.deck)
            self.validate_deck(deck, max(3, len(room.players)))
            room.settings = settings
            room.deck = list(deck)
            room.custom_deck = not auto
            self.roster_changed(room)
        elif action == "ready":
            require(room.phase in ("lobby", "reveal"), "Сейчас нельзя подтвердить готовность.", 409)
            p.ready = not p.ready if room.phase == "lobby" else True
            if room.phase == "reveal" and all(x.ready for x in room.players.values()):
                self.begin_night(room, self.clock())
        elif action == "start":
            self.host_only(room, p)
            require(room.phase == "lobby", "Раунд уже начат.", 409)
            require(3 <= len(room.players) <= 10, "Нужно от 3 до 10 игроков.")
            require(all(x.ready for x in room.players.values()), "Дождитесь готовности всех игроков.")
            require(all(self.clock() - x.last_seen < 30 for x in room.players.values()), "Один из игроков потерял связь.")
            self.validate_deck(room.deck, len(room.players))
            cards = list(room.deck)
            self.rng.shuffle(cards)
            for x in room.players.values():
                x.card = x.original = cards.pop()
                x.notes, x.vote, x.ready = [], None, False
            room.center = cards
            room.original_center = list(cards)
            room.history, room.acted = [], set()
            room.result = None
            room.chat = []
            room.round += 1
            room.phase, room.deadline = "reveal", self.clock() + 90
            room.night_steps = [r for r in NIGHT_ORDER if r in room.deck]
            room.night_index = -1
        elif action == "night_action":
            self.night_action(room, p, data)
        elif action == "begin_vote":
            self.host_only(room, p)
            require(room.phase == "discussion", "Сейчас нет обсуждения.", 409)
            room.phase, room.deadline = "voting", self.clock() + room.settings["vote_seconds"]
        elif action == "vote":
            require(room.phase == "voting", "Голосование ещё не началось или уже завершилось.", 409)
            require(p.vote is None, "Вы уже проголосовали.", 409)
            target = data.get("target")
            require(isinstance(target, str) and target in room.players and target != p.id, "Выберите другого игрока.")
            p.vote = target
            if all(x.vote is not None for x in room.players.values()):
                self.finish(room)
        elif action == "chat":
            require(room.phase in ("lobby", "discussion", "results"), "В этой фазе чат закрыт.", 409)
            require(self.clock() - p.chat_at >= 0.7, "Подождите секунду перед следующим сообщением.", 429)
            message = clean_text(data.get("message"), 500, "Сообщение")
            p.chat_at = self.clock()
            room.chat.append(dict(id=secrets.token_hex(6), name=p.name, text=message))
            room.chat = room.chat[-100:]
        elif action == "reset":
            self.host_only(room, p)
            require(data.get("stage") == room.stage, "Фаза уже сменилась.", 409)
            room.phase, room.deadline, room.result = "lobby", None, None
            room.center, room.original_center, room.history, room.acted = [], [], [], set()
            room.night_steps, room.night_index = [], -1
            for x in room.players.values():
                x.card = x.original = x.vote = None
                x.notes = []
            self.roster_changed(room)
        elif action == "claim_host":
            owner = room.players[room.host]
            require(self.clock() - owner.last_seen >= 45, "Создатель лобби ещё в сети.", 409)
            room.host = p.id
        elif action in ("leave", "kick"):
            require(room.phase in ("lobby", "results"), "Во время раунда сначала дождитесь результата или отмените раунд.", 409)
            target = p.id
            if action == "kick":
                self.host_only(room, p)
                target = data.get("target")
                require(isinstance(target, str) and target in room.players and target != p.id, "Выберите другого игрока.")
            del room.players[target]
            if not room.players:
                del self.rooms[room.code]
                return
            if room.host == target:
                room.host = next(iter(room.players))
            self.roster_changed(room)
        else:
            raise GameError("Неизвестное действие.", 404)
        room.updated = self.clock()

    def begin_night(self, room, now):
        room.phase = "night"
        room.night_index = -1
        self.next_night(room, now)

    def next_night(self, room, now):
        room.night_index += 1
        room.acted = set()
        if room.night_index >= len(room.night_steps):
            room.phase = "discussion"
            room.deadline = now + room.settings["discussion_seconds"]
            return
        room.deadline = now + room.settings["night_seconds"]
        role = room.night_role
        wolves = [x for x in room.players.values() if x.original == "werewolf"]
        for p in room.players.values():
            if p.original != role:
                continue
            if role == "werewolf":
                peers = [x.name for x in wolves if x.id != p.id]
                self.note(room, p, "Другие оборотни: " + ", ".join(peers) if peers else "Вы единственный проснувшийся оборотень. Можно посмотреть одну карту центра.",
                          cards=[dict(key="player:" + x.id, role="werewolf") for x in wolves if x.id != p.id])
            elif role == "minion":
                self.note(room, p, "Оборотни: " + ", ".join(x.name for x in wolves) if wolves else "Среди игроков нет начальных оборотней.",
                          cards=[dict(key="player:" + x.id, role="werewolf") for x in wolves])
            elif role == "mason":
                peers = [x.name for x in room.players.values() if x.original == "mason" and x.id != p.id]
                self.note(room, p, "Другой масон: " + ", ".join(peers) if peers else "Второй масон находится в центре.",
                          cards=[dict(key="player:" + x.id, role="mason") for x in room.players.values() if x.original == "mason" and x.id != p.id])
            elif role == "insomniac":
                self.note(room, p, f"В конце ночи ваша карта: {role_name(p.card)}.",
                          cards=[dict(key="player:" + p.id, role=p.card)])

    def note(self, room, p, text, cards=None, swap=None):
        # Private immutable observations, NOT a live view of any player's current card.
        p.notes.append(dict(id=f"{room.round}:{len(p.notes)}", stage=room.stage,
                            role=room.night_role, text=text,
                            cards=list(cards or []), swap=list(swap or [])))
        room.history.append(dict(name=p.name, text=text))

    def available_action(self, room, p):
        if room.phase != "night" or p.original != room.night_role or p.id in room.acted:
            return None
        if p.original == "werewolf":
            if sum(x.original == "werewolf" for x in room.players.values()) != 1:
                return None
            return "werewolf"
        return p.original if p.original in ("seer", "robber", "troublemaker", "drunk") else None

    def night_action(self, room, p, data):
        role = self.available_action(room, p)
        require(role is not None, "Сейчас у вас нет доступного действия.", 409)
        mode = data.get("mode")
        if mode == "skip":
            require(role != "drunk", "Пьяница обязан обменять карту.")
            room.acted.add(p.id)
            self.note(room, p, "Вы пропустили ночное действие.")
            return
        targets = data.get("targets", [])
        center = data.get("center", [])
        require(isinstance(targets, list) and len(targets) <= 2 and all(isinstance(x, str) for x in targets), "Некорректные игроки.")
        require(len(set(targets)) == len(targets) and all(x in room.players and x != p.id for x in targets), "Нужны разные другие игроки.")
        require(isinstance(center, list) and len(center) <= 2 and all(type(i) is int and 0 <= i < 3 for i in center), "Некорректные карты центра.")
        require(len(set(center)) == len(center), "Карты центра должны быть разными.")
        cards, swap = [], []
        if role == "werewolf":
            require(mode == "center" and len(center) == 1 and not targets, "Выберите одну карту центра.")
            i = center[0]
            message = f"Центр {i + 1}: {role_name(room.center[i])}."
            cards = [dict(key=f"center:{i}", role=room.center[i])]
        elif role == "seer":
            require((mode == "player" and len(targets) == 1 and not center) or (mode == "center" and len(center) == 2 and not targets), "Выберите одного игрока или две карты центра.")
            if mode == "player":
                x = room.players[targets[0]]
                message = f"Карта игрока {x.name}: {role_name(x.card)}."
                cards = [dict(key="player:" + x.id, role=x.card)]
            else:
                message = "; ".join(f"Центр {i + 1}: {role_name(room.center[i])}" for i in center) + "."
                cards = [dict(key=f"center:{i}", role=room.center[i]) for i in center]
        elif role == "robber":
            require(mode == "player" and len(targets) == 1 and not center, "Выберите одного другого игрока.")
            x = room.players[targets[0]]
            p.card, x.card = x.card, p.card
            message = f"Обмен с {x.name}. Полученная карта: {role_name(p.card)}. Позже её ещё могут поменять."
            cards = [dict(key="player:" + p.id, role=p.card)]
            swap = ["player:" + p.id, "player:" + x.id]
        elif role == "troublemaker":
            require(mode == "players" and len(targets) == 2 and not center, "Выберите двух других игроков.")
            a, b = (room.players[x] for x in targets)
            a.card, b.card = b.card, a.card
            message = f"Вы поменяли карты {a.name} и {b.name}. Роли не раскрыты."
            swap = ["player:" + a.id, "player:" + b.id]
        else:
            require(mode == "center" and len(center) == 1 and not targets, "Выберите одну карту центра.")
            i = center[0]
            p.card, room.center[i] = room.center[i], p.card
            message = f"Вы обменяли свою карту с центром {i + 1}. Новая роль неизвестна."
            swap = ["player:" + p.id, f"center:{i}"]
        room.acted.add(p.id)
        self.note(room, p, message, cards=cards, swap=swap)

    def tick(self, room):
        now = self.clock()
        while room.deadline is not None and now >= room.deadline:
            boundary = room.deadline
            if room.phase == "reveal":
                self.begin_night(room, boundary)
            elif room.phase == "night":
                for p in room.players.values():
                    if self.available_action(room, p) == "drunk":
                        self.night_action(room, p, dict(mode="center", center=[self.rng.randrange(3)]))
                        self.note(room, p, "Время истекло: обязательный обмен выполнен сервером случайно.")
                    elif self.available_action(room, p):
                        self.note(room, p, "Время истекло: необязательное действие пропущено.")
                self.next_night(room, boundary)
            elif room.phase == "discussion":
                room.phase, room.deadline = "voting", boundary + room.settings["vote_seconds"]
            elif room.phase == "voting":
                self.finish(room)
            else:
                room.deadline = None

    def finish(self, room):
        if room.scored_round == room.round:
            return
        room.result = resolve_result(room.players, room.center, room.original_center, room.history)
        for outcome in room.result["players"]:
            player = room.players[outcome["id"]]
            team = ROLES[outcome["role"]]["team"]
            points = {"village": 1, "wolves": 2, "tanner": 3}[team] if outcome["won"] else 0
            player.round_points = points
            player.score += points
            outcome.update(points=points, score=player.score)
        room.scored_round = room.round
        room.phase, room.deadline = "results", None

    def view(self, room, p):
        self.tick(room)
        now = self.clock()
        # Никогда не включать card, token, чужие notes или закрытые vote в этот список.
        players = [dict(id=x.id, name=x.name, host=x.id == room.host,
                        online=now - x.last_seen < 20,
                        ready=x.ready if room.phase in ("lobby", "reveal") else False)
                   for x in room.players.values()]
        return dict(code=room.code, host=room.host, phase=room.phase, round=room.round,
                    stage=room.stage, server_time=now, deadline=room.deadline,
                    scoreboard=dict(round=max(0, room.scored_round), players=[
                        dict(id=x.id, name=x.name, score=x.score, points=x.round_points)
                        for x in room.players.values()]),
                    music=room.music.snapshot(self.music_tracks(), now),
                    night_role=room.night_role, night_steps=room.night_steps,
                    players=players, settings=dict(room.settings), deck=list(room.deck),
                    custom_deck=room.custom_deck, chat=list(room.chat),
                    voted_count=sum(x.vote is not None for x in room.players.values()),
                    can_claim_host=now - room.players[room.host].last_seen >= 45,
                    me=dict(id=p.id, name=p.name, original=p.original, notes=list(p.notes),
                            ready=p.ready, vote=p.vote, action=self.available_action(room, p),
                            action_done=p.id in room.acted),
                    result=room.result if room.phase == "results" else None)
