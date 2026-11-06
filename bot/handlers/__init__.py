from aiogram import Router

from . import common, fun, notes, reminders


def get_routers() -> list[Router]:
    # common — последним, в нём обработчик «всего остального»
    return [notes.router, reminders.router, fun.router, common.router]
