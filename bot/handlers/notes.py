from contextlib import suppress
from datetime import datetime
from html import escape

from aiogram import F, Router
from aiogram.exceptions import TelegramBadRequest
from aiogram.filters import Command, CommandObject
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import CallbackQuery, Message

from bot.db import Database
from bot.keyboards import BTN_NOTES, notes_kb

router = Router(name="notes")


class NoteForm(StatesGroup):
    waiting_text = State()


async def render_notes(db: Database, user_id: int) -> tuple[str, object]:
    notes = await db.list_notes(user_id)
    if not notes:
        return "Заметок пока нет. Добавь: /note текст", notes_kb([])
    lines = ["<b>📝 Твои заметки:</b>\n"]
    for n in notes:
        date = datetime.fromtimestamp(n["created_at"]).strftime("%d.%m %H:%M")
        lines.append(f"<b>#{n['id']}</b> <i>{date}</i>\n{escape(n['text'])}\n")
    return "\n".join(lines), notes_kb(notes)


@router.message(Command("note"))
async def cmd_note(message: Message, command: CommandObject, db: Database, state: FSMContext) -> None:
    if not command.args:
        await state.set_state(NoteForm.waiting_text)
        await message.answer("Напиши текст заметки (или /cancel):")
        return
    note_id = await db.add_note(message.from_user.id, command.args)
    await message.answer(f"✅ Заметка #{note_id} сохранена")


@router.message(Command("cancel"))
async def cmd_cancel(message: Message, state: FSMContext) -> None:
    await state.clear()
    await message.answer("Отменено")


@router.message(NoteForm.waiting_text, F.text, ~F.text.startswith("/"))
async def note_text(message: Message, db: Database, state: FSMContext) -> None:
    await state.clear()
    note_id = await db.add_note(message.from_user.id, message.text)
    await message.answer(f"✅ Заметка #{note_id} сохранена")


@router.message(Command("notes"))
@router.message(F.text == BTN_NOTES)
async def cmd_notes(message: Message, db: Database) -> None:
    text, kb = await render_notes(db, message.from_user.id)
    await message.answer(text, reply_markup=kb)


@router.callback_query(F.data == "note_new")
async def cb_note_new(call: CallbackQuery, state: FSMContext) -> None:
    await state.set_state(NoteForm.waiting_text)
    await call.message.answer("Напиши текст заметки (или /cancel):")
    await call.answer()


@router.callback_query(F.data.startswith("note_del:"))
async def cb_note_del(call: CallbackQuery, db: Database) -> None:
    note_id = int(call.data.split(":")[1])
    ok = await db.delete_note(call.from_user.id, note_id)
    await call.answer("Удалено" if ok else "Уже удалена")
    text, kb = await render_notes(db, call.from_user.id)
    with suppress(TelegramBadRequest):  # текст не изменился
        await call.message.edit_text(text, reply_markup=kb)
