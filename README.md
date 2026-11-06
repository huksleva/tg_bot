# tg_bot
Многофункциональный телеграм бот на Python + aiogram 3.

## Возможности
- 📝 **Заметки** — `/note текст`, `/notes` (удаление кнопками)
- ⏰ **Напоминания** — `/remind 1h30m позвонить маме`, `/reminders`; хранятся в SQLite и переживают перезапуск
- 🎲 **Развлечения** — кубик, монетка, дартс, `/random 1 100`
- 🔒 **Личный доступ** — бот отвечает только ID из `ALLOWED_IDS`

## Запуск
1. Создай бота у [@BotFather](https://t.me/BotFather) и скопируй токен.
2. Установи зависимости:
   ```bash
   python -m venv .venv
   source .venv/bin/activate      # Windows: .venv\Scripts\activate
   pip install -r requirements.txt
   ```
3. Скопируй `.env.example` в `.env` и впиши `BOT_TOKEN`.
4. Запусти:
   ```bash
   python -m bot
   ```
5. Напиши боту `/id`, впиши свой ID в `ALLOWED_IDS` и перезапусти — теперь бот только твой.

## Структура
```
bot/
├── __main__.py      # точка входа
├── config.py        # настройки из .env
├── db.py            # SQLite
├── keyboards.py     # кнопки
├── middlewares.py   # ограничение доступа
└── handlers/        # по файлу на функцию
    ├── common.py    # /start, /help, /id
    ├── notes.py
    ├── reminders.py
    └── fun.py
```

Новая функция = новый файл в `handlers/` + строчка в `handlers/__init__.py`.
