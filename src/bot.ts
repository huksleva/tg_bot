import type { Env } from "./env";
import { Store } from "./db";
import { onHomeCallback, onScheduleCallback, showHome, showSchedule } from "./commute";
import { BTN, funKb, mainMenu, notesKb, remindersKb } from "./keyboards";
import { Telegram, escapeHtml, type CallbackQuery, type InlineKeyboard, type Message, type Update } from "./telegram";
import { HELP, UNKNOWN, WELCOME } from "./texts";
import { coin, formatTime, parseCommand, parseDuration, randInt } from "./utils";

/** Всё, что нужно обработчику: Telegram, база, настройки. */
export class Ctx {
  tg: Telegram;
  store: Store;
  tz: string;
  allowed: Set<number>;

  constructor(public env: Env, public origin: string) {
    this.tg = new Telegram(env);
    this.store = new Store(env.DB);
    this.tz = env.TZ || "Europe/Moscow";
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

  // Ждём текст заметки после кнопки «Новая заметка» или пустой /note
  if (!command && (await ctx.store.getState(userId)) === "note") {
    await ctx.store.setState(userId, null);
    const id = await ctx.store.addNote(userId, text);
    await ctx.tg.send(chatId, `Заметка #${id} записана`);
    return;
  }

  // Кнопки главного меню. Знаки перед словом отбрасываем, чтобы работали
  // и старые кнопки со смайликами, оставшиеся у пользователей в чате.
  switch (text.replace(/^[^\p{L}]+/u, "")) {
    case BTN.home: return showHome(ctx, chatId);
    case BTN.schedule: return showSchedule(ctx, chatId);
    case BTN.notes: return showNotes(ctx, chatId, userId);
    case BTN.reminders: return showReminders(ctx, chatId);
    case BTN.fun: return void (await ctx.tg.send(chatId, "Выбирай, господине:", funKb));
    case BTN.help: return void (await ctx.tg.send(chatId, HELP, mainMenu));
  }

  if (!command) return void (await ctx.tg.send(chatId, UNKNOWN));
  const { cmd, args } = command;

  switch (cmd) {
    case "home":
      return showHome(ctx, chatId);
    case "schedule":
      return showSchedule(ctx, chatId, args === "завтра" || args === "tomorrow" ? 1 : 0);
    case "start": {
      const name = escapeHtml(msg.from?.first_name ?? "господине");
      await ctx.tg.photo(chatId, `${ctx.origin}/welcome.png`, WELCOME(name), mainMenu);
      return;
    }
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

    case "note": {
      if (!args) {
        await ctx.store.setState(userId, "note");
        return void (await ctx.tg.send(chatId, "Молви, что записать (или /cancel):"));
      }
      const id = await ctx.store.addNote(userId, args);
      return void (await ctx.tg.send(chatId, `Заметка #${id} записана`));
    }
    case "notes":
      return showNotes(ctx, chatId, userId);

    case "remind": {
      const [dur, ...rest] = args.split(/\s+/);
      const seconds = dur ? parseDuration(dur) : null;
      const what = rest.join(" ").trim();
      if (!seconds || !what) {
        return void (await ctx.tg.send(
          chatId,
          "Формат: /remind 10m текст\nЕдиницы: s, m, h, d (например 1h30m)",
        ));
      }
      const fireAt = Math.floor(Date.now() / 1000) + seconds;
      const id = await ctx.store.addReminder(chatId, what, fireAt);
      return void (await ctx.tg.send(
        chatId,
        `Напоминание #${id} на ${formatTime(fireAt, ctx.tz)}\n<i>Напомню с точностью до минуты</i>`,
      ));
    }
    case "reminders":
      return showReminders(ctx, chatId);

    case "dice":
      return void (await ctx.tg.dice(chatId));
    case "coin":
      return void (await ctx.tg.send(chatId, coin()));
    case "random": {
      const nums = (args || "1 100").split(/\s+/).map(Number);
      if (nums.length !== 2 || nums.some((n) => !Number.isInteger(n))) {
        return void (await ctx.tg.send(chatId, "Формат: /random 1 100"));
      }
      const [lo, hi] = nums[0] <= nums[1] ? nums : [nums[1], nums[0]];
      return void (await ctx.tg.send(chatId, `Выпало: ${randInt(lo, hi)}`));
    }
  }

  await ctx.tg.send(chatId, UNKNOWN);
}

// ---------------- Списки ----------------

async function renderNotes(ctx: Ctx, userId: number): Promise<[string, InlineKeyboard]> {
  const notes = await ctx.store.listNotes(userId);
  if (!notes.length) return ["Заметок пока нет. Добавь: /note текст", notesKb([])];
  const lines = notes.map(
    (n) => `<b>#${n.id}</b> <i>${formatTime(n.created_at, ctx.tz)}</i>\n${escapeHtml(n.text)}`,
  );
  return ["<b>Твои заметки:</b>\n\n" + lines.join("\n\n"), notesKb(notes)];
}

async function showNotes(ctx: Ctx, chatId: number, userId: number) {
  const [text, kb] = await renderNotes(ctx, userId);
  await ctx.tg.send(chatId, text, kb);
}

async function renderReminders(ctx: Ctx, chatId: number): Promise<[string, InlineKeyboard | undefined]> {
  const rems = await ctx.store.listReminders(chatId);
  if (!rems.length) return ["Напоминаний нет. Создай: /remind 10m текст", undefined];
  const lines = rems.map(
    (r) => `<b>#${r.id}</b> ${formatTime(r.fire_at, ctx.tz)} — ${escapeHtml(r.text)}`,
  );
  return ["<b>Напоминания:</b>\n\n" + lines.join("\n"), remindersKb(rems)];
}

async function showReminders(ctx: Ctx, chatId: number) {
  const [text, kb] = await renderReminders(ctx, chatId);
  await ctx.tg.send(chatId, text, kb);
}

// ---------------- Кнопки под сообщениями ----------------

async function onCallback(ctx: Ctx, cb: CallbackQuery) {
  const data = cb.data ?? "";
  const msg = cb.message;
  const chatId = msg?.chat.id ?? cb.from.id;
  const userId = cb.from.id;

  if (data.startsWith("sched:")) {
    if (msg) await onScheduleCallback(ctx, data, chatId, msg.message_id, cb.id);
    else await ctx.tg.answer(cb.id);
    return;
  }

  if (data.startsWith("home:")) {
    if (msg) await onHomeCallback(ctx, data, chatId, msg.message_id, cb.id);
    else await ctx.tg.answer(cb.id);
    return;
  }

  if (data === "note_new") {
    await ctx.store.setState(userId, "note");
    await ctx.tg.answer(cb.id);
    await ctx.tg.send(chatId, "Молви, что записать (или /cancel):");
    return;
  }

  if (data.startsWith("note_del:")) {
    const ok = await ctx.store.deleteNote(userId, Number(data.split(":")[1]));
    await ctx.tg.answer(cb.id, ok ? "Удалено" : "Уже удалена");
    if (msg) {
      const [text, kb] = await renderNotes(ctx, userId);
      await ctx.tg.edit(chatId, msg.message_id, text, kb);
    }
    return;
  }

  if (data.startsWith("rem_del:")) {
    const ok = await ctx.store.deleteReminder(chatId, Number(data.split(":")[1]));
    await ctx.tg.answer(cb.id, ok ? "Отменено" : "Уже неактивно");
    if (msg) {
      const [text, kb] = await renderReminders(ctx, chatId);
      await ctx.tg.edit(chatId, msg.message_id, text, kb);
    }
    return;
  }

  if (data.startsWith("fun:")) {
    await ctx.tg.answer(cb.id);
    switch (data.slice(4)) {
      case "dice": await ctx.tg.dice(chatId, "🎲"); break;
      case "darts": await ctx.tg.dice(chatId, "🎯"); break;
      case "coin": await ctx.tg.send(chatId, coin()); break;
      case "num": await ctx.tg.send(chatId, `Выпало: ${randInt(1, 100)}`); break;
    }
    return;
  }

  await ctx.tg.answer(cb.id);
}

// ---------------- Напоминания по расписанию ----------------

export async function sendDueReminders(ctx: Ctx) {
  const due = await ctx.store.popDueReminders();
  for (const r of due) {
    try {
      await ctx.tg.send(r.chat_id, `<b>Напоминаю, господине:</b>\n${escapeHtml(r.text)}`);
    } catch (e) {
      console.error("Не удалось отправить напоминание", r.id, e);
    }
  }
  return due.length;
}
