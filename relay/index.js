/**
 * Посредник для бота: функция Yandex Cloud Functions (Node.js 22).
 *
 * Сайт transport.orgp.spb.ru отвечает только российским адресам, а Cloudflare —
 * не российский. Функция в Яндекс.Облаке ходит туда сама и отдаёт ответ боту.
 *
 * Переменная окружения функции: RELAY_SECRET — тот же пароль, что у бота в Cloudflare.
 *
 * Режимы:
 *   ?path=/Portal/transport/internalapi/...   — переслать запрос как есть
 *   ?gtfs=stops.txt&q=Комендантский&q=...     — найти строки в справочнике GTFS
 *                                               (feed.zip слишком большой, чтобы отдать целиком)
 */
const zlib = require("node:zlib");

const ORIGIN = "https://transport.orgp.spb.ru";
const ALLOWED_PREFIX = "/Portal/transport/internalapi/";
const FEED = "/Portal/transport/internalapi/gtfs/feed.zip";
const MAX_LINES = 2000;

let feedCache = null; // { buf, at } — живёт, пока жив экземпляр функции

module.exports.handler = async (event) => {
  const headers = event.headers || {};
  const secret = headers["X-Relay-Secret"] || headers["x-relay-secret"];
  if (!process.env.RELAY_SECRET || secret !== process.env.RELAY_SECRET) {
    return text(403, "Forbidden");
  }

  const q = event.multiValueQueryStringParameters || {};
  const one = (k) => (q[k] && q[k][0]) || (event.queryStringParameters || {})[k];

  try {
    if (one("gtfs")) return await gtfsLookup(one("gtfs"), q.q || [], Number(one("limit")) || MAX_LINES);

    const path = one("path") || "";
    if (!path.startsWith(ALLOWED_PREFIX)) return text(400, "path must start with " + ALLOWED_PREFIX);
    const res = await fetch(ORIGIN + path, { signal: AbortSignal.timeout(15000) });
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      statusCode: res.status,
      headers: { "Content-Type": res.headers.get("content-type") || "application/octet-stream" },
      body: buf.toString("base64"),
      isBase64Encoded: true,
    };
  } catch (e) {
    return text(502, "relay error: " + (e && e.message));
  }
};

function text(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "text/plain; charset=utf-8" }, body };
}

async function loadFeed() {
  if (feedCache && Date.now() - feedCache.at < 6 * 3600 * 1000) return feedCache.buf;
  const res = await fetch(ORIGIN + FEED, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error("feed.zip HTTP " + res.status);
  feedCache = { buf: Buffer.from(await res.arrayBuffer()), at: Date.now() };
  return feedCache.buf;
}

/** Возвращает заголовок файла и строки, где встречается хотя бы одна из подстрок q. */
async function gtfsLookup(file, needles, limit) {
  const zip = await loadFeed();
  const entry = findEntry(zip, file);
  if (!entry) return text(404, "no such file in feed: " + file);

  const lines = [];
  let header = null;
  let tail = "";
  let total = 0;
  await new Promise((resolve, reject) => {
    const src = zip.subarray(entry.dataStart, entry.dataStart + entry.compSize);
    const inflate = entry.method === 8 ? zlib.createInflateRaw() : null;
    const onData = (chunk) => {
      const parts = (tail + chunk.toString("utf8")).split("\n");
      tail = parts.pop();
      for (const line of parts) take(line);
    };
    const take = (line) => {
      if (header === null) { header = line; return; }
      total++;
      if (lines.length < limit && (needles.length === 0 || needles.some((n) => line.includes(n)))) {
        lines.push(line);
      }
    };
    if (!inflate) { onData(src); take(tail); return resolve(); }
    inflate.on("data", onData);
    inflate.on("end", () => { if (tail) take(tail); resolve(); });
    inflate.on("error", reject);
    inflate.end(src);
  });
  return text(200, [header, ...lines, `# matched ${lines.length} of ${total}`].join("\n"));
}

/** Минимальный разбор zip: ищем файл в центральном каталоге. */
function findEntry(zip, name) {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("bad zip");
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    const method = zip.readUInt16LE(p + 10);
    const compSize = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const fname = zip.toString("utf8", p + 46, p + 46 + nameLen);
    if (fname === name || fname.endsWith("/" + name)) {
      const lNameLen = zip.readUInt16LE(local + 26);
      const lExtraLen = zip.readUInt16LE(local + 28);
      return { method, compSize, dataStart: local + 30 + lNameLen + lExtraLen };
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}
