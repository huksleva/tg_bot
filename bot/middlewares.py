from typing import Any, Awaitable, Callable

from aiogram import BaseMiddleware
from aiogram.types import TelegramObject, User


class AccessMiddleware(BaseMiddleware):
    """Пропускает только пользователей из ALLOWED_IDS (если список задан)."""

    def __init__(self, allowed_ids: frozenset[int]):
        self.allowed_ids = allowed_ids

    async def __call__(
        self,
        handler: Callable[[TelegramObject, dict[str, Any]], Awaitable[Any]],
        event: TelegramObject,
        data: dict[str, Any],
    ) -> Any:
        user: User | None = data.get("event_from_user")
        if self.allowed_ids and (user is None or user.id not in self.allowed_ids):
            return None  # молча игнорируем чужих
        return await handler(event, data)
