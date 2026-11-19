import type { Ctx } from "./bot";
import type { CommuteDirection } from "./db";
import type { InlineKeyboard } from "./telegram";
import { fetchDay, fetchLessons, humanDate, mskDate, mskHour, mskTime, mskToUnix } from "./schedule";
import { escapeHtml } from "./telegram";
import { compareOptions } from "./transport";
import { onUniCallback, showUni, uniRefreshKb, uniText } from "./journeys";

/** Настройки дороги домой. */
export const COMMUTE = {
  /** Группа на guide.herzen.spb.ru/schedule/<id> */
  groupId: 24432,
  /** Через сколько минут после конца последней пары присылать сообщение */
  offsetMin: 30,
  /** За сколько минут до начала первой пары присылать «В вуз» (выход из дома) */
  leaveBeforeMin: 57,
  /** С какого часа (по Москве) загружать расписание на сегодня */
  planFromHour: 6,
};

interface Plan {
  date: string;
  end: string | null; // конец последней пары; null — пар нет
  notifyAt: number | null; // когда прислать сообщение
  sent?: boolean;
  start?: string | null; // начало первой пары
  morningSent?: boolean;
}

const planKey = (date: string) => `commute:plan:${date}`;
const retryKey = "commute:retry_at";
const now = () => Math.floor(Date.now() / 1000);
const morningTime = (plan: Plan) =>
  plan.start ? mskToUnix(plan.date, plan.start) - COMMUTE.leaveBeforeMin * 60 : null;

async function loadPlan(ctx: Ctx, date: string): Promise<Plan | null> {
  const raw = await ctx.store.getSetting(planKey(date));
  return raw ? (JSON.parse(raw) as Plan) : null;
}

const savePlan = (ctx: Ctx, plan: Plan) => ctx.store.setSetting(planKey(plan.date), JSON.stringify(plan));

/** Загружает расписание и составляет план на дату. */
async function buildPlan(ctx: Ctx, date: string): Promise<Plan> {
  const day = await fetchDay(COMMUTE.groupId, date);
  const plan: Plan = day
    ? {
        date,
        end: day.end,
        notifyAt: mskToUnix(date, day.end) + COMMUTE.offsetMin * 60,
        start: day.start,
      }
    : { date, end: null, notifyAt: null, start: null };
  // Если план составлен уже после времени сообщения (например, бот задеплоен вечером) —
  // не присылаем задним числом
  if (plan.notifyAt && plan.notifyAt < now() - 30 * 60) plan.sent = true;
  const morningAt = morningTime(plan);
  if (morningAt !== null && morningAt < now() - 30 * 60) plan.morningSent = true;
  await savePlan(ctx, plan);
  return plan;
}

/** План на сегодня: из базы или свежий с сайта. */
export async function todayPlan(ctx: Ctx): Promise<Plan> {
  const date = mskDate(now());
  const plan = await loadPlan(ctx, date);
  return plan && plan.start !== undefined ? plan : buildPlan(ctx, date); // старый план без начала пар — пересобрать
}

/** Вызывается cron раз в минуту. */
export async function runCommute(ctx: Ctx) {
  const t = now();
  const date = mskDate(t);
  let plan = await loadPlan(ctx, date);
  if (plan && plan.start === undefined) plan = null; // план старого формата (без начала пар) — пересобрать

  if (!plan) {
    if (mskHour(t) < COMMUTE.planFromHour) return;
    // Если сайт не ответил — пробуем снова не чаще раза в 10 минут
    const retryAt = Number((await ctx.store.getSetting(retryKey)) ?? 0);
    if (t < retryAt) return;
    try {
      plan = await buildPlan(ctx, date);
      console.log(`План на ${date}: пары до ${plan.end ?? "—"}`);
    } catch (e) {
      console.error("Не удалось загрузить расписание", e);
      await ctx.store.setSetting(retryKey, String(t + 600));
      return;
    }
  }

  // Утром — «В вуз» за leaveBeforeMin до первой пары
  const morningAt = morningTime(plan);
  if (morningAt !== null && !plan.morningSent && t >= morningAt) {
    plan.morningSent = true;
    await savePlan(ctx, plan);
    await notifySubscribers(ctx, date, "uni", await ctx.store.listUniSubs(), uniRefreshKb, async () => {
      const body = await uniText(ctx).catch(() => "Прогноз транспорта сейчас недоступен.");
      return `<b>Первая пара в ${plan.start}. Пора выходить, господине.</b>\n\n${body}`;
    });
  }

  if (!plan.notifyAt || plan.sent || t < plan.notifyAt) return;

  plan.sent = true;
  await savePlan(ctx, plan); // сначала отмечаем, чтобы не прислать дважды
  const header = `Пары кончились в ${plan.end}. Пора домой, господине.`;
  await notifySubscribers(ctx, date, "home", await ctx.store.listCommuteSubs(), refreshKb,
    () => commuteMessage(ctx, header));
}

