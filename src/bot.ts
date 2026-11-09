import type { Env } from "./env";
import { Store } from "./db";
import { onHomeCallback, onScheduleCallback, onUniScreenCallback, showHome, showSchedule, showUniScreen } from "./commute";
import { BTN, mainMenu } from "./keyboards";
import { Telegram, escapeHtml, type CallbackQuery, type Message, type Update } from "./telegram";
import { DENIED, HELP, UNKNOWN, WELCOME } from "./texts";
import { parseCommand } from "./utils";

export const parseIds = (s: string | null | undefined) =>
  (s ?? "").split(",").map((x) => x.trim()).filter((x) => /^\d+$/.test(x)).map(Number);

// Список из базы кэшируем на минуту, чтобы не читать её на каждое сообщение
let accessCache: { ids: number[]; at: number } | null = null;
export const resetAccessCache = () => (accessCache = null);

/** Всё, что нужно обработчику: Telegram, база, настройки. */
export class Ctx {
  tg: Telegram;
  store: Store;
  allowed: Set<number>;

  constructor(public env: Env, public origin: string) {
    this.tg = new Telegram(env);
    this.store = new Store(env.DB);
    this.allowed = new Set(parseIds(env.ALLOWED_IDS));
  }

  /**
   * Кому можно пользоваться ботом: ALLOWED_IDS из настроек Cloudflare плюс список из базы
   * (его задаёт /setup?secret=...&owner=ID). Если никто не задан — нельзя никому.
   */
  async loadAccess() {
    if (!accessCache || Date.now() - accessCache.at > 60_000) {
      accessCache = { ids: parseIds(await this.store.getSetting("allowed_ids")), at: Date.now() };
    }
    accessCache.ids.forEach((id) => this.allowed.add(id));
    return this.allowed;
  }

  isAllowed(userId?: number) {
    return userId !== undefined && this.allowed.has(userId);
  }
}

export async function handleUpdate(ctx: Ctx, update: Update) {
  const userId = update.message?.from?.id ?? update.callback_query?.from.id;
  await ctx.loadAccess();
  if (!ctx.isAllowed(userId)) return deny(ctx, update);

  if (update.message) await onMessage(ctx, update.message);
  else if (update.callback_query) await onCallback(ctx, update.callback_query);
}

// ---------------- Чужие ----------------

const deniedAt = new Map<number, number>();
const DENY_EVERY = 6 * 3600; // отвечать одному человеку не чаще раза в 6 часов

/**
 * Чужим — короткий отказ и убрать клавиатуру. Не чаще раза в 6 часов на человека и только
 * в личке: спам не превращается в спам ответами, а в группах бот молчит.
 */
async function deny(ctx: Ctx, update: Update) {
  if (update.callback_query) {
    return void (await ctx.tg.answer(update.callback_query.id, "Прав на это у тебя нет.").catch(() => undefined));
  }
  const msg = update.message;
  if (!msg?.from || (msg.chat.type && msg.chat.type !== "private")) return;
  const uid = msg.from.id;
  const t = Math.floor(Date.now() / 1000);
  if (t - (deniedAt.get(uid) ?? 0) < DENY_EVERY) return;
  const key = `denied:${uid}`;
  if (t - Number((await ctx.store.getSetting(key)) ?? 0) < DENY_EVERY) {
    deniedAt.set(uid, t);
    return;
  }
  deniedAt.set(uid, t);
  await ctx.store.setSetting(key, String(t));
  console.log("Отказ чужому", uid);
  await ctx.tg.send(msg.chat.id, DENIED, { remove_keyboard: true }).catch(() => undefined);
}

// ---------------- Сообщения ----------------

async function onMessage(ctx: Ctx, msg: Message) {
  const text = msg.text?.trim();
  const chatId = msg.chat.id;
  const userId = msg.from?.id ?? chatId;
  if (!text) return;

  const command = parseCommand(text);

  // Знаки перед словом отбрасываем, чтобы работали и старые кнопки со смайликами
  const menuText = text.replace(/^[^\p{L}]+/u, "");
  const isMenu = (Object.values(BTN) as string[]).includes(menuText);

  // Пошагового ввода в боте больше нет — незаконченный ввод от старых версий просто сбрасываем
  if (await ctx.store.getState(userId)) await ctx.store.setState(userId, null);

  // Кнопки главного меню
  switch (menuText) {
    case BTN.home: return showHome(ctx, chatId);
    case BTN.uni: return showUniScreen(ctx, chatId);
    case BTN.schedule: return showSchedule(ctx, chatId);
    case BTN.help: return void (await ctx.tg.send(chatId, HELP, mainMenu));
  }

  // Непонятный текст — заодно присылаем актуальное меню (вдруг в чате висит старое)
  if (!command) return void (await ctx.tg.send(chatId, UNKNOWN, mainMenu));
  const { cmd, args } = command;

  switch (cmd) {
    case "start": {
      const name = escapeHtml(msg.from?.first_name ?? "господине");
      await ctx.tg.photo(chatId, `${ctx.origin}/welcome.png`, WELCOME(name), mainMenu);
      return;
    }
    case "home":
      return showHome(ctx, chatId);
    case "uni":
      return showUniScreen(ctx, chatId);
    case "schedule":
      return showSchedule(ctx, chatId, args === "завтра" || args === "tomorrow" ? 1 : 0);
    case "help":
      return void (await ctx.tg.send(chatId, HELP, mainMenu));
    case "id":
      return void (await ctx.tg.send(
        chatId,
        `Твой ID: <code>${userId}</code>\nID чата: <code>${chatId}</code>`,
      ));
  }

  await ctx.tg.send(chatId, UNKNOWN, mainMenu);
}

// ---------------- Кнопки под сообщениями ----------------

async function onCallback(ctx: Ctx, cb: CallbackQuery) {
  const data = cb.data ?? "";
  const msg = cb.message;
  const chatId = msg?.chat.id ?? cb.from.id;

  if (msg && data.startsWith("sched:")) {
    return onScheduleCallback(ctx, data, chatId, msg.message_id, cb.id);
  }
  if (msg && data.startsWith("uni:")) {
    return onUniScreenCallback(ctx, data, chatId, msg.message_id, cb.id);
  }
  if (msg && data.startsWith("home:")) {
    return onHomeCallback(ctx, data, chatId, msg.message_id, cb.id);
  }

  // Кнопки из старых сообщений (заметки, огонёк, остановки и т.п.) — просто закрываем «часики»
  await ctx.tg.answer(cb.id);
}
