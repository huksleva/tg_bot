import type { Ctx } from "./bot";
import { mskDate, mskTime } from "./schedule";
import { escapeHtml, type InlineKeyboard } from "./telegram";

/**
 * Огонёк в TikTok — напоминания, всё настраивается в чате с ботом.
 *
 * Отправить сообщение от имени пользователя TikTok сторонним программам не даёт (нет API,
 * вход с серверов блокируется), поэтому бот напоминает отправить видео: в заданное время
 * и ещё раз позже, если пользователь не нажал «Отправил».
 */

interface TiktokConfig {
  friend?: string; // username друга без @
  time: string; // «19:00» — первое напоминание (по Москве)
  second: string | null; // «22:30» — повторное, если не нажал «Отправил»
  enabled: boolean;
}

interface DayState {
  done?: number; // нажал «Отправил»
  first?: number; // первое напоминание отправлено
  second?: number; // повторное отправлено
}

const DEFAULT_CONFIG: TiktokConfig = { time: "19:00", second: "22:30", enabled: true };
const CONFIG_KEY = "tiktok:config";
const dayKey = (date: string) => `tiktok:day:${date}`;
const optoutKey = (chatId: number) => `tiktok:optout:${chatId}`;
const now = () => Math.floor(Date.now() / 1000);

// ---------------- Хранение ----------------

async function loadConfig(ctx: Ctx): Promise<TiktokConfig> {
  const raw = await ctx.store.getSetting(CONFIG_KEY);
  return raw ? { ...DEFAULT_CONFIG, ...(JSON.parse(raw) as Partial<TiktokConfig>) } : { ...DEFAULT_CONFIG };
}

const saveConfig = (ctx: Ctx, cfg: TiktokConfig) => ctx.store.setSetting(CONFIG_KEY, JSON.stringify(cfg));

async function loadDay(ctx: Ctx, date: string): Promise<DayState> {
  const raw = await ctx.store.getSetting(dayKey(date));
  return raw ? (JSON.parse(raw) as DayState) : {};
}

const saveDay = (ctx: Ctx, date: string, st: DayState) => ctx.store.setSetting(dayKey(date), JSON.stringify(st));

/** Кому слать напоминания: подписчики, а если их нет — ALLOWED_IDS. */
async function recipients(ctx: Ctx) {
  const subs = await ctx.store.listTiktokSubs();
  return subs.length ? subs : [...ctx.allowed];
}

// ---------------- Время ----------------

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