async function notifySubscribers(
  ctx: Ctx, date: string, direction: CommuteDirection, subscribers: number[], kb: InlineKeyboard,
  makeText: () => Promise<string>,
) {
  const allowed = await ctx.loadAccess();
  const pending: number[] = [];
  for (const chatId of subscribers) {
    if (allowed.has(chatId) && !(await ctx.store.hasCommuteView(chatId, direction, date))) pending.push(chatId);
  }
  if (!pending.length) return;
  const text = await makeText();
  for (const chatId of pending) {
    // Ручной запрос мог прийти, пока загружался прогноз. Запись также защищает от двух запусков cron.
    if (await ctx.store.recordCommuteView(chatId, direction, date)) {
      await ctx.tg.send(chatId, text, kb).catch((e) => console.error("commute send", direction, chatId, e));
    }
  }
}

/** Текст с прогнозом транспорта. */
export async function commuteMessage(ctx: Ctx, header: string, mode: "live" | "quick" = "live") {
  const forecast = await compareOptions(ctx, mode).catch((e) => {
    console.error("Прогноз транспорта", e);
    return "Прогноз транспорта сейчас недоступен.";
  });
  return `<b>${header}</b>\n\n${forecast}`;
}

const refreshKb: InlineKeyboard = {
  inline_keyboard: [[{ text: "Обновить прогноз", callback_data: "home:refresh" }]],
};

function homeKb(subscribed: boolean): InlineKeyboard {
  return {
    inline_keyboard: [
      [{ text: "Обновить прогноз", callback_data: "home:refresh" }],
      [{
        text: subscribed ? "Не присылать после пар" : "Присылать после пар",
        callback_data: subscribed ? "home:off" : "home:on",
      }],
    ],
  };
}

/** Текст ответа на кнопку «Домой» / команду /home. */
async function homeText(ctx: Ctx, chatId: number, mode: "live" | "quick" = "live") {
  const subscribed = await ctx.store.isCommuteSub(chatId);
  let planLine: string;
  try {
    const plan = await todayPlan(ctx);
    if (!plan.end) planLine = "Сегодня пар нет.";
    else if (plan.sent || await ctx.store.hasCommuteView(chatId, "home", plan.date)) {
      planLine = `Сегодня пары до ${plan.end}.`;
    } else {
      planLine = `Сегодня пары до ${plan.end}, напомню в ${mskTime(plan.notifyAt!)}.`;
    }
  } catch {
    planLine = "Расписание сейчас не загрузилось.";
  }
  const auto = subscribed
    ? `Сообщение через ${COMMUTE.offsetMin} мин после последней пары: <b>включено</b>.`
    : `Сообщение через ${COMMUTE.offsetMin} мин после последней пары: <b>выключено</b>.`;
  const body = await commuteMessage(ctx, "Дорога домой", mode);
  return { text: `${body}\n\n${planLine}\n${auto}`, kb: homeKb(subscribed) };
}

/**
 * Сначала мгновенный ответ (последний прогноз cron или оценка по расписанию),
 * потом то же сообщение обновляется свежим прогнозом с сайта транспорта.
 */
export async function showHome(ctx: Ctx, chatId: number) {
  await ctx.store.recordCommuteView(chatId, "home", mskDate(now()));
  const quick = await homeText(ctx, chatId, "quick");
  const sent = await ctx.tg.send(chatId, quick.text, quick.kb);
  const full = await homeText(ctx, chatId, "live");
  if (full.text !== quick.text) await ctx.tg.edit(chatId, sent.message_id, full.text, full.kb);
}

