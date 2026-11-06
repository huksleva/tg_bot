from aiogram import F, Router
from aiogram.filters import Command, CommandStart
from aiogram.types import Message

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


@router.message(CommandStart())
async def cmd_start(message: Message) -> None:
    name = message.from_user.first_name if message.from_user else "друг"
    await message.answer(
        f"Привет, {name}! 👋\nЯ твой личный бот. Выбирай раздел в меню ниже или жми /help.",
        reply_markup=main_menu,
    )


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
    await message.answer("Не понял команду 🤔 Посмотри /help")
