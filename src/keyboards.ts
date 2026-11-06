import type { InlineKeyboard, ReplyKeyboard } from "./telegram";
import type { Note, Reminder } from "./db";

export const BTN = {
  home: "Домой",
  schedule: "Расписание",
  stops: "Остановки",
  notes: "Заметки",
  reminders: "Напоминания",
  fun: "Развлечения",
  help: "Помощь",
} as const;

export const mainMenu: ReplyKeyboard = {
  keyboard: [
    [{ text: BTN.home }, { text: BTN.schedule }, { text: BTN.stops }],
    [{ text: BTN.notes }, { text: BTN.reminders }],
    [{ text: BTN.fun }, { text: BTN.help }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

export const notesKb = (notes: Note[]): InlineKeyboard => ({
  inline_keyboard: [
    ...notes.map((n) => [{ text: `Удалить #${n.id}`, callback_data: `note_del:${n.id}` }]),
    [{ text: "Новая заметка", callback_data: "note_new" }],
  ],
});

export const remindersKb = (rems: Reminder[]): InlineKeyboard => ({
  inline_keyboard: rems.map((r) => [{ text: `Отменить #${r.id}`, callback_data: `rem_del:${r.id}` }]),
});

export const funKb: InlineKeyboard = {
  inline_keyboard: [
    [
      { text: "Кубик", callback_data: "fun:dice" },
      { text: "Монетка", callback_data: "fun:coin" },
    ],
    [
      { text: "Дартс", callback_data: "fun:darts" },
      { text: "Число 1–100", callback_data: "fun:num" },
    ],
  ],
};
