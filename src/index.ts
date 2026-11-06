import type { Env } from "./env";
import { Ctx, handleUpdate, sendDueReminders } from "./bot";
import { ensureSchema } from "./db";
import type { Update } from "./telegram";
import { COMMANDS, DESCRIPTION, SHORT_DESCRIPTION } from "./texts";

export default {
  async fetch(request, env, _ctx): Promise<Response> {
    const url = new URL(request.url);

    // Разовая настройка: вебхук, меню команд, описание бота.
    // Открыть в браузере: https://<worker>/setup?secret=<WEBHOOK_SECRET>
    if (url.pathname === "/setup") {
      if (url.searchParams.get("secret") !== env.WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
      return setup(new Ctx(env, url.origin));
    }

    if (request.method !== "POST") {
      return new Response("Отрок Батракан на посту 🙇");
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
    const sent = await sendDueReminders(new Ctx(env, ""));
    if (sent) console.log(`Отправлено напоминаний: ${sent}`);
  },
} satisfies ExportedHandler<Env>;

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
        return `✅ ${name}`;
      } catch (e) {
        return `❌ ${name}: ${(e as Error).message}`;
      }
    }),
  );
  await ensureSchema(ctx.env.DB);
  lines.push("✅ База готова");
  return new Response(lines.join("\n"), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
