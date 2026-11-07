import type { Env } from "./env";
import { Store } from "./db";
import { onHomeCallback, onScheduleCallback, showHome, showSchedule } from "./commute";
import { onStopInput, onStopsCallback, showStops, startAdd, startDelete, startEdit } from "./stops";
import { BTN, mainMenu } from "./keyboards";
import { Telegram, escapeHtml, type CallbackQuery, type Message, type Update } from "./telegram";
import { HELP, UNKNOWN, WELCOME } from "./texts";
import { parseCommand } from "./utils";

/** Всё, что нужно обработчику: Telegram, база, настройки. */
export class Ctx {
  tg: Telegram;
  store: Store;
  allowed: Set<number>;

  constructor(public env: Env, public origin: string) {
    this.tg = new Telegram(env);
    this.store = new Store(env.DB);
    this.allowed = new Set(
      (env.ALLOWED_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean).map(Number),
    );
  }

  isAllowed(userId?: number) {
    return this.allowed.size === 0 || (userId !== undefined && this.allowed.has(userId));
  }
}

export async function handleUpdate(ctx: Ctx, update: Update) {
  const userId = update.message?.from?.id ?? update.callback_query?.from.id;
  if (!ctx.isAllowed(userId)) return; // чужих молча игнорируем

  if (update.message) await onMessage(ctx, update.message);
  else if (update.callback_query) await onCallback(ctx, update.callback_query);
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

  // Ответ на вопрос бота (данные остановки). Команды и кнопки меню ответом
  // не считаются — они прерывают ввод.
  const state = command || isMenu ? null : await ctx.store.getState(userId);
  if (state?.startsWith("{") && (await onStopInput(ctx, chatId, userId, state, text))) return;
  if (state) await ctx.store.setState(userId, null); // устаревшее состояние (например, от заметок)

  // Кнопки главного меню
  if (isMenu) await ctx.store.setState(userId, null);
  switch (menuText) {
    case BTN.home: return showHome(ctx, chatId);
    case BTN.schedule: return showSchedule(ctx, chatId);
    case BTN.stops: return showStops(ctx, chatId);
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
    case "schedule":
      return showSchedule(ctx, chatId, args === "завтра" || args === "tomorrow" ? 1 : 0);
    case "stops":
      return showStops(ctx, chatId);
    case "addstop":
      return startAdd(ctx, chatId);
    case "editstop":
      return startEdit(ctx, chatId, args || undefined);
    case "delstop":
      return startDelete(ctx, chatId, args || undefined);
    case "help":
      return void (await ctx.tg.send(chatId, HELP, mainMenu));
    case "id":
      return void (await ctx.tg.send(
        chatId,
        `Твой ID: <code>${userId}</code>\nID чата: <code>${chatId}</code>`,
      ));
    case "cancel":
      await ctx.store.setState(userId, null);
      return void (await ctx.tg.send(chatId, "Отменено"));
  }

  await ctx.tg.send(chatId, UNKNOWN, mainMenu);
}

// ---------------- Кнопки под сообщениями ----------------

async function onCallback(ctx: Ctx, cb: CallbackQuery) {
  const data = cb.data ?? "";
  const msg = cb.message;
  const chatId = msg?.chat.id ?? cb.from.id;
  const userId = cb.from.id;

  if (msg && data.startsWith("stops:")) {
    return onStopsCallback(ctx, data, chatId, userId, msg.message_id, cb.id);
  }
  if (msg && data.startsWith("sched:")) {
    return onScheduleCallback(ctx, data, chatId, msg.message_id, cb.id);
  }
  if (msg && data.startsWith("home:")) {
    return onHomeCallback(ctx, data, chatId, msg.message_id, cb.id);
  }

  // Кнопки из старых сообщений (заметки, огонёк и т.п.) — просто закрываем «часики»
  await ctx.tg.answer(cb.id);
}
