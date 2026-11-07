import type { Ctx } from "./bot";
import { mskDate, mskTime } from "./schedule";
import type { InlineKeyboard } from "./telegram";

/**
 * Огонёк в TikTok: отсчёт до момента, когда он погаснет, и напоминания.
 *
 * Бот не видит TikTok (API нет), поэтому время последней отправки сообщает пользователь —
 * кнопкой «Отправил» или вручную. Считаем, что огонёк держится 24 часа после последнего
 * сообщения, и напоминаем за 2 часа и за 1 час до конца.
 */

const STREAK_HOURS = 24;
const WARN_HOURS = [2, 1]; // за сколько часов до конца напоминать

interface TiktokState {
  lastSent?: number; // когда пользователь последний раз отправил видео
  warned: number[]; // за сколько часов уже напомнили (для текущего lastSent)
  expiredNotified?: boolean; // сообщили, что огонёк, похоже, погас
  enabled: boolean;
}

const KEY = "tiktok:state";
const optoutKey = (chatId: number) => `tiktok:optout:${chatId}`;
const now = () => Math.floor(Date.now() / 1000);

async function load(ctx: Ctx): Promise<TiktokState> {
  const raw = await ctx.store.getSetting(KEY);
  const st = raw ? (JSON.parse(raw) as Partial<TiktokState>) : {};
  return { warned: [], enabled: true, ...st };
}

const save = (ctx: Ctx, st: TiktokState) => ctx.store.setSetting(KEY, JSON.stringify(st));

/** Кому слать напоминания: подписчики, а если их нет — ALLOWED_IDS. */
async function recipients(ctx: Ctx) {
  const subs = await ctx.store.listTiktokSubs();
  return subs.length ? subs : [...ctx.allowed];
}

// ---------------- Форматирование ----------------

/** «сегодня в 18:40», «завтра в 18:40», «08.11 в 18:40» (по Москве). */
function when(unix: number) {
  const d = mskDate(unix);
  const today = mskDate(now());
  const tomorrow = mskDate(now() + 86400);
  const yesterday = mskDate(now() - 86400);
  const day = d === today ? "сегодня" : d === tomorrow ? "завтра" : d === yesterday ? "вчера" : `${d.slice(8, 10)}.${d.slice(5, 7)}`;
  return `${day} в ${mskTime(unix)}`;
}

/** 5400 -> «1 ч 30 мин». */
function duration(sec: number) {
  const m = Math.max(0, Math.round(sec / 60));
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (!h) return `${rest} мин`;
  return rest ? `${h} ч ${rest} мин` : `${h} ч`;
}

const hoursWord = (h: number) => (h === 1 ? "час" : h < 5 ? `${h} часа` : `${h} часов`);

const doneKb: InlineKeyboard = { inline_keyboard: [[{ text: "Отправил", callback_data: "tiktok:done" }]] };

async function notify(ctx: Ctx, text: string) {
  for (const chatId of await recipients(ctx)) {
    await ctx.tg.send(chatId, text, doneKb).catch((e) => console.error("tiktok notify", chatId, e));
  }
}

// ---------------- Cron ----------------

/** Вызывается cron раз в минуту. */
export async function runTiktok(ctx: Ctx) {
  const st = await load(ctx);
  if (!st.enabled || !st.lastSent) return;
  const t = now();
  const deadline = st.lastSent + STREAK_HOURS * 3600;

  if (t >= deadline) {
    if (!st.expiredNotified) {
      st.expiredNotified = true;
      await save(ctx, st);
      await notify(
        ctx,
        `<b>Огонёк в TikTok, похоже, погас</b>: с последней отправки (${when(st.lastSent)}) прошло ${STREAK_HOURS} часа.\n` +
          "Если ты отправлял видео позже, нажми «Отправил».",
      );
    }
    return;
  }

  // Самое близкое из наступивших предупреждений; если пропустили несколько сразу — шлём одно
  const due = WARN_HOURS.filter((h) => t >= deadline - h * 3600 && !st.warned.includes(h));
  if (!due.length) return;
  const h = Math.min(...due);
  st.warned = [...new Set([...st.warned, ...WARN_HOURS.filter((x) => x >= h)])];
  await save(ctx, st);
  await notify(
    ctx,
    `<b>Огонёк в TikTok погаснет через ${hoursWord(h)}</b> (${when(deadline)}).\n` +
      "Отправь видео и нажми «Отправил».",
  );
}

// ---------------- Экран «Огонёк» ----------------

