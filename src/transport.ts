import type { Ctx } from "./bot";
import type { Env } from "./env";
import type { Stop } from "./db";
import ROUTES from "./routes.json";
import { mskTime } from "./schedule";
import { KIND_NAME, stopTitle } from "./stops";
import { escapeHtml } from "./telegram";

/**
 * Прогноз прибытия транспорта Петербурга.
 *
 * Данные — открытый API «Организатора перевозок» (transport.orgp.spb.ru). Он отвечает
 * только российским адресам, поэтому запросы идут через посредника — функцию
 * в Яндекс.Облаке (папка relay/). Адрес и секрет посредника: RELAY_URL и RELAY_SECRET.
 */

/** Запрос к transport.orgp.spb.ru через посредника. */
export async function orgp(env: Env, path: string): Promise<Response> {
  if (!env.RELAY_URL || !env.RELAY_SECRET) throw new Error("Посредник не настроен");
  const url = `${env.RELAY_URL}?path=${encodeURIComponent(path)}`;
  const res = await fetch(url, {
    headers: { "X-Relay-Secret": env.RELAY_SECRET },
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`Посредник: HTTP ${res.status}`);
  return res;
}

// ---------------- Прогноз по остановке ----------------

interface ForecastItem {
  routeId: string;
  arrivingTime: string; // «2026-11-07 01:39:42» по Москве
  parkNumber?: string;
}

export interface Arrival {
  route: string; // номер маршрута, «47»
  at: number; // unix-время прибытия
}

/** «2026-11-07 01:39:42» по Москве -> unix. */
function mskStringToUnix(s: string) {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return NaN;
  const [, y, mo, d, h, mi, se] = m.map(Number);
  return Date.UTC(y, mo - 1, d, h - 3, mi, se) / 1000;
}

/** Прибытия маршрутов остановки (только её маршруты и её вид транспорта), по возрастанию. */
export async function stopArrivals(env: Env, stop: Stop): Promise<Arrival[]> {
  const res = await orgp(env, `/Portal/transport/internalapi/forecast/bystop?stopID=${stop.orgp_id}`);
  const data = (await res.json()) as { success?: boolean; result?: ForecastItem[] };
  if (!data.success) throw new Error("сайт транспорта вернул ошибку");
  const wanted = new Set(stop.routes.split(","));
  const now = Date.now() / 1000;
  const list: Arrival[] = [];
  for (const item of data.result ?? []) {
    const route = (ROUTES as Record<string, string[]>)[item.routeId];
    if (!route || route[1] !== stop.kind || !wanted.has(route[0])) continue;
    const at = mskStringToUnix(item.arrivingTime);
    // Прогноз иногда «висит» после того, как машина уже прошла — отбрасываем прошедшие
    if (Number.isFinite(at) && at >= now - 30) list.push({ route: route[0], at });
  }
  return list.sort((a, b) => a.at - b.at);
}

const mins = (at: number) => Math.max(0, Math.round((at - Date.now() / 1000) / 60));

function fmtArrival(a: Arrival, showRoute: boolean) {
  const m = mins(a.at);
  const when = m === 0 ? "прибывает" : `через ${m} мин`;
  return `${showRoute ? `${a.route} ` : ""}${when} (${mskTime(a.at)})`;
}

/** Сравнивает варианты дороги и возвращает готовый текст. */
export async function compareOptions(ctx: Ctx): Promise<string> {
  const stops = await ctx.store.listStops();
  if (!stops.length) return "Остановок нет — добавь их: /addstop";
  if (!ctx.env.RELAY_URL || !ctx.env.RELAY_SECRET) {
    return stops.map((s) => `— ${escapeHtml(stopTitle(s))}`).join("\n") +
      "\n\nПрогноз недоступен: не настроен посредник (RELAY_URL, RELAY_SECRET).";
  }

  const results = await Promise.all(
    stops.map(async (stop) => {
      if (!stop.orgp_id) return { stop, error: "не задан номер для прогноза (/editstop)" };
      try {
        return { stop, arrivals: await stopArrivals(ctx.env, stop) };
      } catch (e) {
        console.error("Прогноз остановки", stop.id, e);
        return { stop, error: "сайт транспорта не ответил" };
      }
    }),
  );

  // Лучший вариант: раньше всех окажешься в транспорте с учётом дороги пешком до остановки
  let best: { stop: Stop; a: Arrival } | null = null;
  const blocks = results.map((r) => {
    const s = r.stop;
    const multi = s.routes.includes(",");
    const head = `<b>${escapeHtml(KIND_NAME[s.kind] ?? s.kind)} ${escapeHtml(s.routes.split(",").join(", "))}</b>` +
      (s.walk_min ? ` (идти ${s.walk_min} мин)` : "");
    if (r.error) return `${head}\n${r.error}`;
    const reachable = r.arrivals!.filter((a) => a.at >= Date.now() / 1000 + s.walk_min * 60);
    const first = reachable[0];
    if (first && (!best || first.at < best.a.at)) best = { stop: s, a: first };
    if (!reachable.length) return `${head}\nпрогноза нет`;
    return `${head}\n${reachable.slice(0, 3).map((a) => fmtArrival(a, multi)).join(", ")}`;
  });

  const b = best as { stop: Stop; a: Arrival } | null;
  const verdict = b
    ? `<b>Быстрее всего: ${escapeHtml((KIND_NAME[b.stop.kind] ?? b.stop.kind).toLowerCase())} ${b.a.route}, ${mins(b.a.at) === 0 ? "уже прибывает" : `через ${mins(b.a.at)} мин`}.</b>`
    : "Прогноза прибытия сейчас нет — транспорт не ходит или не передаёт данные.";
  return `${verdict}\n\n${blocks.join("\n\n")}`;
}
