import random

from aiogram import F, Router
from aiogram.filters import Command, CommandObject
from aiogram.types import CallbackQuery, Message

from bot.keyboards import BTN_FUN, fun_kb

router = Router(name="fun")


@router.message(F.text == BTN_FUN)
async def fun_menu(message: Message) -> None:
    await message.answer("Выбирай:", reply_markup=fun_kb)


@router.message(Command("dice"))
async def cmd_dice(message: Message) -> None:
    await message.answer_dice("🎲")


@router.message(Command("coin"))
async def cmd_coin(message: Message) -> None:
    await message.answer(random.choice(["🦅 Орёл", "🔘 Решка"]))


@router.message(Command("random"))
async def cmd_random(message: Message, command: CommandObject) -> None:
    try:
        lo, hi = map(int, (command.args or "1 100").split())
        if lo > hi:
            lo, hi = hi, lo
    except ValueError:
        await message.answer("Формат: /random 1 100")
        return
    await message.answer(f"🔢 {random.randint(lo, hi)}")


@router.callback_query(F.data.startswith("fun:"))
async def cb_fun(call: CallbackQuery) -> None:
    action = call.data.split(":")[1]
    if action == "dice":
        await call.message.answer_dice("🎲")
    elif action == "darts":
        await call.message.answer_dice("🎯")
    elif action == "coin":
        await call.message.answer(random.choice(["🦅 Орёл", "🔘 Решка"]))
    elif action == "num":
        await call.message.answer(f"🔢 {random.randint(1, 100)}")
    await call.answer()
