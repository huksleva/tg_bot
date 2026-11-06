/** Расписание РГПУ им. Герцена: guide.herzen.spb.ru */

export interface DayClasses {
  date: string; // YYYY-MM-DD
  start: string; // начало первой пары, HH:MM
  end: string; // конец последней пары, HH:MM
  count: number; // сколько пар
}

const toMin = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};

export interface Lesson {
  start: string;
  end: string;
  name?: string; // предмет
  type?: string; // лекц / лаб / практ
  room?: string;
  teacher?: string;
}

/** Строка из JSON со \uXXXX -> обычный текст. */
const unjson = (s: string) => {
  try {
    return (JSON.parse(`"${s}"`) as string).replace(/\s+/g, " ").trim();
  } catch {
    return s.trim();
  }
};

/**
 * Пары на указанную дату со всеми подробностями.
 * Данные лежат в атрибуте wire:snapshot в виде экранированного JSON:
 *   SCHEDULE_DATE&quot;:&quot;2026-11-06&quot;,...,TIME_START&quot;:&quot;15:10&quot;,TIME_END&quot;:&quot;16:40&quot;,ROWS:[...]
 * Ищем через indexOf, а не регуляркой по всей странице — страница большая (~800 КБ),
 * а на бесплатном тарифе у Worker всего 10 мс процессорного времени.
 */
export function parseLessons(html: string, date: string): Lesson[] {
  const marker = `SCHEDULE_DATE&quot;:&quot;${date}&quot;`;
  const byTime = new Map<string, Lesson>();
  for (let i = html.indexOf(marker); i !== -1; i = html.indexOf(marker, i + marker.length)) {
    const chunk = html.slice(i, i + 4000).replace(/&quot;/g, '"');
    const t = chunk.match(/^[^{}]{0,200}?"TIME_START":"(\d{1,2}:\d{2})","TIME_END":"(\d{1,2}:\d{2})"/);
    if (!t) continue; // это запись внутри ROWS, а не заголовок пары
    const key = `${t[1]}-${t[2]}`;
    if (byTime.has(key)) continue;
    // Подробности — до следующей пары
    const next = chunk.indexOf('"TIME_START"', t[0].length);
    const body = next === -1 ? chunk : chunk.slice(0, next);
    const field = (f: string) => {
      const m = body.match(new RegExp(`"${f}":"((?:[^"\\\\]|\\\\.)*)"`));
      return m ? unjson(m[1]) : undefined;
    };
    byTime.set(key, {
      start: t[1],
      end: t[2],
      name: field("NAMEDISC"),
      type: field("LECTYPE"),
      room: field("ROOM_NAME"),
      teacher: field("FIO"),
    });
  }
  const lessons = [...byTime.values()];
  if (!lessons.length) {
    return parseTimesVisible(html, date).map(([start, end]) => ({ start, end }));
  }
  return lessons.sort((a, b) => toMin(a.start) - toMin(b.start));
}

/** Начало первой и конец последней пары на дату. */
export function parseDay(html: string, date: string): DayClasses | null {
  const lessons = parseLessons(html, date);
  return lessons.length ? summarize(date, lessons.map((l) => [l.start, l.end])) : null;
}

/** Запасной вариант: видимый текст «6.11.2026, пятница ... 15:10-16:40». */
function parseTimesVisible(html: string, date: string): [string, string][] {
  const [y, mo, d] = date.split("-").map(Number);
  // Видимый заголовок: «7.11.2026, суббота» — после запятой русская буква
  // (в служебных данных там с..., их пропускаем)
  const re = new RegExp(`(?<![\\d.])${d}\\.${mo}\\.${y},\\s*[а-яё]`, "i");
  const found = re.exec(html);
  if (!found) return [];
  // До заголовка следующего дня
  const rest = html.slice(found.index + found[0].length, found.index + 60000);
  const next = rest.search(/(?<![\d.])\d{1,2}\.\d{1,2}\.\d{4},\s*[а-яё]/i);
  const day = next === -1 ? rest : rest.slice(0, next);
  return [...day.matchAll(/(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})/g)].map(
    (m) => [m[1], m[2]] as [string, string],
  );
}

function summarize(date: string, times: [string, string][]): DayClasses {
  const uniq = new Map(times.map(([s, e]) => [`${s}-${e}`, [s, e] as [string, string]]));
  const list = [...uniq.values()];
  const start = list.reduce((a, [s]) => (toMin(s) < toMin(a) ? s : a), list[0][0]);
  const end = list.reduce((a, [, e]) => (toMin(e) > toMin(a) ? e : a), list[0][1]);
  return { date, start, end, count: list.length };
}

async function fetchPage(groupId: number) {
  const res = await fetch(`https://guide.herzen.spb.ru/schedule/${groupId}/by-dates`, {
    headers: { "User-Agent": "Mozilla/5.0 (OtrokBatrakanBot)" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Расписание: HTTP ${res.status}`);
  return res.text();
}

export async function fetchDay(groupId: number, date: string): Promise<DayClasses | null> {
  return parseDay(await fetchPage(groupId), date);
}

export async function fetchLessons(groupId: number, date: string): Promise<Lesson[]> {
  return parseLessons(await fetchPage(groupId), date);
}

const WEEKDAYS = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];

/** «2026-11-07» -> «7.11, суббота» */
export function humanDate(date: string) {
  const [y, mo, d] = date.split("-").map(Number);
  return `${d}.${String(mo).padStart(2, "0")}, ${WEEKDAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()]}`;
}

// --- Время по Москве (UTC+3 круглый год) ---

const MSK = 3 * 3600;

/** Дата по Москве в формате YYYY-MM-DD. */
export const mskDate = (unix: number) => new Date((unix + MSK) * 1000).toISOString().slice(0, 10);

/** Час по Москве. */
export const mskHour = (unix: number) => new Date((unix + MSK) * 1000).getUTCHours();

/** «2026-11-06» + «16:40» по Москве -> unix-время. */
export function mskToUnix(date: string, time: string) {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, m] = time.split(":").map(Number);
  return Date.UTC(y, mo - 1, d, h, m) / 1000 - MSK;
}

/** unix-время -> «16:40» по Москве. */
export const mskTime = (unix: number) => new Date((unix + MSK) * 1000).toISOString().slice(11, 16);
