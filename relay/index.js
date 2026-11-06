/**
 * Посредник для бота: функция Yandex Cloud Functions (Node.js 22).
 *
 * Сайт transport.orgp.spb.ru отвечает только российским адресам, а Cloudflare —
 * не российский. Функция в Яндекс.Облаке ходит туда сама и отдаёт ответ боту.
 *
 * Переменная окружения функции: RELAY_SECRET — тот же пароль, что у бота в Cloudflare.
 * Код выкладывается сам через GitHub Actions (.github/workflows/relay.yml) — руками не редактировать.
 *
 * Режимы:
 *   ?path=/Portal/transport/internalapi/...   — переслать запрос как есть
 *   ?gtfs=stops.txt&q=Комендантский&q=...     — найти строки в справочнике GTFS
 *                                               (feed.zip слишком большой, чтобы отдать целиком)
 */
const zlib = require("node:zlib");

// Сайт может быть на сертификате российского УЦ, которому Node.js не доверяет.
// Тогда пробуем обычный HTTP: данные о транспорте публичные и не секретные.
const ORIGINS = ["https://transport.orgp.spb.ru", "http://transport.orgp.spb.ru"];
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
    if (one("probe")) return await probe();
    if (one("gtfs")) return await gtfsLookup(one("gtfs"), q.q || [], Number(one("limit")) || MAX_LINES);

    const path = one("path") || "";
    if (!path.startsWith(ALLOWED_PREFIX)) return text(400, "path must start with " + ALLOWED_PREFIX);
    const res = await orgpFetch(path, 15000);
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      statusCode: res.status,
      headers: { "Content-Type": res.headers.get("content-type") || "application/octet-stream" },
      body: buf.toString("base64"),
      isBase64Encoded: true,
    };
  } catch (e) {
    return text(502, "relay error: " + describe(e));
  }
};

function text(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "text/plain; charset=utf-8" }, body };
}

/** Диагностика: какие адреса доступны из облака (фиксированный список). */
async function probe() {
  const targets = [
    "https://ya.ru/",
    "https://transport.orgp.spb.ru/",
    "http://transport.orgp.spb.ru/",
    "https://spb-transport.gate.petersburg.ru/",
    "https://petersburg.ru/",
    "https://guide.herzen.spb.ru/",
  ];
  const lines = await Promise.all(targets.map(async (u) => {
    const t = Date.now();
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(8000), redirect: "manual" });
      return `${u} -> ${r.status} за ${Date.now() - t} мс`;
    } catch (e) {
      return `${u} -> ОШИБКА ${describe(e)} за ${Date.now() - t} мс`;
    }
  }));
  lines.push(await certInfo("transport.orgp.spb.ru"));
  return text(200, lines.join("\n"));
}

/** Кто выдал сертификат сайта и где взять промежуточный (AIA). */
function certInfo(host) {
  const tls = require("node:tls");
  return new Promise((resolve) => {
    const sock = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: false }, () => {
      const c = sock.getPeerCertificate(true);
      const out = [];
      let cur = c, depth = 0;
      while (cur && depth < 4) {
        out.push(`[${depth}] subject=${cur.subject && cur.subject.CN} issuer=${cur.issuer && cur.issuer.CN} O=${cur.issuer && cur.issuer.O} aia=${(cur.infoAccess && JSON.stringify(cur.infoAccess)) || "-"} till=${cur.valid_to}`);
        if (!cur.issuerCertificate || cur.issuerCertificate === cur) break;
        cur = cur.issuerCertificate; depth++;
      }
      sock.end();
      resolve("cert:\n" + out.join("\n"));
    });
    sock.setTimeout(8000, () => { sock.destroy(); resolve("cert: timeout"); });
    sock.on("error", (e) => resolve("cert: " + describe(e)));
  });
}

/** Запрос к сайту транспорта: сначала HTTPS, при сетевой ошибке — HTTP. */
async function orgpFetch(path, timeoutMs) {
  const errors = [];
  for (const origin of ORIGINS) {
    try {
      return await fetch(origin + path, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      errors.push(origin.split(":")[0] + ": " + describe(e));
    }
  }
  throw new Error(errors.join("; "));
}

/** Текст ошибки вместе с её причиной (fetch прячет её в cause). */
function describe(e) {
  if (!e) return "unknown";
  const cause = e.cause ? ` (${e.cause.code || ""} ${e.cause.message || e.cause})` : "";
  return `${e.message}${cause}`;
}

async function loadFeed() {
  if (feedCache && Date.now() - feedCache.at < 6 * 3600 * 1000) return feedCache.buf;
  const res = await orgpFetch(FEED, 50000);
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
