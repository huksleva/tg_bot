from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup, KeyboardButton, ReplyKeyboardMarkup

BTN_NOTES = "📝 Заметки"
BTN_REMINDERS = "⏰ Напоминания"
BTN_FUN = "🎲 Развлечения"
BTN_HELP = "❓ Помощь"

main_menu = ReplyKeyboardMarkup(
    keyboard=[
        [KeyboardButton(text=BTN_NOTES), KeyboardButton(text=BTN_REMINDERS)],
        [KeyboardButton(text=BTN_FUN), KeyboardButton(text=BTN_HELP)],
    ],
    resize_keyboard=True,
)


def notes_kb(notes) -> InlineKeyboardMarkup:
    rows = [
        [InlineKeyboardButton(text=f"🗑 #{n['id']}", callback_data=f"note_del:{n['id']}")]
        for n in notes
    ]
    rows.append([InlineKeyboardButton(text="➕ Новая заметка", callback_data="note_new")])
    return InlineKeyboardMarkup(inline_keyboard=rows)


def reminders_kb(reminders) -> InlineKeyboardMarkup:
    rows = [
        [InlineKeyboardButton(text=f"❌ #{r['id']}", callback_data=f"rem_del:{r['id']}")]
        for r in reminders
    ]
    return InlineKeyboardMarkup(inline_keyboard=rows)


fun_kb = InlineKeyboardMarkup(
    inline_keyboard=[
        [
            InlineKeyboardButton(text="🎲 Кубик", callback_data="fun:dice"),
            InlineKeyboardButton(text="🪙 Монетка", callback_data="fun:coin"),
        ],
        [
            InlineKeyboardButton(text="🎯 Дартс", callback_data="fun:darts"),
            InlineKeyboardButton(text="🔢 Число 1–100", callback_data="fun:num"),
        ],
    ]
)
