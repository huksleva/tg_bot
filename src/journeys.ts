import type { Ctx } from "./bot";
import type { Stop, StopKind } from "./db";
import { mskTime } from "./schedule";
import { escapeHtml, type InlineKeyboard } from "./telegram";
import { fetchForecast, nextScheduled, type Vehicle } from "./transport";

/**
 * Дорога в вуз: от остановки «Глухарская ул.» до метро «Комендантский проспект».
 *
 * Варианты бывают с пересадкой, поэтому сравниваем не «кто раньше подойдёт», а «во сколько
 * окажешься у метро»: ожидание + поездка + пешком + ожидание следующего транспорта + поездка.
 * Время в пути — медиана по расписанию из справочника GTFS (днём), пешком — по Яндекс.Навигатору:
 * дом → Глухарская ул. 7 мин, дом → Пр. Авиаконструкторов, угол Плесецкой ул. 4 мин,
 * Шуваловский пр. → Ул. Шаврова 4 мин, ул. Уточкина → метро 2 мин, трамвайная остановка → метро 3 мин.
 */

interface Leg {
  stop: number; // номер остановки у «Организатора перевозок»
  stopName: string;
  kind: StopKind;
  routes: string[];
  ride: Record<string, number>; // минут в пути по маршрутам
  alight: string; // где выходить
  walkAfter?: number; // минут пешком после выхода
}

interface Journey {
  title: string;
  walkFrom: number; // минут пешком от дома до первой остановки
  legs: Leg[];
}

const GLUKHARSKAYA = { stop: 33513, stopName: "Глухарская ул.", kind: "bus" as const };

export const TO_UNI = {
  goal: "метро «Комендантский проспект»",
  options: [
    {
      title: "Троллейбус 50 до метро",
      walkFrom: 4,
      legs: [{
        stop: 39355, stopName: "Пр. Авиаконструкторов, угол Плесецкой ул.", kind: "trolley",
        routes: ["50"], ride: { "50": 22 }, alight: "ст. метро", // утром по расписанию 17–22 мин
      }],
    },
    {
      title: "Автобус 171 до метро",
      walkFrom: 7,
      legs: [{ ...GLUKHARSKAYA, routes: ["171"], ride: { "171": 16 }, alight: "ст. метро" }],
    },
    {
      title: "Автобус 170 до метро (ост. ул. Уточкина)",
      walkFrom: 7,
      legs: [{ ...GLUKHARSKAYA, routes: ["170"], ride: { "170": 20 }, alight: "ул. Уточкина", walkAfter: 2 }],
    },
    {
      title: "Автобус 85/170 + трамвай 47/55",
      walkFrom: 7,
      legs: [
        { ...GLUKHARSKAYA, routes: ["85", "170"], ride: { "85": 5, "170": 6 }, alight: "Шуваловский пр.", walkAfter: 4 },
        { stop: 16017, stopName: "Ул. Шаврова", kind: "tram", routes: ["47", "55"], ride: { "47": 10, "55": 10 }, alight: "остановка у метро", walkAfter: 3 },
      ],
    },
  ] as Journey[],
};

const KIND: Record<StopKind, string> = { bus: "автобус", tram: "трамвай", trolley: "троллейбус" };

interface Departure {
  route: string;
  at: number;
  estimated: boolean; // по расписанию, а не живой прогноз
}

const nowSec = () => Math.floor(Date.now() / 1000);

/** «Ненастоящая» остановка для функций прогноза и расписания. */
const asStop = (stop: number, kind: StopKind, routes: string[]): Stop => ({
  id: 0,
  kind,
  name: "",
  routes: routes.join(","),
  walk_min: 0,
  orgp_id: stop,
});

/**
 * Ближайшие отправления с остановки не раньше after: живой прогноз, а по маршрутам,
 * которых в нём нет, — ближайший рейс по расписанию.
 */
