import type { ReplyKeyboard } from "./telegram";

export const BTN = {
  home: "Домой",
  uni: "В вуз",
  schedule: "Расписание",
  temperature: "Температура",
  help: "Помощь",
} as const;

export const mainMenu: ReplyKeyboard = {
  keyboard: [
    [{ text: BTN.home }, { text: BTN.uni }],
    [{ text: BTN.schedule }, { text: BTN.temperature }],
    [{ text: BTN.help }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};