/** Кнопки под сообщением «Дорога домой». */
export async function onHomeCallback(ctx: Ctx, data: string, chatId: number, messageId: number, cbId: string) {
  if (data === "home:on") await ctx.store.setCommuteSub(chatId, true);
  if (data === "home:off") await ctx.store.setCommuteSub(chatId, false);
  if (data === "home:refresh") await ctx.store.recordCommuteView(chatId, "home", mskDate(now()));
  await ctx.tg.answer(
    cbId,
    data === "home:on" ? "Буду присылать" : data === "home:off" ? "Не буду присылать" : "Обновляю прогноз…",
  );
  // Сразу — то, что известно без запроса, потом — свежий прогноз
  const quick = await homeText(ctx, chatId, "quick");
  await ctx.tg.edit(chatId, messageId, quick.text, quick.kb);
  const full = await homeText(ctx, chatId, "live");
  if (full.text !== quick.text) await ctx.tg.edit(chatId, messageId, full.text, full.kb);
}

// ---------------- Расписание на день ----------------

const DAY = 86400;

function scheduleKb(offset: number): InlineKeyboard {
  return {
    inline_keyboard: [[
      { text: offset === 0 ? "· Сегодня ·" : "Сегодня", callback_data: "sched:0" },
      { text: offset === 1 ? "· Завтра ·" : "Завтра", callback_data: "sched:1" },
    ]],
  };
}

/** Текст расписания: offset 0 — сегодня, 1 — завтра. */
async function scheduleText(offset: number) {
  const date = mskDate(now() + offset * DAY);
  const title = `<b>${offset === 0 ? "Сегодня" : "Завтра"}, ${humanDate(date)}</b>`;
  let lessons;
  try {
    lessons = await fetchLessons(COMMUTE.groupId, date);
  } catch {
    return `${title}\n\nСайт расписания сейчас не отвечает, попробуй позже.`;
  }
  if (!lessons.length) return `${title}\n\nПар нет, отдыхай, господине.`;
  const lines = lessons.map((l) => {
    const head = `<b>${l.start}–${l.end}</b>  ${escapeHtml(l.name ?? "")}${l.type ? ` (${escapeHtml(l.type)})` : ""}`;
    const info = [l.room, l.teacher].filter(Boolean).map((s) => escapeHtml(s!)).join(", ");
    return info ? `${head}\n${info}` : head;
  });
  const last = lessons[lessons.length - 1];
  return `${title}\n\n${lines.join("\n\n")}\n\nПоследняя пара кончается в ${last.end}.`;
}

export async function showSchedule(ctx: Ctx, chatId: number, offset = 0) {
  await ctx.tg.send(chatId, await scheduleText(offset), scheduleKb(offset));
}

export async function onScheduleCallback(ctx: Ctx, data: string, chatId: number, messageId: number, cbId: string) {
  const offset = data === "sched:1" ? 1 : 0;
  await ctx.tg.answer(cbId);
  await ctx.tg.edit(chatId, messageId, await scheduleText(offset), scheduleKb(offset));
}

// ---------------- Дорога в вуз ----------------

async function uniPlanLine(ctx: Ctx, chatId: number) {
  try {
    const plan = await todayPlan(ctx);
    const morningAt = morningTime(plan);
    if (!plan.start || morningAt === null) return "Сегодня пар нет.";
    if (now() >= mskToUnix(plan.date, plan.start)) return `Сегодня первая пара была в ${plan.start}.`;
    if (plan.morningSent || await ctx.store.hasCommuteView(chatId, "uni", plan.date)) {
      return `Сегодня первая пара в ${plan.start}.`;
    }
    return `Сегодня первая пара в ${plan.start}, напомню в ${mskTime(morningAt)}.`;
  } catch {
    return "Расписание сейчас не загрузилось.";
  }
}

export async function showUniScreen(ctx: Ctx, chatId: number) {
  await ctx.store.recordCommuteView(chatId, "uni", mskDate(now()));
  await showUni(ctx, chatId, await uniPlanLine(ctx, chatId), COMMUTE.leaveBeforeMin);
}

export async function onUniScreenCallback(ctx: Ctx, data: string, chatId: number, messageId: number, cbId: string) {
  if (data === "uni:refresh") await ctx.store.recordCommuteView(chatId, "uni", mskDate(now()));
  await onUniCallback(ctx, data, chatId, messageId, cbId, await uniPlanLine(ctx, chatId), COMMUTE.leaveBeforeMin);
}
