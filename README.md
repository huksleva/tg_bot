# Отрок Батракан

Личный Telegram-бот, верный слуга. Работает на Cloudflare Workers, бесплатно и без своего сервера.

## Что умеет
- 📝 **Заметки**: `/note текст`, `/notes`, удаление кнопками
- ⏰ **Напоминания**: `/remind 1h30m позвонить маме`, `/reminders`
- 🎲 **Развлечения**: кубик, монетка, дартс, `/random 1 100`
- 🔒 **Только для своих**: отвечает лишь ID из `ALLOWED_IDS` (если задан)

## Как устроено
- `src/index.ts` — точка входа: вебхук от Telegram, cron раз в минуту, `/setup`
- `src/bot.ts` — команды и кнопки
- `src/db.ts` — база D1 (таблицы создаются сами)
- `src/texts.ts` — все тексты бота
- `public/` — картинки, доступны по адресу Worker (`/welcome.png`)
- `design/` — аватарка и скрипт, которым нарисованы картинки

## Деплой
Репозиторий подключён к Worker `my-tg-bot` через Workers Builds:
**каждый push в `main` сам собирает и публикует бота.**

Секреты хранятся только в Cloudflare (Worker → Settings → Variables and Secrets):

| Имя | Что это |
|---|---|
| `BOT_TOKEN` | токен от @BotFather (секрет) |
| `WEBHOOK_SECRET` | пароль вебхука (секрет) |
| `ALLOWED_IDS` | необязательно: ID через запятую, свой ID покажет `/id` |
| `TZ` | необязательно: часовой пояс, по умолчанию `Europe/Moscow` |

После первого деплоя (и после смены токена/секрета) откройте один раз:
`https://my-tg-bot.leonid005xc.workers.dev/setup?secret=<WEBHOOK_SECRET>`
Это установит вебхук, меню команд и описание бота.

## Локально
```bash
npm install
npm run typecheck
npx wrangler dev
```
