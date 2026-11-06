import type { Ctx } from "./bot";
import type { Stop, StopField, StopKind } from "./db";
import { escapeHtml, type InlineKeyboard } from "./telegram";

/**
 * Остановки для дороги домой: список, добавление, изменение, удаление.
 * Пошаговый ввод хранится в user_state в виде JSON: {"f":"add","step":"name","d":{...}}.
 */

export const KIND_NAME: Record<StopKind, string> = { bus: "Автобус", tram: "Трамвай", trolley: "Троллейбус" };

const FIELD_NAME: Record<StopField, string> = {
  kind: "Вид транспорта",
  name: "Название",
  routes: "Маршруты",
  walk_min: "Минут пешком",
  orgp_id: "Номер для прогноза",
};

type Flow =
  | { f: "add"; step: "name" | "routes" | "walk"; d: { kind: StopKind; name?: string; routes?: string } }
  | { f: "edit"; id: number; field: Exclude<StopField, "kind"> };

const ASK = {
  name: "Название остановки — как в Яндекс.Картах или на табло (или /cancel):",
  routes: "Номера маршрутов через запятую, например <code>47, 55</code> (или /cancel):",
  walk: "Сколько минут идти до остановки от выхода из метро? Число, 0 — если рядом (или /cancel):",
  orgp_id: "Номер остановки у «Организатора перевозок» — число, 0 — сбросить (или /cancel):",
};

/** Однострочное описание: «Автобус 258 — Станция метро ...» */
export const stopTitle = (s: Stop) =>
  `${KIND_NAME[s.kind] ?? s.kind} ${s.routes.split(",").join(", ")} — ${s.name}`;

// ---------------- Список ----------------

const listKb: InlineKeyboard = {
  inline_keyboard: [[
    { text: "Добавить", callback_data: "stops:add" },
    { text: "Изменить", callback_data: "stops:edit" },
    { text: "Удалить", callback_data: "stops:del" },
  ]],
};

async function listText(ctx: Ctx) {
  const stops = await ctx.store.listStops();
  if (!stops.length) return "Остановок пока нет. Добавь первую: /addstop";
  const lines = stops.map((s) => {
    const extra = [`идти ${s.walk_min} мин`];
    if (s.orgp_id) extra.push(`номер для прогноза ${s.orgp_id}`);
    return `<b>#${s.id}</b> ${escapeHtml(stopTitle(s))}\n${extra.join(", ")}`;
  });
  return "<b>Остановки</b>\n\n" + lines.join("\n\n");
}

export async function showStops(ctx: Ctx, chatId: number, messageId?: number) {
  const text = await listText(ctx);
  if (messageId) await ctx.tg.edit(chatId, messageId, text, listKb);
  else await ctx.tg.send(chatId, text, listKb);
}

/** Кнопки «выбери остановку» для изменения или удаления. */
async function pickKb(ctx: Ctx, action: "edit" | "del"): Promise<InlineKeyboard> {
  const stops = await ctx.store.listStops();
  return {
    inline_keyboard: [
      ...stops.map((s) => [{ text: `#${s.id} ${stopTitle(s)}`.slice(0, 60), callback_data: `stops:${action}:${s.id}` }]),
      [{ text: "Назад", callback_data: "stops:list" }],
    ],
  };
}

const kindKb = (prefix: string): InlineKeyboard => ({
  inline_keyboard: [
    (Object.keys(KIND_NAME) as StopKind[]).map((k) => ({ text: KIND_NAME[k], callback_data: `${prefix}:${k}` })),
  ],
});

// ---------------- Команды ----------------

export async function startAdd(ctx: Ctx, chatId: number) {
  await ctx.tg.send(chatId, "Новая остановка. Какой транспорт?", kindKb("stops:kind"));
}

