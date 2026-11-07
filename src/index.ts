import type { Env } from "./env";
import { Ctx, handleUpdate } from "./bot";
import { runCommute } from "./commute";
import { observeStops } from "./transport";
import { runTiktok } from "./tiktok";
import { ensureSchema } from "./db";
import type { Update } from "./telegram";
import { COMMANDS, DESCRIPTION, SHORT_DESCRIPTION } from "./texts";

export default {
  async fetch(request, env, _ctx): Promise<Response> {
    const url = new URL(request.url);

    // Ручная настройка: вебхук, меню команд, описание. Нужна только после смены
    // токена или секрета — меню и описание бот обновляет сам (см. syncProfile).
    // Открыть в браузере: https://<worker>/setup?secret=<WEBHOOK_SECRET>
    if (url.pathname === "/setup") {
      if (url.searchParams.get("secret") !== env.WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
      return setup(new Ctx(env, url.origin));
    }

    if (request.method !== "POST") {
      return new Response("Отрок Батракан на посту");
    }

    // Принимаем только запросы от Telegram
    if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
      return new Response("Forbidden", { status: 403 });
    }

    const update = (await request.json()) as Update;
    try {
      await ensureSchema(env.DB);
      await handleUpdate(new Ctx(env, url.origin), update);
    } catch (e) {
      // Отвечаем 200 в любом случае, иначе Telegram будет бесконечно повторять апдейт
      console.error("Ошибка при обработке апдейта", update.update_id, e);
    }
    return new Response("ok");
  },

  async scheduled(_event, env, _ctx) {
    await ensureSchema(env.DB);
    const ctx = new Ctx(env, "");
    await syncProfile(ctx);
    await observeStops(ctx).catch((e) => console.error("Наблюдение за остановками", e));
    await runCommute(ctx).catch((e) => console.error("Дорога домой", e));
    await runTiktok(ctx).catch((e) => console.error("Огонёк", e));
  },
} satisfies ExportedHandler<Env>;

let profileSynced = false;

/**
 * Сам обновляет меню команд и описание бота в Telegram, если они поменялись в коде.
 * Работает по cron: после деплоя меню обновится в течение минуты, без ручных ссылок.
 */
async function syncProfile(ctx: Ctx) {
  if (profileSynced) return;
  const wanted = JSON.stringify({ COMMANDS, DESCRIPTION, SHORT_DESCRIPTION });
  if ((await ctx.store.getSetting("profile")) !== wanted) {
    try {
      await ctx.tg.call("setMyCommands", { commands: COMMANDS });
      await ctx.tg.call("setMyDescription", { description: DESCRIPTION });
      await ctx.tg.call("setMyShortDescription", { short_description: SHORT_DESCRIPTION });
      await ctx.store.setSetting("profile", wanted);
      console.log("Меню команд и описание обновлены");
    } catch (e) {
      console.error("Не удалось обновить меню и описание", e);
      return; // попробуем на следующей минуте
    }
  }
  profileSynced = true;
}

async function setup(ctx: Ctx): Promise<Response> {
  const steps: [string, Promise<unknown>][] = [
    ["setWebhook", ctx.tg.call("setWebhook", {
      url: ctx.origin,
      secret_token: ctx.env.WEBHOOK_SECRET,
      allowed_updates: ["message", "callback_query"],
    })],
    ["setMyCommands", ctx.tg.call("setMyCommands", { commands: COMMANDS })],
    ["setMyDescription", ctx.tg.call("setMyDescription", { description: DESCRIPTION })],
    ["setMyShortDescription", ctx.tg.call("setMyShortDescription", { short_description: SHORT_DESCRIPTION })],
  ];
  const lines = await Promise.all(
    steps.map(async ([name, p]) => {
      try {
        await p;
        return `OK    ${name}`;
      } catch (e) {
        return `ОШИБКА ${name}: ${(e as Error).message}`;
      }
    }),
  );
  await ensureSchema(ctx.env.DB);
  lines.push("OK    База готова");
  return new Response(lines.join("\n"), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
