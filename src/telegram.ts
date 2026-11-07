import type { Env } from "./env";

// --- Минимальные типы Telegram, только то, что используем ---
export interface User { id: number; first_name: string; username?: string }
export interface Chat { id: number }
export interface Message { message_id: number; from?: User; chat: Chat; text?: string }
export interface CallbackQuery { id: string; from: User; message?: Message; data?: string }
export interface Update { update_id: number; message?: Message; callback_query?: CallbackQuery }

export type Button = { text: string; callback_data: string } | { text: string; url: string };
export type InlineKeyboard = { inline_keyboard: Button[][] };
export type ReplyKeyboard = {
  keyboard: { text: string }[][];
  resize_keyboard?: boolean;
  is_persistent?: boolean;
};
export type Markup = InlineKeyboard | ReplyKeyboard;

export class Telegram {
  private base: string;

  constructor(env: Env) {
    this.base = `${env.TELEGRAM_API ?? "https://api.telegram.org"}/bot${env.BOT_TOKEN}`;
  }

  async call<T = unknown>(method: string, body: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(`${this.base}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as { ok: boolean; result: T; description?: string };
    if (!data.ok) throw new Error(`Telegram ${method}: ${data.description}`);
    return data.result;
  }

  send(chatId: number, text: string, markup?: Markup) {
    return this.call<Message>("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: markup,
    });
  }

  photo(chatId: number, photo: string, caption: string, markup?: Markup) {
    return this.call<Message>("sendPhoto", {
      chat_id: chatId,
      photo,
      caption,
      parse_mode: "HTML",
      reply_markup: markup,
    });
  }

  edit(chatId: number, messageId: number, text: string, markup?: InlineKeyboard) {
    return this.call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      reply_markup: markup,
    }).catch(() => undefined); // «message is not modified» и т.п. не страшны
  }

  answer(callbackId: string, text?: string) {
    return this.call("answerCallbackQuery", { callback_query_id: callbackId, text });
  }
}

export const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