export async function startEdit(ctx: Ctx, chatId: number, arg?: string) {
  const id = Number(arg);
  if (arg && Number.isInteger(id)) return showStopFields(ctx, chatId, id);
  if (!(await ctx.store.listStops()).length) return void (await ctx.tg.send(chatId, "Остановок нет. Добавь: /addstop"));
  await ctx.tg.send(chatId, "Какую остановку изменить?", await pickKb(ctx, "edit"));
}

export async function startDelete(ctx: Ctx, chatId: number, arg?: string) {
  const id = Number(arg);
  if (arg && Number.isInteger(id)) return confirmDelete(ctx, chatId, id);
  if (!(await ctx.store.listStops()).length) return void (await ctx.tg.send(chatId, "Остановок нет."));
  await ctx.tg.send(chatId, "Какую остановку удалить?", await pickKb(ctx, "del"));
}

async function showStopFields(ctx: Ctx, chatId: number, id: number, messageId?: number) {
  const s = await ctx.store.getStop(id);
  if (!s) return void (await ctx.tg.send(chatId, `Остановки #${id} нет. Список: /stops`));
  const value: Record<StopField, string> = {
    kind: KIND_NAME[s.kind] ?? s.kind,
    name: s.name,
    routes: s.routes.split(",").join(", "),
    walk_min: `${s.walk_min} мин`,
    orgp_id: s.orgp_id ? String(s.orgp_id) : "не задан",
  };
  const text =
    `<b>Остановка #${s.id}</b>\n\n` +
    (Object.keys(FIELD_NAME) as StopField[]).map((f) => `${FIELD_NAME[f]}: ${escapeHtml(value[f])}`).join("\n") +
    "\n\nЧто изменить?";
  const kb: InlineKeyboard = {
    inline_keyboard: [
      [
        { text: "Название", callback_data: `stops:ef:${id}:name` },
        { text: "Маршруты", callback_data: `stops:ef:${id}:routes` },
      ],
      [
        { text: "Вид транспорта", callback_data: `stops:ef:${id}:kind` },
        { text: "Минут пешком", callback_data: `stops:ef:${id}:walk_min` },
      ],
      [{ text: "Номер для прогноза", callback_data: `stops:ef:${id}:orgp_id` }],
      [{ text: "Назад", callback_data: "stops:list" }],
    ],
  };
  if (messageId) await ctx.tg.edit(chatId, messageId, text, kb);
  else await ctx.tg.send(chatId, text, kb);
}

async function confirmDelete(ctx: Ctx, chatId: number, id: number, messageId?: number) {
  const s = await ctx.store.getStop(id);
  if (!s) return void (await ctx.tg.send(chatId, `Остановки #${id} нет. Список: /stops`));
  const text = `Удалить остановку #${s.id}?\n${escapeHtml(stopTitle(s))}`;
  const kb: InlineKeyboard = {
    inline_keyboard: [[
      { text: "Да, удалить", callback_data: `stops:delok:${id}` },
      { text: "Отмена", callback_data: "stops:list" },
    ]],
  };
  if (messageId) await ctx.tg.edit(chatId, messageId, text, kb);
  else await ctx.tg.send(chatId, text, kb);
}

// ---------------- Кнопки ----------------

