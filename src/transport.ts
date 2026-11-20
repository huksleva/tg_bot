import type { Ctx } from "./bot";
import type { Env } from "./env";
import type { Stop, StopKind } from "./db";
import ROUTES from "./routes.json";
import TIMETABLE from "./timetable.json";
import { mskHour, mskTime } from "./schedule";
import { escapeHtml } from "./telegram";
import { gpsRouteKey, readGpsReport, type GpsReport } from "./transport-gps";

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
async function relayOnce(env: Env, path: string, timeoutMs = 16000): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${env.RELAY_URL}?path=${encodeURIComponent(path)}`, {
      headers: { "X-Relay-Secret": env.RELAY_SECRET! },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const name = (e as Error).name;
    throw new Error(name === "TimeoutError" || name === "AbortError" ? `нет ответа за ${timeoutMs / 1000} с` : `нет связи: ${(e as Error).message}`);
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
  gps?: true; // оценка по свежей позиции рядом с остановкой
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
interface Snapshot { t: number; v: Vehicle[] }

/** Последний прогноз, который получил cron, если он не старше maxAgeSec. */
async function recentSnapshot(ctx: Ctx, stop: Stop, maxAgeSec: number): Promise<Snapshot | null> {
  const raw = await ctx.store.getSetting(snapshotKey(stop));
  if (!raw) return null;
  const snap = JSON.parse(raw) as Snapshot;
  return nowSec() - snap.t <= maxAgeSec ? snap : null;
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
  const stops = withTransferStop(await ctx.store.listStops()).filter((s) => s.orgp_id);

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
    const prev = prevRaw ? (JSON.parse(prevRaw) as Snapshot) : null;
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

function timetableMinutes(stop: Stop, route: string, daytype: "wd" | "we") {
  return (TIMETABLE as Timetable)[String(stop.orgp_id)]?.[route]?.[daytype] ?? [];
}

function scheduledToday(stop: Stop, route: string, now: number) {
  const { min, daytype } = mskClock(now);
  const midnight = now - (now % 60) - min * 60;
  return timetableMinutes(stop, route, daytype).map((minutes) => midnight + minutes * 60);
}

/** Интервал движения маршрута у остановки сейчас (минуты) по расписанию. */
export function scheduledInterval(stop: Stop, route: string, unix = nowSec()): number | null {
  const { min, daytype } = mskClock(unix);
  const times = timetableMinutes(stop, route, daytype);
  if (!times.length) return null;
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
  const next = timetableMinutes(stop, route, daytype).find((x) => x >= min);
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

function arrivalTime(at: number, now: number) {
  const wait = at - now;
  const remaining = wait === 0 ? "сейчас" : wait < 60 ? "меньше минуты" : `через ${Math.round(wait / 60)} мин`;
  return `${mskTime(at)} (${remaining})`;
}

function pastTime(at: number, now: number) {
  const elapsed = now - at;
  const ago = elapsed < 60 ? "меньше минуты назад" : `${Math.round(elapsed / 60)} мин назад`;
  return `${mskTime(at)} (${ago})`;
}

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

const isMetroTram = (stop: Stop) => stop.orgp_id === METRO_TRAM_STOP && stop.kind === "tram";
const isTransfer = (stop: Stop) => snapshotKey(stop) === snapshotKey(SHAVROVA_BUS_STOP);

function withTransferStop(stops: Stop[]) {
  return stops.some(isMetroTram) && !stops.some(isTransfer) ? [...stops, SHAVROVA_BUS_STOP] : stops;
}

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
  if (!isMetroTram(stop) || !["47", "55"].includes(dep.route)) return null;

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
function estimate(last: number | undefined, interval: number | null, readyAt: number, scheduled: number | undefined) {
  if (last && interval && readyAt - last < 2 * interval * 60) {
    let at = last + interval * 60;
    while (at < readyAt) at += interval * 60;
    return { at, byInterval: true };
  }
  return scheduled === undefined ? null : { at: scheduled, byInterval: false };
}

type ForecastMode = "live" | "quick";

interface StopReport {
  stop: Stop;
  vehicles: Vehicle[] | null;
  snapshotAt?: number;
  lastByRoute: Map<string, number>;
}

async function loadStopReport(ctx: Ctx, stop: Stop, mode: ForecastMode): Promise<StopReport> {
  if (!stop.orgp_id) return { stop, vehicles: null, lastByRoute: new Map() };
  const liveForecast = mode === "live" && ctx.env.RELAY_URL && ctx.env.RELAY_SECRET
    ? fetchForecast(ctx.env, stop).catch((error) => {
      console.error("Прогноз остановки", stop.orgp_id, error);
      return null;
    })
    : Promise.resolve(null);
  const [live, lastByRoute] = await Promise.all([liveForecast, ctx.store.lastArrivals(stop.orgp_id)]);
  if (live) return { stop, vehicles: live, lastByRoute };
  const snapshot = await recentSnapshot(ctx, stop, 120);
  return { stop, vehicles: snapshot?.v ?? null, snapshotAt: snapshot?.t, lastByRoute };
}

function scheduleLines(atStop: number[], interval: number | null, now: number) {
  if (!atStop.length) return ["<b>Расписание</b> · нет данных"];
  const next = atStop.filter((at) => at >= now).slice(0, 3);
  const previous = atStop.filter((at) => at < now).at(-1);
  const upcoming = next.length
    ? [arrivalTime(next[0], now), ...next.slice(1).map(mskTime)].join(", ")
    : "больше рейсов сегодня нет";
  return [
    `<b>Расписание</b> · ${upcoming}${interval ? ` · каждые ~${interval} мин` : ""}`,
    ...(previous === undefined ? [] : [`Предыдущий по расписанию · ${pastTime(previous, now)}`]),
  ];
}

function describeRoute(
  report: StopReport, route: string, gps: GpsReport | null, transfer: Vehicle[] | null,
  now: number, mode: ForecastMode,
) {
  const { stop, vehicles, snapshotAt, lastByRoute } = report;
  const website = vehicles?.filter((v) => v.route === route && v.at >= now) ?? [];
  const corrections = isMetroTram(stop) ? gps?.metroTrams.get(route) : undefined;
  const nearby = [...(corrections?.values() ?? [])]
    .filter((v): v is Vehicle => v !== null).sort((a, b) => a.at - b.at);

  const listed = website.slice(0, 3).map((v) =>
    arrivalTime(v.at, now) + (corrections?.has(v.vehicle) ? " [уточнён по GPS]" : ""),
  );
  const siteLabel = snapshotAt === undefined ? "Сайт транспорта" : `Сайт транспорта · снимок на ${mskTime(snapshotAt)}`;
  const siteStatus = vehicles ? "живого прогноза по маршруту нет"
    : mode === "quick" ? "проверяю…" : "временно недоступен";
  const lines = [
    `<b>${escapeHtml(KIND_NAME[stop.kind] ?? stop.kind)} ${escapeHtml(route)}</b>`,
    `<b>${siteLabel}</b> · ${listed.length ? listed.join(", ") : siteStatus}`,
  ];

  const count = gps?.counts.get(gpsRouteKey(stop.kind, route));
  const gpsStatus = count ? `${count} на маршруте`
    : gps ? "свежих отметок нет" : mode === "quick" ? "проверяю…" : "координаты недоступны";
  const gpsAtStop = nearby.length ? " · у остановки ≈ " + nearby.slice(0, 2).map((v) => mskTime(v.at)).join(", ") : "";
  const passed = corrections && [...corrections.values()].some((v) => v === null) ? " · вагон уже за остановкой" : "";
  lines.push(`<b>GPS</b> · ${gpsStatus}${gpsAtStop}${passed}`);

  const interval = scheduledInterval(stop, route, now);
  const scheduled = scheduledToday(stop, route, now);
  lines.push(...scheduleLines(scheduled, interval, now));
  const last = lastByRoute.get(route);
  lines.push(`<b>Последнее отмеченное прибытие</b> · ${last === undefined ? "нет записи за 3 ч" : pastTime(last, now)}`);

  const readyAt = now + stop.walk_min * 60;
  const usable = [...website.filter((v) => !corrections?.has(v.vehicle)), ...nearby]
    .filter((v) => v.at >= readyAt).sort((a, b) => a.at - b.at)[0];
  const estimated = usable ? null : estimate(last, interval, readyAt, scheduled.find((at) => at >= readyAt));
  if (estimated?.byInterval) {
    lines.push(`Оценка по интервалу · ≈ ${arrivalTime(estimated.at, now)}`);
  }
  const at = usable?.at ?? estimated?.at;
  const plan = at === undefined ? null : homePlan(stop, {
    route, at, estimated: !usable || !!usable.gps || snapshotAt !== undefined,
  }, transfer);
  if (plan) {
    lines.push(`${escapeHtml(plan.path)} → дома ${plan.estimated ? "≈ " : ""}в ${mskTime(plan.arrival)}`);
  } else if (at !== undefined && isMetroTram(stop) && ["47", "55"].includes(route)) {
    lines.push("Подходящего автобуса после трамвая не нашёл.");
  }
  return { text: lines.join("\n"), plan };
}

/** Быстрый ответ использует расписание и снимки cron. После него загружаются сайт и GPS. */
export async function compareOptions(ctx: Ctx, mode: ForecastMode = "live"): Promise<string> {
  const stops = withTransferStop(await ctx.store.listStops());
  if (!stops.length) return "Остановок нет.";
  const kinds = [...new Set(stops.filter((s) => s.orgp_id).map((s) => s.kind))].join(",");
  const queryGps = mode === "live" && ctx.env.RELAY_URL && ctx.env.RELAY_SECRET && kinds;
  const gpsPayload = queryGps
    ? relayOnce(ctx.env, `/Portal/transport/internalapi/gtfs/realtime/vehicle?transports=${kinds}`, 5000)
      .then((response) => response.arrayBuffer()).catch((error) => {
        console.warn("GPS транспорта", error);
        return null;
      })
    : Promise.resolve(null);

  const [reports, payload] = await Promise.all([
    Promise.all(stops.map((stop) => loadStopReport(ctx, stop, mode))), gpsPayload,
  ]);
  const now = nowSec();
  let gps: GpsReport | null = null;
  if (payload) {
    try {
      const routes = new Set(stops.flatMap((stop) => stop.routes.split(",").map((route) => gpsRouteKey(stop.kind, route))));
      gps = readGpsReport(payload, routes, now);
    } catch (error) {
      console.warn("Формат GPS транспорта", error);
    }
  }

  const transfer = reports.find(({ stop }) => isTransfer(stop))?.vehicles ?? null;
  const plans: HomePlan[] = [];
  const sections = new Map<string, string[]>();
  for (const report of reports) {
    const { stop } = report;
    const atMetro = !stop.walk_min && (stop.orgp_id === METRO_BUS_STOP || isMetroTram(stop));
    const title = atMetro ? "У метро «Комендантский проспект»"
      : isTransfer(stop) ? `Пересадка · ${stop.name}` : stop.name;
    const walk = stop.walk_min ? ` (идти ${stop.walk_min} мин)` : "";
    const head = `📍 <b>${escapeHtml(title)}</b>${walk}`;
    const key = atMetro ? "metro" : String(stop.id);
    const section = sections.get(key) ?? [head];
    sections.set(key, section);
    if (!stop.orgp_id) {
      section.push("Не задан номер остановки для прогноза.");
      continue;
    }
    for (const route of stop.routes.split(",")) {
      const { text, plan } = describeRoute(report, route, gps, transfer, now, mode);
      section.push(text);
      if (plan) plans.push(plan);
    }
  }
  const blocks = [...sections.values()].map((section) => section.join("\n\n"));

  const best = plans.sort(byArrival)[0];
  const verdict = best
    ? `<b>Быстрее всего домой ${best.estimated ? "≈ " : ""}в ${mskTime(best.arrival)}</b>\n${escapeHtml(best.path)}.`
    : "Сейчас не удалось рассчитать время прибытия домой.";
  const updated = mode === "live" ? "Данные проверены" : "Предварительный расчёт";
  const notes = `${updated} в ${mskTime(now)} МСК. GPS на маршруте — оба направления. История прибытия — по прошлым прогнозам.`;
  return `${verdict}\n\n${blocks.join("\n\n")}\n\n<i>${notes}</i>`;
}
