// Координаты района для погодной сетки Open-Meteo.
const forecastUrl = "https://api.open-meteo.com/v1/forecast?latitude=60.03&longitude=30.21&current=temperature_2m";
const degrees = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1, signDisplay: "exceptZero" });

/** Текущая температура воздуха рядом с домом. */
export async function homeTemperature(): Promise<string> {
  try {
    const response = await fetch(forecastUrl, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Open-Meteo: HTTP ${response.status}`);
    const data = (await response.json()) as { current?: { temperature_2m?: unknown } };
    const temperature = data.current?.temperature_2m;
    if (typeof temperature !== "number" || !Number.isFinite(temperature)) {
      throw new Error("Open-Meteo: в ответе нет температуры");
    }
    return `<b>У дома сейчас ${degrees.format(temperature)} °C.</b>\nДанные Open-Meteo.`;
  } catch (error) {
    console.error("Температура у дома", error);
    return "Температура у дома сейчас недоступна. Попробуй чуть позже.";
  }
}
