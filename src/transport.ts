import type { Env } from "./env";

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
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Посредник: HTTP ${res.status}`);
  return res;
}

/** Сравнивает варианты дороги и возвращает готовый текст. */
export async function compareOptions(env: Env): Promise<string> {
  if (!env.RELAY_URL || !env.RELAY_SECRET) {
    return "Прогноз автобуса 258 и трамваев 47/55 появится, когда заработает посредник в Яндекс.Облаке.";
  }
  // Подключается после настройки посредника: нужны ID остановок и формат прогноза
  return "Посредник подключён, прогноз транспорта скоро будет.";
}
