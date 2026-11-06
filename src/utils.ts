const UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

/** '1h30m' -> 5400 секунд; null, если формат неверный. */
export function parseDuration(raw: string): number | null {
  const s = raw.toLowerCase();
  if (!/^(\d+[smhd])+$/.test(s)) return null;
  let total = 0;
  for (const [, n, u] of s.matchAll(/(\d+)([smhd])/g)) total += Number(n) * UNITS[u];
  return total > 0 ? total : null;
}

/** Разбирает «/cmd@bot аргументы» -> { cmd: "cmd", args: "аргументы" }. */
export function parseCommand(text: string): { cmd: string; args: string } | null {
  const m = text.match(/^\/([a-zA-Z0-9_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
  return m ? { cmd: m[1].toLowerCase(), args: (m[2] ?? "").trim() } : null;
}

export function formatTime(unix: number, tz = "Europe/Moscow", withSeconds = false) {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: tz,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: withSeconds ? "2-digit" : undefined,
  }).format(new Date(unix * 1000));
}

export const randInt = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo + 1));
export const coin = () => (Math.random() < 0.5 ? "🦅 Орёл" : "🔘 Решка");
