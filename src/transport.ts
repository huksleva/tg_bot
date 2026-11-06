import type { Ctx } from "./bot";
import type { Env } from "./env";
import { stopTitle } from "./stops";
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

/** Сравнивает варианты дороги и возвращает готовый текст. */
export async function compareOptions(ctx: Ctx): Promise<string> {
  const stops = await ctx.store.listStops();
  if (!stops.length) return "Остановок нет — добавь их: /addstop";
  const list = stops.map((s) => `— ${escapeHtml(stopTitle(s))}`).join("\n");
  if (!ctx.env.RELAY_URL || !ctx.env.RELAY_SECRET) {
    return `${list}\n\nПрогноз прибытия появится, когда заработает посредник в Яндекс.Облаке.`;
  }
  // Подключается после настройки посредника: нужны номера остановок и формат прогноза
  return `${list}\n\nПосредник подключён, прогноз транспорта скоро будет.`;
}
