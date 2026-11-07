import type { Ctx } from "./bot";
import { mskDate, mskTime } from "./schedule";
import { escapeHtml, type InlineKeyboard } from "./telegram";

/**
 * Огонёк в TikTok.
 *
 * Отправляет сообщение робот на компьютере пользователя (папка tiktok/, streak-saver):
 * у TikTok нет API для личных сообщений, а с серверов вход в TikTok блокируется.
 * После каждой попытки робот присылает отчёт: POST /tiktok/report (заголовок X-Report-Secret).
 * Бот напоминает отправить видео вручную, если робот сообщил об ошибке или если до
 * TIKTOK_DEADLINE_HOUR (по умолчанию 20:00 по Москве) успешного отчёта не было.
 */

interface DayState {
  ok?: number; // робот отправил
  manual?: number; // пользователь отметил, что отправил сам
  fail?: { at: number; reason: string; detail: string };
  reminded?: number; // напоминание отправлено
  followup?: boolean; // после напоминания робот всё-таки отправил — об этом сообщили
}

interface RobotInfo {
  at: number;
  status: "ok" | "fail";
  reason?: string;
  detail?: string;
  friends: string[];
  cookiesAgeDays?: number;
}

const ROBOT_KEY = "tiktok:robot";
const dayKey = (date: string) => `tiktok:day:${date}`;
const optoutKey = (chatId: number) => `tiktok:optout:${chatId}`;
const now = () => Math.floor(Date.now() / 1000);

const deadlineHour = (ctx: Ctx) => {
  const h = Number(ctx.env.TIKTOK_DEADLINE_HOUR ?? 20);
  return Number.isInteger(h) && h >= 0 && h <= 23 ? h : 20;
};

const REASONS: Record<string, string> = {
  login_required: "истёк вход в TikTok. На компьютере дважды щёлкни tiktok\\login.cmd и войди заново",
  send_failed: "сообщение не отправилось (TikTok мог изменить сайт, или неверный ник друга)",
  browser_error: "ошибка браузера-робота",
  timeout: "робот не уложился по времени",
  crash: "робот завершился с ошибкой",
  not_configured: "робот не настроен. Запусти на компьютере tiktok\\install.cmd",
  no_friends: "в роботе не указан друг. Запусти на компьютере tiktok\\install.cmd",
  unknown: "неизвестная ошибка",
};

const reasonText = (reason?: string) => REASONS[reason ?? ""] ?? REASONS.unknown;

// ---------------- Хранение ----------------

async function loadDay(ctx: Ctx, date: string): Promise<DayState> {
  const raw = await ctx.store.getSetting(dayKey(date));
  return raw ? (JSON.parse(raw) as DayState) : {};
}

const saveDay = (ctx: Ctx, date: string, st: DayState) => ctx.store.setSetting(dayKey(date), JSON.stringify(st));

async function loadRobot(ctx: Ctx): Promise<RobotInfo | null> {
  const raw = await ctx.store.getSetting(ROBOT_KEY);
  return raw ? (JSON.parse(raw) as RobotInfo) : null;
}

/** Кому слать напоминания: подписчики, а если их нет — ALLOWED_IDS. */
async function recipients(ctx: Ctx) {
  const subs = await ctx.store.listTiktokSubs();
  return subs.length ? subs : [...ctx.allowed];
}

// ---------------- Тексты и кнопки ----------------

const friendsText = (friends: string[]) => (friends.length ? friends.map((f) => `@${f}`).join(", ") : "другу");

const tiktokUrl = (friends: string[]) =>
  friends.length ? `https://www.tiktok.com/@${encodeURIComponent(friends[0])}` : "https://www.tiktok.com/";

const reminderKb = (friends: string[]): InlineKeyboard => ({
  inline_keyboard: [
    [{ text: friends.length ? "Открыть профиль друга в TikTok" : "Открыть TikTok", url: tiktokUrl(friends) }],
    [{ text: "Отправил вручную", callback_data: "tiktok:done" }],
  ],
});

