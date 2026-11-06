export const WELCOME = (name: string) =>
  `Здрав буди, ${name}!\n\n` +
  `Я — <b>Отрок Батракан</b>, твой верный слуга. Молви слово — исполню.\n\n` +
  `— Запишу, что велишь, дабы не забылось\n` +
  `— Напомню о деле в урочный час\n` +
  `— Жребий кину, коли сомневаешься\n\n` +
  `Повеление выбирай в меню ниже, а все мои умения — в /help.`;

export const HELP =
  "<b>Что я умею</b>\n\n" +
  "<b>Заметки</b>\n" +
  "/note текст — сохранить заметку\n" +
  "/notes — список заметок\n\n" +
  "<b>Напоминания</b>\n" +
  "/remind 10m купить хлеб — напомнить через 10 минут\n" +
  "  (единицы: s, m, h, d — можно вместе: 1h30m)\n" +
  "/reminders — активные напоминания\n\n" +
  "<b>Развлечения</b>\n" +
  "/dice, /coin, /random 1 100\n\n" +
  "/id — твой Telegram ID\n" +
  "/cancel — отменить ввод\n" +
  "/help — эта справка";

export const UNKNOWN = "Не уразумел я, господине. Глянь /help";

export const COMMANDS = [
  { command: "start", description: "Главное меню" },
  { command: "help", description: "Что умеет бот" },
  { command: "note", description: "Новая заметка" },
  { command: "notes", description: "Мои заметки" },
  { command: "remind", description: "Напомнить: /remind 10m текст" },
  { command: "reminders", description: "Мои напоминания" },
  { command: "dice", description: "Бросить кубик" },
  { command: "random", description: "Случайное число" },
  { command: "id", description: "Мой Telegram ID" },
];

export const SHORT_DESCRIPTION = "Отрок Батракан — верный слуга: заметки, напоминания, жребий.";

export const DESCRIPTION =
  "Здрав буди! Я — Отрок Батракан, твой верный слуга.\n" +
  "Запишу, что велишь, напомню в урочный час и жребий кину.\n\n" +
  "Жми «Начать», господине.";
