import { transit_realtime } from "gtfs-realtime-bindings";
import { Reader } from "protobufjs/minimal";
import ROUTES from "./routes.json";
import type { Vehicle } from "./transport";

// Путь к ул. Шаврова рядом с остановкой 16644 (по shapes.txt, track-223527 и track-223589).
// Координаты точки на рельсах и уклон оси пути: около 0,3 м к северу на метр к западу.
const TRACK_LAT = 60.007294;
const TRACK_LON = 30.257072;
const MAX_ROUTE_POSITION_AGE = 90;
const MAX_NEARBY_POSITION_AGE = 30;
const decoder = new TextDecoder();
const routeIds = ROUTES as Record<string, string[] | undefined>;

export interface GpsReport {
  counts: Map<string, number>;
  metroTrams: Map<string, Map<string, Vehicle | null>>;
}

export const gpsRouteKey = (kind: string, route: string) => `${kind}:${route}`;

function messageEnd(reader: Reader, limit: number) {
  const length = reader.uint32();
  const end = reader.pos + length;
  if (end > limit) throw new Error("Некорректная длина поля GTFS Realtime");
  return end;
}

/** Ищет поле с заданным номером и оставляет курсор на начале вложенного сообщения. */
function findMessage(reader: Reader, end: number, field: number): number | undefined {
  while (reader.pos < end) {
    const tag = reader.uint32();
    if (tag === ((field << 3) | 2)) return messageEnd(reader, end);
    reader.skipType(tag & 7);
  }
}

function entityRoute(reader: Reader, end: number) {
  // FeedEntity.vehicle → VehiclePosition.trip → TripDescriptor.route_id.
  const vehicle = findMessage(reader, end, 4);
  const trip = vehicle === undefined ? undefined : findMessage(reader, vehicle, 1);
  const route = trip === undefined ? undefined : findMessage(reader, trip, 5);
  return route === undefined ? undefined : routeIds[decoder.decode(reader.buf.subarray(reader.pos, route))];
}

/** Считает свежие отметки на маршрутах. Для 47/55 отдельно проверяет путь рядом с метро. */
export function readGpsReport(payload: ArrayBuffer, routes: Set<string>, now: number): GpsReport | null {
  const reader = Reader.create(new Uint8Array(payload));
  const vehicles = new Map<string, Set<string>>();
  const metroTrams: GpsReport["metroTrams"] = new Map();
  let hasHeader = false;

  // В городском потоке тысячи машин. Разбираем целиком только записи нужных маршрутов.
  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    if (tag === 10) { // FeedMessage.header
      const end = messageEnd(reader, reader.len);
      const header = transit_realtime.FeedHeader.decode(reader, end - reader.pos);
      if (header.timestamp != null && now - Number(header.timestamp) > MAX_ROUTE_POSITION_AGE) return null;
      hasHeader = true;
      continue;
    }
    if (tag !== 18) { // FeedMessage.entity
      reader.skipType(tag & 7);
      continue;
    }
    const end = messageEnd(reader, reader.len);
    const start = reader.pos;
    const routeInfo = entityRoute(reader, end);
    reader.pos = end;
    if (!routeInfo) continue;
    const [route, kind] = routeInfo;
    const routeKey = gpsRouteKey(kind, route);
    if (!routes.has(routeKey)) continue;
    reader.pos = start;
    const entity = transit_realtime.FeedEntity.decode(reader, end - start);
    const reading = entity.vehicle;
    const pos = reading?.position;
    if (!pos || reading.timestamp == null) continue;

    const age = now - Number(reading.timestamp);
    if (!(age >= -5 && age <= MAX_ROUTE_POSITION_AGE) || !Number.isFinite(pos.latitude + pos.longitude)) continue;
    const board = reading.vehicle?.label;
    const ids = vehicles.get(routeKey) ?? new Set<string>();
    ids.add(reading.vehicle?.id || board || entity.id);
    vehicles.set(routeKey, ids);

    if (kind !== "tram" || (route !== "47" && route !== "55") || !board || age > MAX_NEARBY_POSITION_AGE) continue;
    const bearing = pos.bearing ?? 0;
    if (!(bearing >= 240 && bearing <= 325)) continue;

    const west = (TRACK_LON - pos.longitude) * 55_600;
    const north = (pos.latitude - TRACK_LAT) * 111_200;
    if (Math.abs(north - 0.3 * west) > 24) continue;
    const observed = metroTrams.get(route) ?? new Map<string, Vehicle | null>();
    if (west >= -135 && west <= 12) {
      const seconds = Math.max(15, Math.ceil(-west / 2.5 - Math.max(age, 0)));
      observed.set(board, { route, at: now + seconds, vehicle: board, gps: true });
    } else if (west >= 70 && west <= 145) {
      observed.set(board, null); // вагон уже за платформой
    }
    if (observed.size) metroTrams.set(route, observed);
  }

  return hasHeader ? { counts: new Map([...vehicles].map(([key, ids]) => [key, ids.size])), metroTrams } : null;
}