async function remind(ctx: Ctx, why: string, friends: string[]) {
  const text =
    `<b>Огонёк в TikTok: нужна твоя помощь</b>\n\n${why}\n\n` +
    "Отправь видео вручную, чтобы огонёк не погас.";
  const chats = await recipients(ctx);
  if (!chats.length) console.warn("Огонёк: некому отправить напоминание (нет подписчиков и ALLOWED_IDS)");
  for (const chatId of chats) {
    await ctx.tg.send(chatId, text, reminderKb(friends)).catch((e) => console.error("tiktok remind", chatId, e));
  }
}

// ---------------- Отчёт робота ----------------

/** Обработка POST /tiktok/report. Возвращает объект для JSON-ответа. */
export async function handleTiktokReport(ctx: Ctx, body: unknown): Promise<{ ok: boolean; error?: string }> {
  const b = (body ?? {}) as Record<string, unknown>;
  if (b.status !== "ok" && b.status !== "fail") return { ok: false, error: "status must be ok|fail" };
  const friends = (Array.isArray(b.friends) ? b.friends : [])
    .map(String)
    .filter((f) => /^[A-Za-z0-9._]{1,30}$/.test(f))
    .slice(0, 5);
  const reason = typeof b.reason === "string" && /^[a-z_]{1,30}$/.test(b.reason) ? b.reason : undefined;
  const detail = typeof b.detail === "string" ? b.detail.slice(0, 300) : undefined;
  const age = Number(b.cookiesAgeDays);

  const t = now();
  const robot: RobotInfo = {
    at: t,
    status: b.status,
    reason,
    detail,
    friends,
    cookiesAgeDays: Number.isFinite(age) && age >= 0 ? Math.round(age) : undefined,
  };
  await ctx.store.setSetting(ROBOT_KEY, JSON.stringify(robot));

  const date = mskDate(t);
  const st = await loadDay(ctx, date);
  if (b.status === "ok") {
    if (!st.ok) st.ok = t;
    if (st.reminded && !st.manual && !st.followup) {
      st.followup = true;
      for (const chatId of await recipients(ctx)) {
        await ctx.tg
          .send(chatId, `Робот всё-таки отправил сообщение ${escapeHtml(friendsText(friends))} в ${mskTime(t)}, вручную можно не отправлять.`)
          .catch((e) => console.error("tiktok followup", chatId, e));
      }
    }
  } else {
    st.fail = { at: t, reason: reason ?? "unknown", detail: detail ?? "" };
    if (!st.ok && !st.manual && !st.reminded) {
      st.reminded = t;
      await remind(ctx, `Робот не смог отправить сообщение ${escapeHtml(friendsText(friends))}: ${escapeHtml(reasonText(reason))}.`, friends);
    }
  }
  await saveDay(ctx, date, st);
  return { ok: true };
}

// ---------------- Cron: напоминание, если робот молчит ----------------

let checkedDate = "";

/** Вызывается cron раз в минуту. */
export async function runTiktok(ctx: Ctx) {
  const t = now();
  const date = mskDate(t);
  if (checkedDate === date) return;
  const hour = new Date((t + 3 * 3600) * 1000).getUTCHours();
  if (hour < deadlineHour(ctx)) return;

  const robot = await loadRobot(ctx);
  if (!robot) return; // робот ещё ни разу не отчитывался — значит, не установлен
  const st = await loadDay(ctx, date);
  if (!st.ok && !st.manual && !st.reminded) {
    st.reminded = t;
    await saveDay(ctx, date, st);
    await remind(
      ctx,
      `До ${deadlineHour(ctx)}:00 робот не отчитался об отправке ${escapeHtml(friendsText(robot.friends))}, возможно, компьютер был выключен.`,
      robot.friends,
    );
  }
  checkedDate = date;
}

// ---------------- Экран «Огонёк» ----------------

function ddmm(unix: number) {
  const [, m, d] = mskDate(unix).split("-");
  return `${d}.${m}`;
}

