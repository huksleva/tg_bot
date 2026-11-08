import type { Ctx } from "./bot";
import type { Env } from "./env";
import type { Stop } from "./db";
import ROUTES from "./routes.json";
import TIMETABLE from "./timetable.json";
import { mskHour, mskTime } from "./schedule";
import { KIND_NAME, stopTitle } from "./stops";
import { escapeHtml } from "./telegram";

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
async function fetchForecast(env: Env, stop: Stop): Promise<Vehicle[]> {
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
function nextScheduled(stop: Stop, route: string, after: number): number | null {
  const { min, daytype } = mskClock(after);
  const times = (TIMETABLE as Timetable)[String(stop.orgp_id)]?.[route]?.[daytype];
  const next = times?.find((x) => x >= min);
  return next === undefined ? null : after + (next - min) * 60;
}

// ---------------- Сравнение вариантов ----------------

interface Option {
  stop: Stop;
  route: string;
  at: number;
  estimated: boolean; // true — оценка, а не живой прогноз
}

const mins = (at: number) => Math.max(0, Math.round((at - Date.now() / 1000) / 60));
const inMin = (at: number) => (mins(at) === 0 ? "прибывает" : `через ${mins(at)} мин`);

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
  if (!stops.length) return "Остановок нет — добавь их: /addstop";
  if (!ctx.env.RELAY_URL || !ctx.env.RELAY_SECRET) {
    return stops.map((s) => `— ${escapeHtml(stopTitle(s))}`).join("\n") +
      "\n\nПрогноз недоступен: не настроен посредник (RELAY_URL, RELAY_SECRET).";
  }

  const t = nowSec();
  const options: Option[] = [];
  const blocks = await Promise.all(stops.map(async (stop) => {
    const routes = stop.routes.split(",");
    const head = `<b>${escapeHtml(KIND_NAME[stop.kind] ?? stop.kind)} ${escapeHtml(routes.join(", "))}</b>` +
      (stop.walk_min ? ` (идти ${stop.walk_min} мин)` : "");
    if (!stop.orgp_id) return `${head}\nне задан номер для прогноза (/editstop)`;

    let live: Vehicle[] | null = null;
    let noAnswer = "";
    if (mode === "quick") {
      live = await recentSnapshot(ctx, stop, 120);
      if (live) live = live.filter((v) => v.at >= t);
      noAnswer = "загружаю живой прогноз…";
    } else {
      try {
        live = await fetchForecast(ctx.env, stop);
      } catch (e) {
        const failure = (e as Error).message;
        console.error("Прогноз остановки", stop.id, failure);
        noAnswer = `сайт транспорта не ответил (${escapeHtml(failure)})`;
      }
    }
    const lastByRoute = await ctx.store.lastArrivals(stop.orgp_id);
    const readyAt = t + stop.walk_min * 60; // раньше этого времени на остановку не успеть

    const lines = routes.map((route) => {
      const prefix = routes.length > 1 ? `${route}: ` : "";
      const interval = scheduledInterval(stop, route, t);
      const last = lastByRoute.get(route);
      const reachable = (live ?? []).filter((v) => v.route === route && v.at >= readyAt);

      let main: string;
      if (reachable.length) {
        options.push({ stop, route, at: reachable[0].at, estimated: false });
        main = reachable.slice(0, 3).map((v) => `${inMin(v.at)} (${mskTime(v.at)})`).join(", ");
      } else {
        const est = estimate(stop, route, last, interval, readyAt);
        if (est) {
          options.push({ stop, route, at: est, estimated: true });
          const how = last && interval && readyAt - last < 2 * interval * 60 ? "по интервалу" : "по расписанию";
          main = `${live ? "живого прогноза нет" : noAnswer}, ≈ ${inMin(est)} (${how})`;
        } else {
          main = live ? "прогноза нет" : noAnswer;
        }
      }

      const facts: string[] = [];
      if (last && t - last < 90 * 60) facts.push(`был ${Math.max(0, Math.round((t - last) / 60))} мин назад`);
      if (interval) facts.push(`ходит каждые ~${interval} мин`);
      return `${prefix}${main}${facts.length ? `\n<i>${facts.join(", ")}</i>` : ""}`;
    });
    return `${head}\n${lines.join("\n")}`;
  }));

  // Лучший вариант: раньше всех окажешься в транспорте. Живой прогноз при равенстве важнее.
  options.sort((a, b) => a.at - b.at || Number(a.estimated) - Number(b.estimated));
  const best = options[0];
  const verdict = best
    ? `<b>Быстрее всего${best.estimated ? " (оценка)" : ""}: ${escapeHtml((KIND_NAME[best.stop.kind] ?? best.stop.kind).toLowerCase())} ${best.route}, ` +
      `${best.estimated ? "≈ " : ""}${mins(best.at) === 0 ? "уже прибывает" : `через ${mins(best.at)} мин`}.</b>`
    : "Прогноза прибытия сейчас нет — транспорт не ходит или не передаёт данные.";
  return `${verdict}\n\n${blocks.join("\n\n")}`;
}