const mskMinutes = (unix: number) => {
  const d = new Date((unix + 3 * 3600) * 1000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};

/** «19:00», «9.30», «19» -> «19:00»; null, если не время. */
function parseTime(raw: string): string | null {
  const m = raw.trim().match(/^(\d{1,2})(?:[:.](\d{2}))?$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

// ---------------- Тексты и кнопки ----------------

const friendTag = (cfg: TiktokConfig) => (cfg.friend ? `@${cfg.friend}` : "другу");

const profileButton = (cfg: TiktokConfig) =>
  cfg.friend
    ? { text: `Открыть профиль @${cfg.friend} в TikTok`, url: `https://www.tiktok.com/@${encodeURIComponent(cfg.friend)}` }
    : { text: "Открыть TikTok", url: "https://www.tiktok.com/" };

const reminderKb = (cfg: TiktokConfig): InlineKeyboard => ({
  inline_keyboard: [[profileButton(cfg)], [{ text: "Отправил", callback_data: "tiktok:done" }]],
});

async function sendReminder(ctx: Ctx, cfg: TiktokConfig, last: boolean) {
  const text = last
    ? `<b>Огонёк в TikTok: последнее напоминание</b>\n\nСегодня ты ещё не отметил, что отправил видео ${escapeHtml(friendTag(cfg))}. ` +
      "Отправь до полуночи, чтобы огонёк не погас."
    : `<b>Огонёк в TikTok</b>\n\nНе забудь отправить видео ${escapeHtml(friendTag(cfg))}, чтобы огонёк не погас.`;
  for (const chatId of await recipients(ctx)) {
    await ctx.tg.send(chatId, text, reminderKb(cfg)).catch((e) => console.error("tiktok remind", chatId, e));
  }
}

// ---------------- Cron ----------------

let doneDate = ""; // день, на который уже всё сделано (кэш, чтобы не читать базу каждую минуту)

/** Вызывается cron раз в минуту. */
export async function runTiktok(ctx: Ctx) {
  const t = now();
  const date = mskDate(t);
  if (doneDate === date) return;
  const cfg = await loadConfig(ctx);
  if (!cfg.enabled || !cfg.friend) return;
  const nowMin = mskMinutes(t);
  if (nowMin < toMin(cfg.time)) return;

  const st = await loadDay(ctx, date);
  if (st.done) {
    doneDate = date;
    return;
  }
  if (!st.first) {
    st.first = t;
    await saveDay(ctx, date, st);
    await sendReminder(ctx, cfg, false);
  } else if (cfg.second && !st.second && nowMin >= toMin(cfg.second) && toMin(cfg.second) > toMin(cfg.time)) {
    st.second = t;
    await saveDay(ctx, date, st);
    await sendReminder(ctx, cfg, true);
  }
  if (st.second || !cfg.second || toMin(cfg.second) <= toMin(cfg.time)) doneDate = date;
}

// ---------------- Экран «Огонёк» ----------------

async function screen(ctx: Ctx, chatId: number) {
  const t = now();
  const cfg = await loadConfig(ctx);
  const st = await loadDay(ctx, mskDate(t));
  const subscribed = await ctx.store.isTiktokSub(chatId);

  let today: string;
  if (st.done) today = `отправлено в ${mskTime(st.done)}`;
  else if (!cfg.friend) today = "напоминаний нет, пока не указан друг";
  else if (!cfg.enabled) today = "напоминания выключены";
  else if (mskMinutes(t) < toMin(cfg.time)) today = `напомню в ${cfg.time}`;
  else today = "ещё не отправлено";

  const when = cfg.second && toMin(cfg.second) > toMin(cfg.time)
    ? `в ${cfg.time}, повторно в ${cfg.second}, если не нажмёшь «Отправил»`
    : `в ${cfg.time}`;

  const text =
    "<b>Огонёк в TikTok</b>\n\n" +
    `Друг: ${cfg.friend ? `@${escapeHtml(cfg.friend)}` : "не указан"}\n` +
    `Напоминание: ${when}\n` +
    `Сегодня: ${today}\n\n` +
    (cfg.enabled ? "Напоминания <b>включены</b>" : "Напоминания <b>выключены</b>") +
    (cfg.enabled && !subscribed ? " (но в этот чат не приходят, нажми «Присылать сюда»)" : "") +
    ".";

  const rows: InlineKeyboard["inline_keyboard"] = [];
  if (cfg.friend) rows.push([profileButton(cfg)]);
  if (cfg.friend && !st.done) rows.push([{ text: "Отправил", callback_data: "tiktok:done" }]);
  rows.push([
    { text: cfg.friend ? "Сменить друга" : "Указать друга", callback_data: "tiktok:friend" },
    { text: "Сменить время", callback_data: "tiktok:time" },
  ]);
  if (cfg.enabled && !subscribed) rows.push([{ text: "Присылать сюда", callback_data: "tiktok:here" }]);
  rows.push([
    cfg.enabled
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

const ASK_FRIEND = "Напиши ник друга в TikTok: username из его профиля, можно с @ (или /cancel).";
const ASK_TIME =
  "Во сколько напоминать? Например <code>19:00</code>.\n" +
  "Можно два времени через пробел, второе — повторное, если не нажмёшь «Отправил»: <code>19:00 22:30</code> (или /cancel).";

export async function onTiktokCallback(ctx: Ctx, data: string, chatId: number, userId: number, messageId: number, cbId: string) {
  const cfg = await loadConfig(ctx);
  switch (data) {
    case "tiktok:done": {
      const date = mskDate(now());
      const st = await loadDay(ctx, date);
      if (!st.done) st.done = now();
      await saveDay(ctx, date, st);
      await ctx.tg.answer(cbId, "Отмечено");
      // Если нажали в напоминании — превращаем его в подтверждение
      await ctx.tg.edit(chatId, messageId, `Огонёк с ${escapeHtml(friendTag(cfg))} на сегодня поддержан. До завтра!`);
      return;
    }
    case "tiktok:friend":
      await ctx.store.setState(userId, JSON.stringify({ f: "tt", field: "friend" }));
      await ctx.tg.answer(cbId);
      await ctx.tg.send(chatId, ASK_FRIEND);
      return;
    case "tiktok:time":
      await ctx.store.setState(userId, JSON.stringify({ f: "tt", field: "time" }));
      await ctx.tg.answer(cbId);
      await ctx.tg.send(chatId, ASK_TIME);
      return;
    case "tiktok:on":
    case "tiktok:off":
      cfg.enabled = data === "tiktok:on";
      await saveConfig(ctx, cfg);
      if (cfg.enabled) {
        await ctx.store.setTiktokSub(chatId, true);
        await ctx.store.setSetting(optoutKey(chatId), "0");
      }
      doneDate = "";
      await ctx.tg.answer(cbId, cfg.enabled ? "Буду напоминать" : "Не буду напоминать");
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

/** Ответ на вопрос «ник друга» / «время». Возвращает true, если сообщение было таким ответом. */
export async function onTiktokInput(ctx: Ctx, chatId: number, userId: number, state: string, text: string) {
  let flow: { f?: string; field?: string };
  try {
    flow = JSON.parse(state);
  } catch {
    return false;
  }
  if (flow.f !== "tt") return false;
  const cfg = await loadConfig(ctx);

  if (flow.field === "friend") {
    // Ник целиком («@best_friend») или ссылка на профиль («https://www.tiktok.com/@best_friend?lang=ru»)
    const raw = text.trim();
    const link = raw.match(/^https?:\/\/(?:www\.|m\.)?tiktok\.com\/@([^/?#\s]+)/i);
    const name = link ? link[1] : raw.replace(/^@/, "");
    if (!/^[A-Za-z0-9._]{2,24}$/.test(name)) {
      await ctx.tg.send(chatId, `Не похоже на ник TikTok. ${ASK_FRIEND}`);
      return true;
    }
    cfg.friend = name.toLowerCase();
  } else {
    const parts = text.trim().split(/[\s,;]+/).filter(Boolean);
    const times = parts.map(parseTime);
    if (!parts.length || parts.length > 2 || times.some((x) => !x)) {
      await ctx.tg.send(chatId, `Не разобрал время. ${ASK_TIME}`);
      return true;
    }
    if (times[1] && toMin(times[1]) <= toMin(times[0]!)) {
      await ctx.tg.send(chatId, `Повторное напоминание должно быть позже первого. ${ASK_TIME}`);
      return true;
    }
    cfg.time = times[0]!;
    cfg.second = times[1] ?? null;
  }
  await saveConfig(ctx, cfg);
  await ctx.store.setState(userId, null);
  doneDate = "";
  await ctx.tg.send(chatId, "Сохранено.");
  await showTiktok(ctx, chatId);
  return true;
}