export async function onStopsCallback(ctx: Ctx, data: string, chatId: number, userId: number, messageId: number, cbId: string) {
  const [, action, a, b] = data.split(":");
  const id = Number(a);
  await ctx.tg.answer(cbId);

  switch (action) {
    case "list":
      await ctx.store.setState(userId, null);
      return showStops(ctx, chatId, messageId);
    case "add":
      return startAdd(ctx, chatId);
    case "kind": {
      const flow: Flow = { f: "add", step: "name", d: { kind: a as StopKind } };
      await ctx.store.setState(userId, JSON.stringify(flow));
      return void (await ctx.tg.edit(chatId, messageId, `Новая остановка: ${KIND_NAME[a as StopKind]}.\n\n${ASK.name}`));
    }
    case "edit":
      if (a) return showStopFields(ctx, chatId, id, messageId);
      return void (await ctx.tg.edit(chatId, messageId, "Какую остановку изменить?", await pickKb(ctx, "edit")));
    case "ef": {
      const field = b as StopField;
      if (field === "kind") {
        return void (await ctx.tg.edit(chatId, messageId, "Какой транспорт?", kindKb(`stops:setkind:${id}`)));
      }
      const flow: Flow = { f: "edit", id, field };
      await ctx.store.setState(userId, JSON.stringify(flow));
      return void (await ctx.tg.send(chatId, ASK[field === "walk_min" ? "walk" : field]));
    }
    case "setkind":
      await ctx.store.updateStop(id, "kind", b);
      return showStopFields(ctx, chatId, id, messageId);
    case "del":
      if (a) return confirmDelete(ctx, chatId, id, messageId);
      return void (await ctx.tg.edit(chatId, messageId, "Какую остановку удалить?", await pickKb(ctx, "del")));
    case "delok":
      await ctx.store.deleteStop(id);
      return showStops(ctx, chatId, messageId);
  }
}

// ---------------- Пошаговый ввод ----------------

const parseRoutes = (text: string) => {
  const list = text.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
  return list.length && list.every((r) => /^[0-9А-Яа-яA-Za-z-]{1,6}$/.test(r) && /\d/.test(r)) ? list.join(",") : null;
};

const parseInt0 = (text: string, max: number) => {
  const n = Number(text.trim());
  return Number.isInteger(n) && n >= 0 && n <= max ? n : null;
};

/** Возвращает true, если сообщение было ответом на вопрос про остановку. */
export async function onStopInput(ctx: Ctx, chatId: number, userId: number, state: string, text: string) {
  let flow: Flow;
  try {
    flow = JSON.parse(state) as Flow;
  } catch {
    return false;
  }

  const again = async (msg: string) => {
    await ctx.tg.send(chatId, msg);
    return true;
  };

  if (flow.f === "add") {
    if (flow.step === "name") {
      flow.d.name = text.slice(0, 100);
      flow.step = "routes";
      await ctx.store.setState(userId, JSON.stringify(flow));
      await ctx.tg.send(chatId, ASK.routes);
    } else if (flow.step === "routes") {
      const routes = parseRoutes(text);
      if (!routes) return again(`Не разобрал номера. ${ASK.routes}`);
      flow.d.routes = routes;
      flow.step = "walk";
      await ctx.store.setState(userId, JSON.stringify(flow));
      await ctx.tg.send(chatId, ASK.walk);
    } else {
      const walk = parseInt0(text, 120);
      if (walk === null) return again(`Нужно число минут. ${ASK.walk}`);
      await ctx.store.setState(userId, null);
      const id = await ctx.store.addStop({ kind: flow.d.kind, name: flow.d.name!, routes: flow.d.routes!, walk_min: walk });
      await ctx.tg.send(chatId, `Остановка #${id} добавлена.`);
      await showStops(ctx, chatId);
    }
    return true;
  }

  // Изменение одного поля
  let value: string | number | null;
  if (flow.field === "name") value = text.slice(0, 100);
  else if (flow.field === "routes") {
    value = parseRoutes(text);
    if (!value) return again(`Не разобрал номера. ${ASK.routes}`);
  } else if (flow.field === "walk_min") {
    value = parseInt0(text, 120);
    if (value === null) return again(`Нужно число минут. ${ASK.walk}`);
  } else {
    const n = parseInt0(text, 10_000_000);
    if (n === null) return again(`Нужно число. ${ASK.orgp_id}`);
    value = n === 0 ? null : n;
  }
  await ctx.store.setState(userId, null);
  await ctx.store.updateStop(flow.id, flow.field, value);
  await ctx.tg.send(chatId, `Остановка #${flow.id} изменена.`);
  await showStops(ctx, chatId);
  return true;
}
