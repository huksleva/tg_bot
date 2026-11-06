import type { Ctx } from "./bot";
import type { InlineKeyboard } from "./telegram";
import { fetchDay, fetchLessons, humanDate, mskDate, mskHour, mskTime, mskToUnix } from "./schedule";
import { escapeHtml } from "./telegram";
import { compareOptions } from "./transport";

/** Настройки дороги домой. */
export const COMMUTE = {
  /** Группа на guide.herzen.spb.ru/schedule/<id> */
  groupId: 24432,
  /** Через сколько минут после конца последней пары присылать сообщение */
  offsetMin: 30,
  /** С какого часа (по Москве) загружать расписание на сегодня */
  planFromHour: 6,
};

interface Plan {
  date: string;
  end: string | null; // конец последней пары; null — пар нет
  notifyAt: number | null; // когда прислать сообщение
  sent?: boolean;
}

const planKey = (date: string) => `commute:plan:${date}`;
const retryKey = "commute:retry_at";
const now = () => Math.floor(Date.now() / 1000);

async function loadPlan(ctx: Ctx, date: string): Promise<Plan | null> {
  const raw = await ctx.store.getSetting(planKey(date));
  return raw ? (JSON.parse(raw) as Plan) : null;
}

const savePlan = (ctx: Ctx, plan: Plan) => ctx.store.setSetting(planKey(plan.date), JSON.stringify(plan));

/** Загружает расписание и составляет план на дату. */
async function buildPlan(ctx: Ctx, date: string): Promise<Plan> {
  const day = await fetchDay(COMMUTE.groupId, date);
  const plan: Plan = day
    ? { date, end: day.end, notifyAt: mskToUnix(date, day.end) + COMMUTE.offsetMin * 60 }
    : { date, end: null, notifyAt: null };
  // Если план составлен уже после времени сообщения (например, бот задеплоен вечером) —
  // не присылаем задним числом
  if (plan.notifyAt && plan.notifyAt < now() - 30 * 60) plan.sent = true;
  await savePlan(ctx, plan);
  return plan;
}

/** План на сегодня: из базы или свежий с сайта. */
export async function todayPlan(ctx: Ctx): Promise<Plan> {
  const date = mskDate(now());
  return (await loadPlan(ctx, date)) ?? buildPlan(ctx, date);
}

/** Вызывается cron раз в минуту. */
export async function runCommute(ctx: Ctx) {
  const t = now();
  const date = mskDate(t);
  let plan = await loadPlan(ctx, date);

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

  if (!plan.notifyAt || plan.sent || t < plan.notifyAt) return;

  plan.sent = true;
  await savePlan(ctx, plan); // сначала отмечаем, чтобы не прислать дважды
  const subs = await ctx.store.listCommuteSubs();
  if (!subs.length) return;
  const text = await commuteMessage(ctx, `Пары кончились в ${plan.end}. Пора домой, господине.`);
  for (const chatId of subs) {
    await ctx.tg.send(chatId, text, refreshKb).catch((e) => console.error("commute send", chatId, e));
  }
}

/** Текст с прогнозом транспорта. */
export async function commuteMessage(ctx: Ctx, header: string) {
  const forecast = await compareOptions(ctx).catch((e) => {
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
async function homeText(ctx: Ctx, chatId: number) {
  const subscribed = await ctx.store.isCommuteSub(chatId);
  let planLine: string;
  try {
    const plan = await todayPlan(ctx);
    if (!plan.end) planLine = "Сегодня пар нет.";
    else if (plan.sent) planLine = `Сегодня пары до ${plan.end}.`;
    else planLine = `Сегодня пары до ${plan.end}, напомню в ${mskTime(plan.notifyAt!)}.`;
  } catch {
    planLine = "Расписание сейчас не загрузилось.";
  }
  const auto = subscribed
    ? `Сообщение через ${COMMUTE.offsetMin} мин после последней пары: <b>включено</b>.`
    : `Сообщение через ${COMMUTE.offsetMin} мин после последней пары: <b>выключено</b>.`;
  const body = await commuteMessage(ctx, "Дорога домой");
  return { text: `${body}\n\n${planLine}\n${auto}`, kb: homeKb(subscribed) };
}

export async function showHome(ctx: Ctx, chatId: number) {
  const { text, kb } = await homeText(ctx, chatId);
  await ctx.tg.send(chatId, text, kb);
}

/** Кнопки под сообщением «Дорога домой». */
export async function onHomeCallback(ctx: Ctx, data: string, chatId: number, messageId: number, cbId: string) {
  if (data === "home:on") await ctx.store.setCommuteSub(chatId, true);
  if (data === "home:off") await ctx.store.setCommuteSub(chatId, false);
  await ctx.tg.answer(
    cbId,
    data === "home:on" ? "Буду присылать" : data === "home:off" ? "Не буду присылать" : "Обновлено",
  );
  const { text, kb } = await homeText(ctx, chatId);
  await ctx.tg.edit(chatId, messageId, text, kb);
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
