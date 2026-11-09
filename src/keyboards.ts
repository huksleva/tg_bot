import type { ReplyKeyboard } from "./telegram";

export const BTN = {
  home: "Домой",
  uni: "В вуз",
  schedule: "Расписание",
  stops: "Остановки",
  help: "Помощь",
} as const;

export const mainMenu: ReplyKeyboard = {
  keyboard: [
    [{ text: BTN.home }, { text: BTN.uni }],
    [{ text: BTN.schedule }, { text: BTN.stops }],
    [{ text: BTN.help }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};
