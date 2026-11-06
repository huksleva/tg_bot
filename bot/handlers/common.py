from html import escape
from pathlib import Path

from aiogram import F, Router
from aiogram.filters import Command, CommandStart
from aiogram.types import FSInputFile, Message

from bot.keyboards import BTN_HELP, main_menu

router = Router(name="common")

HELP_TEXT = (
    "<b>Что я умею</b>\n\n"
    "📝 <b>Заметки</b>\n"
    "/note текст — сохранить заметку\n"
    "/notes — список заметок\n\n"
    "⏰ <b>Напоминания</b>\n"
    "/remind 10m купить хлеб — напомнить через 10 минут\n"
    "  (единицы: s, m, h, d — можно комбинировать: 1h30m)\n"
    "/reminders — активные напоминания\n\n"
    "🎲 <b>Развлечения</b>\n"
    "/dice, /coin, /random 1 100\n\n"
    "/id — показать твой Telegram ID\n"
    "/help — эта справка"
)


WELCOME_IMAGE = Path(__file__).resolve().parent.parent / "assets" / "welcome.png"
_welcome_file_id: str | None = None  # после первой отправки Telegram отдаёт id — шлём по нему

WELCOME_TEXT = (
    "Здрав буди, {name}! 🙇\n\n"
    "Я — <b>Отрок Батракан</b>, твой верный слуга. Молви слово — исполню.\n\n"
    "📝 Запишу, что велишь, дабы не забылось\n"
    "⏰ Напомню о деле в урочный час\n"
    "🎲 Жребий кину, коли сомневаешься\n\n"
    "Повеление выбирай в меню ниже, а все мои умения — в /help."
)


@router.message(CommandStart())
async def cmd_start(message: Message) -> None:
    global _welcome_file_id
    name = escape(message.from_user.first_name) if message.from_user else "господине"
    sent = await message.answer_photo(
        photo=_welcome_file_id or FSInputFile(WELCOME_IMAGE),
        caption=WELCOME_TEXT.format(name=name),
        reply_markup=main_menu,
    )
    _welcome_file_id = sent.photo[-1].file_id


@router.message(Command("help"))
@router.message(F.text == BTN_HELP)
async def cmd_help(message: Message) -> None:
    await message.answer(HELP_TEXT, reply_markup=main_menu)


@router.message(Command("id"))
async def cmd_id(message: Message) -> None:
    await message.answer(
        f"Твой ID: <code>{message.from_user.id}</code>\nID чата: <code>{message.chat.id}</code>"
    )


@router.message()
async def fallback(message: Message) -> None:
    await message.answer("Не уразумел я, господине 🤔 Глянь /help")
