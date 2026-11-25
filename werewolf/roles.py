"""Каталог ролей. Тексты интерфейса написаны для этой реализации."""

ROLES = {
    "werewolf": dict(name="Оборотень", icon="🐺", team="wolves", limit=2,
        description="Узнайте других оборотней. Если вы один, можно посмотреть одну карту центра."),
    "minion": dict(name="Приспешник", icon="🕯️", team="wolves", limit=1,
        description="Узнайте оборотней, но они не узнают вас. Помогите им избежать казни."),
    "mason": dict(name="Масон", icon="⚒️", team="village", limit=2,
        description="Узнайте второго масона. В колоду всегда добавляются оба масона."),
    "seer": dict(name="Провидица", icon="🔮", team="village", limit=1,
        description="Посмотрите карту одного другого игрока или две карты центра."),
    "robber": dict(name="Вор", icon="🗝️", team="village", limit=1,
        description="Можно обменять свою карту с другим игроком и посмотреть полученную роль."),
    "troublemaker": dict(name="Смутьян", icon="🎭", team="village", limit=1,
        description="Можно поменять карты двух других игроков, не подсматривая их."),
    "drunk": dict(name="Пьяница", icon="🍷", team="village", limit=1,
        description="Обязательно обменяйте свою карту с одной картой центра. Новую роль вы не узнаете."),
    "insomniac": dict(name="Бессонница", icon="👁️", team="village", limit=1,
        description="В конце ночи автоматически посмотрите свою текущую карту."),
    "hunter": dict(name="Охотник", icon="🏹", team="village", limit=1,
        description="Если вас казнят, игрок, против которого вы проголосовали, тоже погибнет."),
    "tanner": dict(name="Кожевник", icon="🧥", team="tanner", limit=1,
        description="Вы играете за себя. Побеждаете, только если погибнете в конце раунда."),
    "villager": dict(name="Мирный житель", icon="🏡", team="village", limit=3,
        description="Ночью вы спите. Днём сопоставляйте чужие рассказы и найдите оборотней."),
}

NIGHT_ORDER = ["werewolf", "minion", "mason", "seer", "robber",
               "troublemaker", "drunk", "insomniac"]


def default_deck(players):
    """Небольшой начальный набор, автоматически расширяющийся до 10 игроков."""
    base = ["werewolf", "werewolf", "seer", "robber", "troublemaker", "villager"]
    additions = ["villager", "villager", "insomniac", "drunk", "hunter", "minion", "tanner"]
    return base + additions[:max(0, players - 3)]


def role_name(role):
    return ROLES[role]["name"]