function departures(leg: Leg, live: Vehicle[] | null, after: number, perRoute = 2): Departure[] {
  const out: Departure[] = [];
  for (const route of leg.routes) {
    const fromLive = (live ?? []).filter((v) => v.route === route && v.at >= after).slice(0, perRoute);
    if (fromLive.length) {
      out.push(...fromLive.map((v) => ({ route, at: v.at, estimated: false })));
      continue;
    }
    let t = after;
    for (let i = 0; i < perRoute; i++) {
      const next = nextScheduled(asStop(leg.stop, leg.kind, [route]), route, t);
      if (next === null) break;
      out.push({ route, at: next, estimated: true });
      t = next + 60;
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

interface Plan {
  journey: Journey;
  leave: number; // когда выйти из дома
  arrival: number;
  steps: { leg: Leg; dep: Departure; off: number }[];
  estimated: boolean;
}

/** Лучший план для варианта маршрута. */
function bestPlan(journey: Journey, live: Map<number, Vehicle[] | null>, now: number): Plan | null {
  let best: Plan | null = null;
  const start = now + journey.walkFrom * 60; // раньше, чем дойдёшь до остановки, не уехать
  const [first, ...rest] = journey.legs;
  for (const dep of departures(first, live.get(first.stop) ?? null, start)) {
    const steps = [{ leg: first, dep, off: dep.at + (first.ride[dep.route] ?? 0) * 60 }];
    let t = steps[0].off + (first.walkAfter ?? 0) * 60;
    let ok = true;
    for (const leg of rest) {
      const next = departures(leg, live.get(leg.stop) ?? null, t, 1)[0];
      if (!next) {
        ok = false;
        break;
      }
      const off = next.at + (leg.ride[next.route] ?? 0) * 60;
      steps.push({ leg, dep: next, off });
      t = off + (leg.walkAfter ?? 0) * 60;
    }
    if (!ok) continue;
    const plan = { journey, leave: dep.at - journey.walkFrom * 60, arrival: t, steps, estimated: steps.some((s) => s.dep.estimated) };
    if (!best || plan.arrival < best.arrival) best = plan;
  }
  return best;
}

const mins = (at: number) => Math.max(0, Math.round((at - nowSec()) / 60));
const leaveIn = (at: number) => (mins(at) === 0 ? "сейчас" : `через ${mins(at)} мин`);

function describe(plan: Plan) {
  const parts = plan.steps.map((s, i) => {
    const dep = `${s.dep.estimated ? "≈ " : ""}${s.dep.route} в ${mskTime(s.dep.at)}`;
    const kind = i === 0 ? "" : `${KIND[s.leg.kind]} `;
    const walk = s.leg.walkAfter ? `, ${s.leg.walkAfter} мин пешком` : "";
    const off = i < plan.steps.length - 1 || walk ? ` → ${s.leg.alight} в ${mskTime(s.off)}${walk}` : "";
    return `${kind}${dep}${off}`;
  });
  const leave = `выйти в ${mskTime(plan.leave)} (${leaveIn(plan.leave)}), ${plan.journey.walkFrom} мин пешком`;
  return `${leave} → ${parts.join(" → ")} → у метро в ${mskTime(plan.arrival)}`;
}

/** Текст «В вуз». mode = "quick" — без запросов к сайту транспорта, только расписание. */
export async function uniText(ctx: Ctx, mode: "live" | "quick" = "live") {
  const t = nowSec();

  // Живой прогноз по каждой остановке маршрута — параллельно
  const stopRoutes = new Map<number, { kind: StopKind; routes: Set<string>; name: string }>();
  for (const j of TO_UNI.options) {
    for (const leg of j.legs) {
      const e = stopRoutes.get(leg.stop) ?? { kind: leg.kind, routes: new Set<string>(), name: leg.stopName };
      leg.routes.forEach((r) => e.routes.add(r));
      stopRoutes.set(leg.stop, e);
    }
  }
  const live = new Map<number, Vehicle[] | null>();
  const notes: string[] = [];
  await Promise.all([...stopRoutes].map(async ([stop, e]) => {
    if (mode === "quick" || !ctx.env.RELAY_URL) {
      live.set(stop, null);
      return;
    }
    try {
      live.set(stop, await fetchForecast(ctx.env, asStop(stop, e.kind, [...e.routes])));
    } catch (err) {
      live.set(stop, null);
      notes.push(`«${e.name}»: сайт транспорта не ответил (${escapeHtml((err as Error).message)}), время по расписанию.`);
    }
  }));

  const plans = TO_UNI.options.map((j) => ({ j, plan: bestPlan(j, live, t) }));
  const best = plans
    .map((p) => p.plan)
    .filter((p): p is Plan => !!p)
    .sort((a, b) => a.arrival - b.arrival || Number(a.estimated) - Number(b.estimated))[0];

  const verdict = best
    ? `<b>Быстрее всего${best.estimated ? " (оценка)" : ""}: ${escapeHtml(best.journey.title.toLowerCase())}, ` +
      `выйти в ${mskTime(best.leave)} (${leaveIn(best.leave)}), у метро в ${mskTime(best.arrival)}.</b>`
    : "Не нашёл ни одного варианта — транспорт, похоже, уже не ходит.";
  const blocks = plans.map(({ j, plan }) =>
    `<b>${escapeHtml(j.title)}</b>\n${plan ? escapeHtml(describe(plan)) : "сегодня рейсов уже нет"}`,
  );
  if (mode === "quick") notes.push("Это расписание, загружаю живой прогноз…");
  return `${verdict}\n\n${blocks.join("\n\n")}${notes.length ? `\n\n<i>${notes.join("\n")}</i>` : ""}`;
}

// ---------------- Экран «В вуз» ----------------

export const uniRefreshKb: InlineKeyboard = {
  inline_keyboard: [[{ text: "Обновить прогноз", callback_data: "uni:refresh" }]],
};

function uniKb(subscribed: boolean): InlineKeyboard {
  return {
    inline_keyboard: [
      [{ text: "Обновить прогноз", callback_data: "uni:refresh" }],
      [{
        text: subscribed ? "Не присылать перед парами" : "Присылать перед парами",
        callback_data: subscribed ? "uni:off" : "uni:on",
      }],
    ],
  };
}

async function screen(ctx: Ctx, chatId: number, mode: "live" | "quick", planLine: string, leadMin: number) {
  const subscribed = await ctx.store.isUniSub(chatId);
  const body = await uniText(ctx, mode);
  const auto = `Сообщение за ${Math.floor(leadMin / 60)} ч ${leadMin % 60} мин до первой пары: <b>${subscribed ? "включено" : "выключено"}</b>.`;
  return {
    text: `<b>В вуз: до ${TO_UNI.goal}</b>\n\n${body}\n\n${planLine}\n${auto}`,
    kb: uniKb(subscribed),
  };
}

/** Сначала расписание (мгновенно), потом то же сообщение — с живым прогнозом. */
export async function showUni(ctx: Ctx, chatId: number, planLine: string, leadMin: number) {
  const quick = await screen(ctx, chatId, "quick", planLine, leadMin);
  const sent = await ctx.tg.send(chatId, quick.text, quick.kb);
  const full = await screen(ctx, chatId, "live", planLine, leadMin);
  if (full.text !== quick.text) await ctx.tg.edit(chatId, sent.message_id, full.text, full.kb);
}

export async function onUniCallback(
  ctx: Ctx, data: string, chatId: number, messageId: number, cbId: string, planLine: string, leadMin: number,
) {
  if (data === "uni:on") await ctx.store.setUniSub(chatId, true);
  if (data === "uni:off") await ctx.store.setUniSub(chatId, false);
  await ctx.tg.answer(cbId, data === "uni:on" ? "Буду присылать" : data === "uni:off" ? "Не буду присылать" : "Обновляю прогноз…");
  const quick = await screen(ctx, chatId, "quick", planLine, leadMin);
  await ctx.tg.edit(chatId, messageId, quick.text, quick.kb);
  const full = await screen(ctx, chatId, "live", planLine, leadMin);
  if (full.text !== quick.text) await ctx.tg.edit(chatId, messageId, full.text, full.kb);
}
