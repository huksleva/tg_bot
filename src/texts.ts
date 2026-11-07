export const WELCOME = (name: string) =>
  `Здрав буди, ${name}!\n\n` +
  `Я — <b>Отрок Батракан</b>, твой верный слуга. Молви слово — исполню.\n\n` +
  `— Покажу расписание пар\n` +
  `— Подскажу, на чём быстрее доехать домой после пар\n` +
  `— Пришлю весть через 30 минут после последней пары\n` +
  `— Напомню про огонёк в TikTok\n\n` +
  `Повеление выбирай в меню ниже, а все мои умения — в /help.`;

export const HELP =
  "<b>Что я умею</b>\n\n" +
  "<b>Учёба</b>\n" +
  "/schedule — пары на сегодня (/schedule завтра — на завтра)\n\n" +
  "<b>Дорога домой</b>\n" +
  "/home — что приедет быстрее с твоих остановок\n" +
  "  (там же можно включить сообщение через 30 минут после пар)\n" +
  "/stops — список остановок\n" +
  "/addstop — добавить остановку\n" +
  "/editstop — изменить остановку\n" +
  "/delstop — удалить остановку\n\n" +
  "<b>Огонёк в TikTok</b>\n" +
  "/tiktok — сколько осталось до конца огонька; напомню за 2 часа и за час\n\n" +
  "/id — твой Telegram ID\n" +
  "/cancel — отменить ввод\n" +
  "/help — эта справка";

export const UNKNOWN = "Не уразумел я, господине. Глянь /help";

export const COMMANDS = [
  { command: "start", description: "Главное меню" },
  { command: "schedule", description: "Расписание пар на сегодня" },
  { command: "home", description: "Дорога домой: что приедет быстрее" },
  { command: "stops", description: "Мои остановки" },
  { command: "tiktok", description: "Огонёк в TikTok" },
  { command: "addstop", description: "Добавить остановку" },
  { command: "editstop", description: "Изменить остановку" },
  { command: "delstop", description: "Удалить остановку" },
  { command: "help", description: "Что умеет бот" },
  { command: "id", description: "Мой Telegram ID" },
];

export const SHORT_DESCRIPTION = "Отрок Батракан — верный слуга: расписание пар, дорога домой, огонёк в TikTok.";

export const DESCRIPTION =
  "Здрав буди! Я — Отрок Батракан, твой верный слуга.\n" +
  "Покажу расписание пар, подскажу, на чём быстрее доехать домой,\nи напомню про огонёк в TikTok.\n\n" +
  "Жми «Начать», господине.";