async function screen(ctx: Ctx, chatId: number) {
  const st = await load(ctx);
  const subscribed = await ctx.store.isTiktokSub(chatId);
  const t = now();
  let body: string;
  if (!st.lastSent) {
    body = "Когда отправишь видео, нажми «Отправил» — я начну отсчёт.";
  } else {
    const deadline = st.lastSent + STREAK_HOURS * 3600;
    body =
      `Последняя отправка: ${when(st.lastSent)}\n` +
      (t < deadline
        ? `Огонёк погаснет: ${when(deadline)}, через ${duration(deadline - t)}`
        : `Огонёк, похоже, погас ${when(deadline)}`);
  }
  const text =
    "<b>Огонёк в TikTok</b>\n\n" +
    `${body}\n\n` +
    `Считаю, что огонёк держится ${STREAK_HOURS} часа после отправки, и напоминаю за 2 часа и за 1 час до конца.\n` +
    (st.enabled ? "Напоминания <b>включены</b>" : "Напоминания <b>выключены</b>") +
    (st.enabled && !subscribed ? " (но в этот чат не приходят)" : "") +
    ".";
  const rows: InlineKeyboard["inline_keyboard"] = [
    [{ text: "Отправил", callback_data: "tiktok:done" }],
    [{ text: "Отправил раньше — указать время", callback_data: "tiktok:settime" }],
  ];
  if (st.enabled && !subscribed) rows.push([{ text: "Присылать сюда", callback_data: "tiktok:here" }]);
  rows.push([
    st.enabled
      ? { text: "Выключить напоминания", callback_data: "tiktok:off" }
      : { text: "Включить напоминания", callback_data: "tiktok:on" },
  ]);
  return { text, kb: { inline_keyboard: rows } };
}

export async function showTiktok(ctx: Ctx, chatId: number) {
  // Кто открыл экран, тому и напоминать (если сам не отказывался раньше)
  if (!(await ctx.store.isTiktokSub(chatId)) && (await ctx.store.getSetting(optoutKey(chatId))) !== "1") {
    await ctx.store.setTiktokSub(chatId, true);
  }
  const { text, kb } = await screen(ctx, chatId);
  await ctx.tg.send(chatId, text, kb);
}

/** Запомнить отправку и начать новый отсчёт. */
async function markSent(ctx: Ctx, at: number) {
  const st = await load(ctx);
  st.lastSent = at;
  st.warned = [];
  st.expiredNotified = false;
  // Если отправка была давно, уже наступившие предупреждения не шлём задним числом
  const deadline = at + STREAK_HOURS * 3600;
  st.warned = WARN_HOURS.filter((h) => now() >= deadline - h * 3600);
  await save(ctx, st);
  return deadline;
}

const sentText = (deadline: number) =>
  now() < deadline
    ? `Записал. Огонёк продержится до ${when(deadline)} (ещё ${duration(deadline - now())}). Напомню за 2 часа и за час.`
    : `Записал, но с той отправки уже прошло ${STREAK_HOURS} часа — огонёк, похоже, погас.`;

const ASK_TIME =
  "Во сколько ты отправил видео? Напиши время, например <code>15:30</code> (сегодня) или <code>вчера 22:10</code> (или /cancel).";

export async function onTiktokCallback(ctx: Ctx, data: string, chatId: number, userId: number, messageId: number, cbId: string) {
  const st = await load(ctx);
  switch (data) {
    case "tiktok:done": {
      const deadline = await markSent(ctx, now());
      await ctx.tg.answer(cbId, "Записал");
      await ctx.tg.edit(chatId, messageId, sentText(deadline));
      return;
    }
    case "tiktok:settime":
      await ctx.store.setState(userId, JSON.stringify({ f: "tt", field: "sent" }));
      await ctx.tg.answer(cbId);
      await ctx.tg.send(chatId, ASK_TIME);
      return;
    case "tiktok:on":
    case "tiktok:off":
      st.enabled = data === "tiktok:on";
      await save(ctx, st);
      if (st.enabled) {
        await ctx.store.setTiktokSub(chatId, true);
        await ctx.store.setSetting(optoutKey(chatId), "0");
      }
      await ctx.tg.answer(cbId, st.enabled ? "Буду напоминать" : "Не буду напоминать");
      break;
    case "tiktok:here":
      await ctx.store.setTiktokSub(chatId, true);
      await ctx.store.setSetting(optoutKey(chatId), "0");
      await ctx.tg.answer(cbId, "Буду присылать сюда");
      break;
    default:
      await ctx.tg.answer(cbId);
  }
  const { text, kb } = await screen(ctx, chatId);
  await ctx.tg.edit(chatId, messageId, text, kb);
}

/** «15:30», «вчера 22:10» -> unix (по Москве); null, если не разобрать. */
function parseSentTime(raw: string): number | null {
  const m = raw.trim().toLowerCase().match(/^(вчера|сегодня)?\s*(\d{1,2})[:.](\d{2})$/);
  if (!m) return null;
  const h = Number(m[2]);
  const min = Number(m[3]);
  if (h > 23 || min > 59) return null;
  const t = now();
  const [y, mo, d] = mskDate(t).split("-").map(Number);
  let at = Date.UTC(y, mo - 1, d, h, min) / 1000 - 3 * 3600;
  if (m[1] === "вчера" || (!m[1] && at > t)) at -= 86400; // время из будущего — значит, вчера
  return at > t ? null : at;
}

/** Ответ на вопрос «во сколько отправил». Возвращает true, если сообщение было таким ответом. */
export async function onTiktokInput(ctx: Ctx, chatId: number, userId: number, state: string, text: string) {
  let flow: { f?: string; field?: string };
  try {
    flow = JSON.parse(state);
  } catch {
    return false;
  }
  if (flow.f !== "tt") return false;
  const at = parseSentTime(text);
  if (at === null) {
    await ctx.tg.send(chatId, `Не разобрал время. ${ASK_TIME}`);
    return true;
  }
  await ctx.store.setState(userId, null);
  const deadline = await markSent(ctx, at);
  await ctx.tg.send(chatId, sentText(deadline));
  return true;
}
