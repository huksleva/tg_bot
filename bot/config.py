import os
from dataclasses import dataclass, field

from dotenv import load_dotenv

load_dotenv()


@dataclass(frozen=True)
class Config:
    token: str
    # ID пользователей, которым разрешено пользоваться ботом. Пусто — доступ у всех.
    allowed_ids: frozenset[int] = field(default_factory=frozenset)
    db_path: str = "bot.db"


def load_config() -> Config:
    token = os.getenv("BOT_TOKEN", "").strip()
    if not token:
        raise RuntimeError("Не задан BOT_TOKEN. Скопируй .env.example в .env и впиши токен от @BotFather.")

    raw_ids = os.getenv("ALLOWED_IDS", "")
    allowed = frozenset(int(x) for x in raw_ids.replace(" ", "").split(",") if x)

    return Config(
        token=token,
        allowed_ids=allowed,
        db_path=os.getenv("DB_PATH", "bot.db"),
    )
