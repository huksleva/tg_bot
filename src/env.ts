export interface Env {
  DB: D1Database;
  /** Секрет: токен от @BotFather */
  BOT_TOKEN: string;
  /** Секрет: пароль, который Telegram прикладывает к каждому запросу вебхука */
  WEBHOOK_SECRET: string;
  /** Необязательно: ID пользователей через запятую, кому бот отвечает. Пусто — всем. */
  ALLOWED_IDS?: string;
  /** Адрес функции-посредника в Яндекс.Облаке (для прогноза транспорта) */
  RELAY_URL?: string;
  /** Секрет: пароль посредника */
  RELAY_SECRET?: string;
  /** Необязательно: до какого часа (по Москве) робот TikTok должен отправить сообщение, по умолчанию 20 */
  TIKTOK_DEADLINE_HOUR?: string;
  /** Только для тестов: адрес Bot API */
  TELEGRAM_API?: string;
}
