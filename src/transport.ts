import type { Ctx } from "./bot";
import type { Env } from "./env";
import type { Stop, StopKind } from "./db";
import ROUTES from "./routes.json";
import TIMETABLE from "./timetable.json";
import { mskHour, mskTime } from "./schedule";
import { escapeHtml } from "./telegram";

export const KIND_NAME: Record<StopKind, string> = { bus: "Автобус", tram: "Трамвай", trolley: "Троллейбус" };

/**
 * Прогноз прибытия транспорта Петербурга.
 *
 * Три источника, от точного к приблизительному:
 *  1. Живой прогноз «Организатора перевозок» (transport.orgp.spb.ru) — через посредника
 *     в Яндекс.Облаке (сайт отвечает только российским адресам). RELAY_URL, RELAY_SECRET.
 *  2. Фактические прибытия: cron раз в минуту смотрит прогноз по остановкам и записывает,
 *     какие машины прошли (таблица arrivals) — отсюда «последний был N мин назад».
 *  3. Расписание из справочника GTFS (src/timetable.json) — отсюда интервал движения.
 * Если живого прогноза нет, бот оценивает: последний прибывший + интервал по расписанию.
 */

/** Один вызов посредника. */
async function relayOnce(env: Env, path: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${env.RELAY_URL}?path=${encodeURIComponent(path)}`, {
      headers: { "X-Relay-Secret": env.RELAY_SECRET! },
      signal: AbortSignal.timeout(16000), // посредник сдаётся максимум через ~14,5 с
    });
  } catch (e) {
    const name = (e as Error).name;
    throw new Error(name === "TimeoutError" || name === "AbortError" ? "нет ответа за 16 с" : `нет связи: ${(e as Error).message}`);
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 120);
    throw new Error(`HTTP ${res.status}${body ? `: ${body}` : ""}`);
  }
  return res;
}

/**
 * Запрос к transport.orgp.spb.ru через посредника. Городские сайты не пускают часть адресов
 * Яндекс.Облака: если вызов посредника не удался целиком, повторный обычно попадает на другую
 * машину облака и проходит — поэтому одна повторная попытка.
 */
export async function orgp(env: Env, path: string): Promise<Response> {
  if (!env.RELAY_URL || !env.RELAY_SECRET) throw new Error("Посредник не настроен");
  try {
    return await relayOnce(env, path);
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.startsWith("HTTP 403") || msg.startsWith("HTTP 400")) throw e; // повтор не поможет
    console.warn("Посредник не ответил, повтор:", msg);
    return relayOnce(env, path);
  }
}

const nowSec = () => Math.floor(Date.now() / 1000);

// ---------------- 1. Живой прогноз ----------------

interface ForecastItem {
  routeId: string;
  arrivingTime: string; // «2026-11-07 01:39:42» по Москве
  parkNumber?: string;
}

export interface Vehicle {
  route: string; // номер маршрута, «47»
  at: number; // unix-время прибытия
  vehicle: string; // бортовой номер
}

/** «2026-11-07 01:39:42» по Москве -> unix. */
function mskStringToUnix(s: string) {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return NaN;
  const [, y, mo, d, h, mi, se] = m.map(Number);
  return Date.UTC(y, mo - 1, d, h - 3, mi, se) / 1000;
}

/** Все машины из прогноза остановки — только её маршруты и её вид транспорта. */
export async function fetchForecast(env: Env, stop: Stop): Promise<Vehicle[]> {
  const res = await orgp(env, `/Portal/transport/internalapi/forecast/bystop?stopID=${stop.orgp_id}`);
  const data = (await res.json().catch(() => ({}))) as { success?: boolean; result?: ForecastItem[] };
  if (!data.success) throw new Error("сайт транспорта вернул ошибку");
  const wanted = new Set(stop.routes.split(","));
  const list: Vehicle[] = [];
  for (const item of data.result ?? []) {
    const route = (ROUTES as Record<string, string[]>)[item.routeId];
    if (!route || route[1] !== stop.kind || !wanted.has(route[0])) continue;
    const at = mskStringToUnix(item.arrivingTime);
    if (!Number.isFinite(at)) continue;
    list.push({ route: route[0], at, vehicle: item.parkNumber || `${item.routeId}@${item.arrivingTime}` });
  }
  return list.sort((a, b) => a.at - b.at);
}

// ---------------- 2. Фактические прибытия (cron) ----------------

const snapshotKey = (stop: Stop) => `obs:${stop.orgp_id}:${stop.kind}:${stop.routes}`;

/** Последний прогноз, который получил cron, если он не старше maxAgeSec. */
async function recentSnapshot(ctx: Ctx, stop: Stop, maxAgeSec: number): Promise<Vehicle[] | null> {
  const raw = await ctx.store.getSetting(snapshotKey(stop));
  if (!raw) return null;
  const snap = JSON.parse(raw) as { t: number; v: Vehicle[] };
  return nowSec() - snap.t <= maxAgeSec ? snap.v : null;
}

/** С какого и до какого часа (по Москве) следить за остановками. */
const OBSERVE_FROM_HOUR = 5;

/**
 * Вызывается cron раз в минуту. Сравнивает прогноз с прошлой минутой: машина, которая
 * должна была вот-вот подойти и пропала из прогноза (или её время прошло), — прибыла.
 */
export async function observeStops(ctx: Ctx) {
  const t = nowSec();
  if (!ctx.env.RELAY_URL || !ctx.env.RELAY_SECRET || mskHour(t) < OBSERVE_FROM_HOUR) return;
  const stops = (await ctx.store.listStops()).filter((s) => s.orgp_id);

  await Promise.all(stops.map(async (stop) => {
    let current: Vehicle[];
    try {
      current = await fetchForecast(ctx.env, stop);
    } catch (e) {
      console.error("Наблюдение за остановкой", stop.orgp_id, e);
      return;
    }
    const key = snapshotKey(stop);
    const prevRaw = await ctx.store.getSetting(key);
    const prev = prevRaw ? (JSON.parse(prevRaw) as { t: number; v: Vehicle[] }) : null;
    const byVehicle = new Map(current.map((v) => [v.vehicle, v]));

    // Прошлый снимок старше 5 минут — сравнивать не с чем (был перерыв)
    if (prev && t - prev.t < 300) {
      for (const p of prev.v) {
        const now = byVehicle.get(p.vehicle);
        const gone = !now || now.at < t - 60; // пропала или «зависла» в прошлом
        const wasDue = p.at <= t + 120; // должна была подойти в ближайшие пару минут
        if (gone && wasDue) {
          await ctx.store.addArrival(stop.orgp_id!, p.route, Math.min(p.at, t), p.vehicle);
        }
      }
    }
    // Запоминаем только машины, которые ещё не прошли
    await ctx.store.setSetting(key, JSON.stringify({ t, v: current.filter((v) => v.at >= t - 60) }));
  }));

  // Раз в час чистим старые записи
  if (new Date(t * 1000).getUTCMinutes() === 0) await ctx.store.pruneArrivals(t - 2 * 86400);
}

// ---------------- 3. Расписание ----------------

type Timetable = Record<string, Record<string, { wd?: number[]; we?: number[] }>>;

/** Минуты от полуночи (по Москве) и тип дня. */
function mskClock(unix: number) {
  const d = new Date((unix + 3 * 3600) * 1000);
  const day = d.getUTCDay();
  return { min: d.getUTCHours() * 60 + d.getUTCMinutes(), daytype: day === 0 || day === 6 ? "we" : "wd" } as const;
}

/** Интервал движения маршрута у остановки сейчас (минуты) по расписанию. */
export function scheduledInterval(stop: Stop, route: string, unix = nowSec()): number | null {
  const { min, daytype } = mskClock(unix);
  const times = (TIMETABLE as Timetable)[String(stop.orgp_id)]?.[route]?.[daytype];
  if (!times?.length) return null;
  for (const window of [30, 60, 120]) {
    const near = times.filter((x) => Math.abs(x - min) <= window);
    if (near.length >= 3) {
      const gaps = near.slice(1).map((x, i) => x - near[i]);
      return Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length);
    }
  }
  return null;
}

/** Ближайшее прибытие по расписанию не раньше указанного времени (unix). */
export function nextScheduled(stop: Stop, route: string, after: number): number | null {
  const { min, daytype } = mskClock(after);
  const times = (TIMETABLE as Timetable)[String(stop.orgp_id)]?.[route]?.[daytype];
  const next = times?.find((x) => x >= min);
  return next === undefined ? null : after + (next - min) * 60;
}

// ---------------- Сравнение вариантов ----------------

interface Departure {
  route: string;
  at: number;
  estimated: boolean;
}

interface HomePlan {
  arrival: number;
  estimated: boolean;
  path: string;
}

const mins = (at: number) => Math.max(0, Math.round((at - Date.now() / 1000) / 60));
const inMin = (at: number) => (mins(at) === 0 ? "прибывает" : `через ${mins(at)} мин`);

const METRO_BUS_STOP = 2068;
const METRO_TRAM_STOP = 16644;
const HOME_BUSES = {
  "258": { stop: "Плесецкая ул.", ride: 7, walk: 4 },
  "171": { stop: "Глухарская ул.", ride: 7, walk: 7 },
  "182": { stop: "Глухарская ул., 5", ride: 6, walk: 7 },
};
const CHANGE_ROUTES = ["258", "171", "182"] as const;
const SHAVROVA_BUS_STOP: Stop = {
  id: 0,
  kind: "bus",
  name: "Ул. Шаврова",
  routes: CHANGE_ROUTES.join(","),
  walk_min: 0,
  orgp_id: 27010,
};

/** Последний участок домой, с временем в салоне по GTFS и пешим подходом. */
function busHome(route: keyof typeof HOME_BUSES, at: number, estimated: boolean, ride = HOME_BUSES[route].ride): HomePlan {
  const { stop, walk } = HOME_BUSES[route];
  return {
    arrival: at + (ride + walk) * 60,
    estimated,
    path: `автобус ${route} в ${mskTime(at)} → ${stop} в ${mskTime(at + ride * 60)} → ${walk} мин пешком`,
  };
}

function homePlan(stop: Stop, dep: Departure, transfer: Vehicle[] | null): HomePlan | null {
  if (stop.orgp_id === METRO_BUS_STOP && stop.kind === "bus" && dep.route === "258") {
    return busHome("258", dep.at, dep.estimated, 18);
  }
  if (stop.orgp_id !== METRO_TRAM_STOP || stop.kind !== "tram" || !["47", "55"].includes(dep.route)) return null;

  const off = dep.at + 10 * 60;
  const scheduledFrom = Math.ceil(off / 60) * 60;
  const plans: HomePlan[] = [];
  for (const route of CHANGE_ROUTES) {
    const live = transfer?.find((v) => v.route === route && v.at >= off);
    const at = live?.at ?? nextScheduled(SHAVROVA_BUS_STOP, route, scheduledFrom);
    if (at !== null) plans.push(busHome(route, at, !live));
  }
  const best = plans.sort(byArrival)[0];
  return best ? {
    arrival: best.arrival,
    estimated: dep.estimated || best.estimated,
    path: `трамвай ${dep.route} в ${mskTime(dep.at)} → Ул. Шаврова в ${mskTime(off)} → ${best.path}`,
  } : null;
}

const byArrival = (a: HomePlan, b: HomePlan) => a.arrival - b.arrival || Number(a.estimated) - Number(b.estimated);

/** Оценка следующего прибытия без живого прогноза: последний + интервал, иначе расписание. */
function estimate(stop: Stop, route: string, last: number | undefined, interval: number | null, readyAt: number) {
  if (last && interval) {
    let at = last + interval * 60;
    // Если ждать дольше двух интервалов — оценка уже бессмысленна, берём расписание
    if (readyAt - last < 2 * interval * 60) {
      while (at < readyAt) at += interval * 60;
      return at;
    }
  }
  return nextScheduled(stop, route, readyAt);
}

/**
 * mode = "live"  — свежий прогноз с сайта транспорта (может занять несколько секунд);
 * mode = "quick" — без запросов: прогноз, который cron получил не больше 2 минут назад,
 *                  иначе оценка по расписанию. Нужен, чтобы ответить мгновенно.
 */
export async function compareOptions(ctx: Ctx, mode: "live" | "quick" = "live"): Promise<string> {
  const stops = await ctx.store.listStops();
  if (!stops.length) return "Остановок нет.";
  const hasRelay = ctx.env.RELAY_URL && ctx.env.RELAY_SECRET;
  const hasTram = stops.some((s) => s.orgp_id === METRO_TRAM_STOP && s.kind === "tram");
  const transferForecast = mode === "live" && hasRelay && hasTram
    ? fetchForecast(ctx.env, SHAVROVA_BUS_STOP).catch((error) => {
      console.error("Прогноз пересадки на ул. Шаврова", error);
      return null;
    })
    : Promise.resolve(null);

  const t = nowSec();
  const plans: HomePlan[] = [];
  const blocks = await Promise.all(stops.map(async (stop) => {
    const routes = stop.routes.split(",");
    const head = `<b>${escapeHtml(KIND_NAME[stop.kind] ?? stop.kind)} ${escapeHtml(routes.join(", "))}</b>` +
      (stop.walk_min ? ` (идти ${stop.walk_min} мин)` : "");
    if (!stop.orgp_id) return `${head}\nне задан номер для прогноза`;

    let live: Vehicle[] | null = null;
    let noAnswer = "";
    if (mode === "quick") {
      live = await recentSnapshot(ctx, stop, 120);
      if (live) live = live.filter((v) => v.at >= t);
      noAnswer = "загружаю живой прогноз…";
    } else if (hasRelay) {
      try {
        live = await fetchForecast(ctx.env, stop);
      } catch (e) {
        const failure = (e as Error).message;
        console.error("Прогноз остановки", stop.id, failure);
        noAnswer = `сайт транспорта не ответил (${escapeHtml(failure)})`;
      }
    } else {
      noAnswer = "живой прогноз недоступен";
    }
    const lastByRoute = await ctx.store.lastArrivals(stop.orgp_id);
    const readyAt = t + stop.walk_min * 60; // раньше этого времени на остановку не успеть
    const transfer = stop.orgp_id === METRO_TRAM_STOP ? await transferForecast : null;

    const lines = routes.map((route) => {
      const prefix = routes.length > 1 ? `${route}: ` : "";
      const interval = scheduledInterval(stop, route, t);
      const last = lastByRoute.get(route);
      const reachable = (live ?? []).filter((v) => v.route === route && v.at >= readyAt);

      let departure: Departure | undefined;
      let main: string;
      if (reachable.length) {
        departure = { route, at: reachable[0].at, estimated: false };
        main = reachable.slice(0, 3).map((v) => `${inMin(v.at)} (${mskTime(v.at)})`).join(", ");
      } else {
        const est = estimate(stop, route, last, interval, readyAt);
        if (est !== null) {
          departure = { route, at: est, estimated: true };
          const how = last && interval && readyAt - last < 2 * interval * 60 ? "по интервалу" : "по расписанию";
          main = `${live ? "живого прогноза нет" : noAnswer}, ≈ ${inMin(est)} (${how})`;
        } else {
          main = live ? "прогноза нет" : noAnswer;
        }
      }

      const plan = departure ? homePlan(stop, departure, transfer) : null;
      if (plan) {
        plans.push(plan);
        main += `\n${escapeHtml(plan.path)} → дома ${plan.estimated ? "≈ " : ""}в ${mskTime(plan.arrival)}`;
      } else if (departure && stop.orgp_id === METRO_TRAM_STOP && ["47", "55"].includes(route)) {
        main += "\nПодходящего автобуса после трамвая не нашёл.";
      }

      const facts: string[] = [];
      if (last && t - last < 90 * 60) facts.push(`был ${Math.max(0, Math.round((t - last) / 60))} мин назад`);
      if (interval) facts.push(`ходит каждые ~${interval} мин`);
      return `${prefix}${main}${facts.length ? `\n<i>${facts.join(", ")}</i>` : ""}`;
    });
    const transferNote = stop.orgp_id === METRO_TRAM_STOP && stop.kind === "tram"
      ? `\nПересадка у «Ул. Шаврова» на автобусы ${CHANGE_ROUTES.join(", ")}`
      : "";
    return `${head}${transferNote}\n${lines.join("\n")}`;
  }));

  const best = plans.sort(byArrival)[0];
  const verdict = best
    ? `<b>Быстрее всего домой ${best.estimated ? "≈ " : ""}в ${mskTime(best.arrival)}</b>\n${escapeHtml(best.path)}.`
    : "Сейчас не удалось рассчитать время прибытия домой.";
  return `${verdict}\n\n${blocks.join("\n\n")}`;
}
