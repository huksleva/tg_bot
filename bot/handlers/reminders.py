import asyncio
import logging
import re
import time
from contextlib import suppress
from datetime import datetime
from html import escape

from aiogram import Bot, F, Router
from aiogram.exceptions import TelegramBadRequest
from aiogram.filters import Command, CommandObject
from aiogram.types import CallbackQuery, Message

from bot.db import Database
from bot.keyboards import BTN_REMINDERS, reminders_kb

router = Router(name="reminders")
log = logging.getLogger(__name__)

UNITS = {"s": 1, "m": 60, "h": 3600, "d": 86400}
DURATION_RE = re.compile(r"(\d+)([smhd])")


def parse_duration(raw: str) -> int | None:
    """'1h30m' -> 5400 секунд. None, если формат неверный."""
    raw = raw.lower()
    if not re.fullmatch(r"(\d+[smhd])+", raw):
        return None
    return sum(int(n) * UNITS[u] for n, u in DURATION_RE.findall(raw))


@router.message(Command("remind"))
async def cmd_remind(message: Message, command: CommandObject, db: Database) -> None:
    parts = (command.args or "").split(maxsplit=1)
    seconds = parse_duration(parts[0]) if parts else None
    if not seconds or len(parts) < 2:
        await message.answer("Формат: /remind 10m текст\nЕдиницы: s, m, h, d (например 1h30m)")
        return
    fire_at = int(time.time()) + seconds
    rem_id = await db.add_reminder(message.chat.id, parts[1], fire_at)
    when = datetime.fromtimestamp(fire_at).strftime("%d.%m %H:%M:%S")
    await message.answer(f"⏰ Напоминание #{rem_id} на {when}")


async def render_reminders(db: Database, chat_id: int):
    rems = await db.list_reminders(chat_id)
    if not rems:
        return "Активных напоминаний нет. Создай: /remind 10m текст", None
    lines = ["<b>⏰ Напоминания:</b>\n"]
    for r in rems:
        when = datetime.fromtimestamp(r["fire_at"]).strftime("%d.%m %H:%M")
        lines.append(f"<b>#{r['id']}</b> {when} — {escape(r['text'])}")
    return "\n".join(lines), reminders_kb(rems)


@router.message(Command("reminders"))
@router.message(F.text == BTN_REMINDERS)
async def cmd_reminders(message: Message, db: Database) -> None:
    text, kb = await render_reminders(db, message.chat.id)
    await message.answer(text, reply_markup=kb)


@router.callback_query(F.data.startswith("rem_del:"))
async def cb_rem_del(call: CallbackQuery, db: Database) -> None:
    rem_id = int(call.data.split(":")[1])
    ok = await db.delete_reminder(call.message.chat.id, rem_id)
    await call.answer("Отменено" if ok else "Уже неактивно")
    text, kb = await render_reminders(db, call.message.chat.id)
    with suppress(TelegramBadRequest):
        await call.message.edit_text(text, reply_markup=kb)


async def reminder_worker(bot: Bot, db: Database, interval: float = 5) -> None:
    """Фоновая задача: раз в несколько секунд отправляет наступившие напоминания."""
    while True:
        try:
            for r in await db.pop_due_reminders():
                await bot.send_message(r["chat_id"], f"🔔 Напоминание:\n{escape(r['text'])}")
        except Exception:
            log.exception("Ошибка в обработчике напоминаний")
        await asyncio.sleep(interval)