async function statusText(ctx: Ctx, chatId: number) {
  const t = now();
  const robot = await loadRobot(ctx);
  const st = await loadDay(ctx, mskDate(t));
  const subscribed = await ctx.store.isTiktokSub(chatId);
  const dl = deadlineHour(ctx);

  const friends = robot?.friends ?? [];
  let today: string;
  if (st.ok) today = `отправлено роботом в ${mskTime(st.ok)}`;
  else if (st.manual) today = `ты отметил, что отправил вручную (${mskTime(st.manual)})`;
  else if (st.fail) today = `робот не смог в ${mskTime(st.fail.at)}: ${escapeHtml(reasonText(st.fail.reason))}`;
  else if (!robot) today = "робот не установлен";
  else today = new Date((t + 3 * 3600) * 1000).getUTCHours() < dl ? "пока не отправлено, робот попробует" : "не отправлено";

  let robotLine: string;
  if (!robot) {
    robotLine = "ещё не отчитывался. Установи его на компьютере: двойной щелчок по tiktok\\install.cmd";
  } else {
    robotLine = `последний отчёт ${ddmm(robot.at)} в ${mskTime(robot.at)}`;
    if (robot.cookiesAgeDays !== undefined) robotLine += `, вход в TikTok обновлялся ${robot.cookiesAgeDays} дн. назад`;
  }

  const text =
    "<b>Огонёк в TikTok</b>\n\n" +
    `Друг: ${friends.length ? escapeHtml(friendsText(friends)) : "пока неизвестен"}\n` +
    `Сегодня: ${today}\n` +
    `Робот: ${robotLine}\n\n` +
    `Если робот сообщит об ошибке или не отправит до ${dl}:00, я пришлю напоминание.\n` +
    `Напоминания: <b>${subscribed ? "включены" : "выключены"}</b>.`;

  const rows: InlineKeyboard["inline_keyboard"] = [
    [{ text: friends.length ? "Открыть профиль друга в TikTok" : "Открыть TikTok", url: tiktokUrl(friends) }],
  ];
  if (!st.ok && !st.manual) rows.push([{ text: "Отправил вручную", callback_data: "tiktok:done" }]);
  rows.push([
    { text: "Обновить", callback_data: "tiktok:refresh" },
    subscribed
      ? { text: "Не напоминать", callback_data: "tiktok:off" }
      : { text: "Напоминать", callback_data: "tiktok:on" },
  ]);
  return { text, kb: { inline_keyboard: rows } };
}

export async function showTiktok(ctx: Ctx, chatId: number) {
  // Первый, кто открыл экран, подписывается на напоминания сам (если не отказывался раньше)
  if (!(await ctx.store.isTiktokSub(chatId)) && (await ctx.store.getSetting(optoutKey(chatId))) !== "1") {
    await ctx.store.setTiktokSub(chatId, true);
  }
  const { text, kb } = await statusText(ctx, chatId);
  await ctx.tg.send(chatId, text, kb);
}

export async function onTiktokCallback(ctx: Ctx, data: string, chatId: number, messageId: number, cbId: string) {
  let note: string | undefined;
  if (data === "tiktok:done") {
    const date = mskDate(now());
    const st = await loadDay(ctx, date);
    if (!st.manual) st.manual = now();
    await saveDay(ctx, date, st);
    note = "Отмечено, спасибо";
  } else if (data === "tiktok:on") {
    await ctx.store.setTiktokSub(chatId, true);
    await ctx.store.setSetting(optoutKey(chatId), "0");
    note = "Буду напоминать";
  } else if (data === "tiktok:off") {
    await ctx.store.setTiktokSub(chatId, false);
    await ctx.store.setSetting(optoutKey(chatId), "1");
    note = "Не буду напоминать";
  }
  await ctx.tg.answer(cbId, note);
  const { text, kb } = await statusText(ctx, chatId);
  await ctx.tg.edit(chatId, messageId, text, kb);
}
