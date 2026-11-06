import asyncio
import logging

from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.types import BotCommand

from bot.config import load_config
from bot.db import Database
from bot.handlers import get_routers
from bot.handlers.reminders import reminder_worker
from bot.middlewares import AccessMiddleware

COMMANDS = [
    BotCommand(command="start", description="Главное меню"),
    BotCommand(command="help", description="Что умеет бот"),
    BotCommand(command="note", description="Новая заметка"),
    BotCommand(command="notes", description="Мои заметки"),
    BotCommand(command="remind", description="Напомнить: /remind 10m текст"),
    BotCommand(command="reminders", description="Мои напоминания"),
    BotCommand(command="dice", description="Бросить кубик"),
    BotCommand(command="random", description="Случайное число"),
    BotCommand(command="id", description="Мой Telegram ID"),
]


async def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    config = load_config()

    db = Database(config.db_path)
    await db.connect()

    bot = Bot(config.token, default=DefaultBotProperties(parse_mode=ParseMode.HTML))
    dp = Dispatcher(db=db)  # db попадёт в хендлеры как аргумент

    access = AccessMiddleware(config.allowed_ids)
    dp.message.outer_middleware(access)
    dp.callback_query.outer_middleware(access)

    dp.include_routers(*get_routers())

    await bot.set_my_commands(COMMANDS)
    worker = asyncio.create_task(reminder_worker(bot, db))
    try:
        await bot.delete_webhook(drop_pending_updates=True)
        await dp.start_polling(bot)
    finally:
        worker.cancel()
        await db.close()
        await bot.session.close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
