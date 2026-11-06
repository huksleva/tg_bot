export interface Env {
  DB: D1Database;
  /** Секрет: токен от @BotFather */
  BOT_TOKEN: string;
  /** Секрет: пароль, который Telegram прикладывает к каждому запросу вебхука */
  WEBHOOK_SECRET: string;
  /** Необязательно: ID пользователей через запятую, кому бот отвечает. Пусто — всем. */
  ALLOWED_IDS?: string;
  /** Необязательно: часовой пояс для показа времени. По умолчанию Europe/Moscow. */
  TZ?: string;
  /** Адрес функции-посредника в Яндекс.Облаке (для прогноза транспорта) */
  RELAY_URL?: string;
  /** Секрет: пароль посредника */
  RELAY_SECRET?: string;
  /** Только для тестов: адрес Bot API */
  TELEGRAM_API?: string;
}
