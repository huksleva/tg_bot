import { transit_realtime } from "gtfs-realtime-bindings";
import ROUTES from "./routes.json";
import type { Vehicle } from "./transport";

// Путь к ул. Шаврова рядом с остановкой 16644 (по shapes.txt, track-223527 и track-223589).
// Координаты точки на рельсах и уклон оси пути: около 0,3 м к северу на метр к западу.
const TRACK_LAT = 60.007294;
const TRACK_LON = 30.257072;
const MAX_POSITION_AGE = 30;

/** Учитывает GPS только рядом с остановкой и на пути в сторону ул. Шаврова. */
export function refineMetroTramForecast(
  forecast: Vehicle[] | null, payload: ArrayBuffer, now: number,
): Vehicle[] | null {
  const feed = transit_realtime.FeedMessage.decode(new Uint8Array(payload));
  const observed = new Map<string, Vehicle | null>();

  for (const entity of feed.entity) {
    const tram = entity.vehicle;
    if (!tram) continue;
    const [route, kind] = (ROUTES as Record<string, string[]>)[tram.trip?.routeId ?? ""] ?? [];
    const board = tram?.vehicle?.label;
    const pos = tram?.position;
    if (kind !== "tram" || (route !== "47" && route !== "55") || !board || !pos || tram.timestamp == null) continue;

    const age = now - Number(tram.timestamp);
    if (!(age >= -5 && age <= MAX_POSITION_AGE)) continue;
    const bearing = pos.bearing ?? 0;
    if (!(bearing >= 240 && bearing <= 325)) continue;

    const west = (TRACK_LON - pos.longitude) * 55_600;
    const north = (pos.latitude - TRACK_LAT) * 111_200;
    if (!Number.isFinite(west + north) || Math.abs(north - 0.3 * west) > 24) continue;
    const key = `${route}:${board}`;
    if (west >= -135 && west <= 12) {
      const seconds = Math.max(15, Math.ceil(-west / 2.5 - Math.max(age, 0)));
      observed.set(key, { route, at: now + seconds, vehicle: board, gps: true });
    } else if (west >= 70 && west <= 145) {
      observed.set(key, null); // вагон уже за платформой
    }
  }

  if (!observed.size) return forecast;
  const remaining = (forecast ?? []).filter((v) => !observed.has(`${v.route}:${v.vehicle}`));
  const approaching = [...observed.values()].filter((v): v is Vehicle => v !== null);
  return [...remaining, ...approaching].sort((a, b) => a.at - b.at);
}
