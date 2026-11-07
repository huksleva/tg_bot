import type { ReplyKeyboard } from "./telegram";

export const BTN = {
  home: "Домой",
  schedule: "Расписание",
  stops: "Остановки",
  help: "Помощь",
} as const;

export const mainMenu: ReplyKeyboard = {
  keyboard: [
    [{ text: BTN.home }, { text: BTN.schedule }],
    [{ text: BTN.stops }, { text: BTN.help }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};
