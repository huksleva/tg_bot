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

const https = require("node:https");

const HOST = "transport.orgp.spb.ru";

// У сайта сертификат Национального удостоверяющего центра Минцифры, которому Node.js
// не доверяет, к тому же сервер не присылает промежуточный сертификат. Поэтому для
// запросов к ЭТОМУ сайту доверяем только этим двум сертификатам (больше нигде).
// Источник: http://nuc-cdp.digital.gov.ru/cdp/ (rootca_ssl_rsa2022.crt, subca_ssl_rsa2024.crt)
// SHA-256 корневого: D2:6D:2D:02:31:B7:C3:9F:92:CC:73:85:12:BA:54:10:35:19:E4:40:5D:68:B5:BD:70:3E:97:88:CA:8E:CF:31
const RUSSIAN_TRUSTED_ROOT_CA = `-----BEGIN CERTIFICATE-----
MIIFwjCCA6qgAwIBAgICEAAwDQYJKoZIhvcNAQELBQAwcDELMAkGA1UEBhMCUlUx
PzA9BgNVBAoMNlRoZSBNaW5pc3RyeSBvZiBEaWdpdGFsIERldmVsb3BtZW50IGFu
ZCBDb21tdW5pY2F0aW9uczEgMB4GA1UEAwwXUnVzc2lhbiBUcnVzdGVkIFJvb3Qg
Q0EwHhcNMjIwMzAxMjEwNDE1WhcNMzIwMjI3MjEwNDE1WjBwMQswCQYDVQQGEwJS
VTE/MD0GA1UECgw2VGhlIE1pbmlzdHJ5IG9mIERpZ2l0YWwgRGV2ZWxvcG1lbnQg
YW5kIENvbW11bmljYXRpb25zMSAwHgYDVQQDDBdSdXNzaWFuIFRydXN0ZWQgUm9v
dCBDQTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBAMfFOZ8pUAL3+r2n
qqE0Zp52selXsKGFYoG0GM5bwz1bSFtCt+AZQMhkWQheI3poZAToYJu69pHLKS6Q
XBiwBC1cvzYmUYKMYZC7jE5YhEU2bSL0mX7NaMxMDmH2/NwuOVRj8OImVa5s1F4U
zn4Kv3PFlDBjjSjXKVY9kmjUBsXQrIHeaqmUIsPIlNWUnimXS0I0abExqkbdrXbX
YwCOXhOO2pDUx3ckmJlCMUGacUTnylyQW2VsJIyIGA8V0xzdaeUXg0VZ6ZmNUr5Y
Ber/EAOLPb8NYpsAhJe2mXjMB/J9HNsoFMBFJ0lLOT/+dQvjbdRZoOT8eqJpWnVD
U+QL/qEZnz57N88OWM3rabJkRNdU/Z7x5SFIM9FrqtN8xewsiBWBI0K6XFuOBOTD
4V08o4TzJ8+Ccq5XlCUW2L48pZNCYuBDfBh7FxkB7qDgGDiaftEkZZfApRg2E+M9
G8wkNKTPLDc4wH0FDTijhgxR3Y4PiS1HL2Zhw7bD3CbslmEGgfnnZojNkJtcLeBH
BLa52/dSwNU4WWLubaYSiAmA9IUMX1/RpfpxOxd4Ykmhz97oFbUaDJFipIggx5sX
ePAlkTdWnv+RWBxlJwMQ25oEHmRguNYf4Zr/Rxr9cS93Y+mdXIZaBEE0KS2iLRqa
OiWBki9IMQU4phqPOBAaG7A+eP8PAgMBAAGjZjBkMB0GA1UdDgQWBBTh0YHlzlpf
BKrS6badZrHF+qwshzAfBgNVHSMEGDAWgBTh0YHlzlpfBKrS6badZrHF+qwshzAS
BgNVHRMBAf8ECDAGAQH/AgEEMA4GA1UdDwEB/wQEAwIBhjANBgkqhkiG9w0BAQsF
AAOCAgEAALIY1wkilt/urfEVM5vKzr6utOeDWCUczmWX/RX4ljpRdgF+5fAIS4vH
tmXkqpSCOVeWUrJV9QvZn6L227ZwuE15cWi8DCDal3Ue90WgAJJZMfTshN4OI8cq
W9E4EG9wglbEtMnObHlms8F3CHmrw3k6KmUkWGoa+/ENmcVl68u/cMRl1JbW2bM+
/3A+SAg2c6iPDlehczKx2oa95QW0SkPPWGuNA/CE8CpyANIhu9XFrj3RQ3EqeRcS
AQQod1RNuHpfETLU/A2gMmvn/w/sx7TB3W5BPs6rprOA37tutPq9u6FTZOcG1Oqj
C/B7yTqgI7rbyvox7DEXoX7rIiEqyNNUguTk/u3SZ4VXE2kmxdmSh3TQvybfbnXV
4JbCZVaqiZraqc7oZMnRoWrXRG3ztbnbes/9qhRGI7PqXqeKJBztxRTEVj8ONs1d
WN5szTwaPIvhkhO3CO5ErU2rVdUr89wKpNXbBODFKRtgxUT70YpmJ46VVaqdAhOZ
D9EUUn4YaeLaS8AjSF/h7UkjOibNc4qVDiPP+rkehFWM66PVnP1Msh93tc+taIfC
EYVMxjh8zNbFuoc7fzvvrFILLe7ifvEIUqSVIC/AzplM/Jxw7buXFeGP1qVCBEHq
391d/9RAfaZ12zkwFsl+IKwE/OZxW8AHa9i1p4GO0YSNuczzEm4=
-----END CERTIFICATE-----`;
const RUSSIAN_TRUSTED_SUB_CA = `-----BEGIN CERTIFICATE-----
MIIG6DCCBNCgAwIBAgICEAUwDQYJKoZIhvcNAQELBQAwcDELMAkGA1UEBhMCUlUx
PzA9BgNVBAoMNlRoZSBNaW5pc3RyeSBvZiBEaWdpdGFsIERldmVsb3BtZW50IGFu
ZCBDb21tdW5pY2F0aW9uczEgMB4GA1UEAwwXUnVzc2lhbiBUcnVzdGVkIFJvb3Qg
Q0EwHhcNMjQwNzE1MTI1MDQxWhcNMjkwNzE5MTI1MDQxWjBvMQswCQYDVQQGEwJS
VTE/MD0GA1UECgw2VGhlIE1pbmlzdHJ5IG9mIERpZ2l0YWwgRGV2ZWxvcG1lbnQg
YW5kIENvbW11bmljYXRpb25zMR8wHQYDVQQDDBZSdXNzaWFuIFRydXN0ZWQgU3Vi
IENBMIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEA1j0rkZECOt1S8o7I
JY+4YKAxuEa5xaHKHXT2EpkuC/0krqMOjUy2oPIRNgR5g8X0Jl6jamxeGLc4Q1tf
ju6or9oSRYThIUhRsFDQNBiBBEXoBgWxTfiKB2eyT97+pz5TBtBiRCPaLGRHYLRb
9Jz2HkJlxbtNPjtDrF5DPHym+mZ1M1z3hIQYAqJwLpsEBnsw/VxWMlxqHoeewd0h
uJMd71KQ5vOKlz7KrIZ6EobNNa6wItuvsfj3kYCK7O78uLHGXXFxdr8Hae9lMUmC
8F7AFwa+bO1LRlTlqW7rE3rLf+jj70N01N8T3o22v14YBaFBWQWncAVYD2JuL3tH
252+kdNOERf1fLbLRigJAbd+hOhWYlNf963TFDgnNPliHNIW72SygVBnI2V3JwO1
dp1hVKpK/zt8ziGdHW4gmOLTsH50YKdR4jNqUgQv4wASlKn9OpN6zHYc5G8h86fY
BM+zxE5ikGI+I/vIqBuI0eaDU92AWN/YjFLpu8tMu9kLRSCf1vug6FIfDPWVo7iP
ac/SI2v8jnnpaW7ph/Pz3WkzaG7ZZJsfFs+8dploWc6LOoDtbFBhMdGMxu024msC
0PSjZb5ODXPIaO2NsA7fMiAtZcoK6anTUJh4zOP/stA9qsJGNxdrEmiPXSmBZY/N
Y0wkZgZ6JTDhw7038bPvctkblJkCAwEAAaOCAYswggGHMB0GA1UdDgQWBBR3Pdk5
r0K93FvKduru/c4+YSkwXzAfBgNVHSMEGDAWgBTh0YHlzlpfBKrS6badZrHF+qws
hzAOBgNVHQ8BAf8EBAMCAYYwEgYDVR0TAQH/BAgwBgEB/wIBADCBmAYIKwYBBQUH
AQEEgYswgYgwQAYIKwYBBQUHMAKGNGh0dHA6Ly9udWMtY2RwLnZvc2tob2QucnUv
Y2RwL3Jvb3RjYV9zc2xfcnNhMjAyMi5jcnQwRAYIKwYBBQUHMAKGOGh0dHA6Ly9u
dWMtY2RwLmRpZ2l0YWwuZ292LnJ1L2NkcC9yb290Y2Ffc3NsX3JzYTIwMjIuY3J0
MIGFBgNVHR8EfjB8MDqgOKA2hjRodHRwOi8vbnVjLWNkcC52b3NraG9kLnJ1L2Nk
cC9yb290Y2Ffc3NsX3JzYTIwMjIuY3JsMD6gPKA6hjhodHRwOi8vbnVjLWNkcC5k
aWdpdGFsLmdvdi5ydS9jZHAvcm9vdGNhX3NzbF9yc2EyMDIyLmNybDANBgkqhkiG
9w0BAQsFAAOCAgEAmsINXtQ7wwUWvIeOr80MdJS/5G4xhyZOVEmeUorThquT672y
cCg3XCxc4fwbiZqSSbBqntQ7RtiTAKMYMvBageKoVHbzz+R4jX01tKcTx8cDePrz
dJ73bLNUorE7RU9QsW4KyiUeRmjMDV23AUlEvuQFTwgkHXvbac1BBdPn9CrssQuF
5EGohZKcQPFiAAc4SHbRNhlr7uAwgpc/erzI9EAcvA6BVAXcVKoeGpV01uexUgZ6
St5RP9UmDWNA7T4yVXWJ233N0Q8bl+6AswINQ3PosPu6yQQHQjr65YS06epK+AeI
6j+oGR4xI7EhTQhQvaobnGmX/8QQ7XDRYCP2HXYxiffnn/CfZ/BVyKLYeY1ZipjE
nzqdQIC2+Q3WtY8jsVRQMP38WFRmtsIt5snehnPTs5bKGVIcYzj3o3Ex/K7agEz0
zAJ0JR5ivXZOvNkT0g9x1v+S1IkU3e/nX1a+tpRquMtnHX0L2lXArNHUbaOO9EJt
d57WaIpofV5cVhhwShOgAuBc9UMJF3/n4t4RKiPxtsK8P67gcmphMhslj7AMYrYM
ej2NvQZY4m3ub3CPC/PrTjDONvb+8g5xrKtxBjYqC74HSB4dg9G3WimSDUuP2Su6
G2y2TUeyJuCvCLz289VoO0vg7cNdMobE3KCqAiiNhN2VBFxHAUKmUoRcRdw=
-----END CERTIFICATE-----`;
const orgpAgent = new https.Agent({ ca: [RUSSIAN_TRUSTED_ROOT_CA, RUSSIAN_TRUSTED_SUB_CA], keepAlive: true });
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
    const res = await orgpFetch(path, 7000, 3);
    return {
      statusCode: res.status,
      headers: { "Content-Type": res.type || "application/octet-stream" },
      body: res.body.toString("base64"),
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
  try {
    const r = await orgpFetch("/Portal/transport/internalapi/gtfs/realtime/vehicle?transports=tram", 7000, 3);
    lines.push(`orgp через доверенный сертификат -> ${r.status}, ${r.body.length} байт`);
  } catch (e) {
    lines.push(`orgp через доверенный сертификат -> ОШИБКА ${describe(e)}`);
  }
  return text(200, lines.join("\n"));
}

/** Один GET к сайту транспорта. */
function orgpGet(path, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      { host: HOST, path, agent: orgpAgent, headers: { "User-Agent": "OtrokBatrakanBot/1.0" } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          clearTimeout(timer);
          resolve({ status: res.statusCode, type: res.headers["content-type"], body: Buffer.concat(chunks) });
        });
        res.on("error", reject);
      },
    );
    const timer = setTimeout(() => req.destroy(new Error(`timeout ${timeoutMs} ms`)), timeoutMs);
    req.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

/** Запрос с повторами: сайт иногда не отвечает с первого раза. */
async function orgpFetch(path, timeoutMs, attempts) {
  const errors = [];
  for (let i = 1; i <= attempts; i++) {
    try {
      return await orgpGet(path, timeoutMs);
    } catch (e) {
      errors.push(`попытка ${i}: ${describe(e)}`);
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
  const res = await orgpFetch(FEED, 55000, 1); // большой файл: одна попытка почти на весь лимит функции
  if (res.status !== 200) throw new Error("feed.zip HTTP " + res.status);
  feedCache = { buf: res.body, at: Date.now() };
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
