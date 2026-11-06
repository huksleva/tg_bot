const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS notes (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id INTEGER NOT NULL,
     text TEXT NOT NULL,
     created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS notes_user ON notes(user_id)`,
  `CREATE TABLE IF NOT EXISTS reminders (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     chat_id INTEGER NOT NULL,
     text TEXT NOT NULL,
     fire_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS reminders_fire ON reminders(fire_at)`,
  // Что бот ждёт от пользователя (например, текст заметки после кнопки «Новая заметка»)
  `CREATE TABLE IF NOT EXISTS user_state (
     user_id INTEGER PRIMARY KEY,
     state TEXT NOT NULL)`,
  // Кому присылать сообщение «пора домой» после пар
  `CREATE TABLE IF NOT EXISTS commute_subs (
     chat_id INTEGER PRIMARY KEY)`,
  // Служебные значения бота
  `CREATE TABLE IF NOT EXISTS settings (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL)`,
  // Остановки для дороги домой. orgp_id — номер остановки у «Организатора перевозок» (для прогноза)
  `CREATE TABLE IF NOT EXISTS stops (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     kind TEXT NOT NULL,
     name TEXT NOT NULL,
     routes TEXT NOT NULL,
     walk_min INTEGER NOT NULL DEFAULT 0,
     orgp_id INTEGER)`,
  // Начальные остановки — один раз, чтобы удалённые не появлялись снова
  `INSERT INTO stops (kind, name, routes, walk_min)
     SELECT 'bus', 'Станция метро Комендантский проспект', '258', 0
     WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'stops_seeded')`,
  `INSERT INTO stops (kind, name, routes, walk_min)
     SELECT 'tram', 'Комендантский проспект, метро', '47,55', 0
     WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'stops_seeded')`,
  `INSERT OR IGNORE INTO settings (key, value) VALUES ('stops_seeded', '1')`,
];

let schemaReady = false;

/** Создаёт таблицы при первом обращении (один раз на экземпляр Worker). */
export async function ensureSchema(db: D1Database) {
  if (schemaReady) return;
  await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
  schemaReady = true;
}

const now = () => Math.floor(Date.now() / 1000);

export interface Note { id: number; text: string; created_at: number }
export type StopKind = "bus" | "tram" | "trolley";
export interface Stop {
  id: number;
  kind: StopKind;
  name: string;
  routes: string; // «47,55»
  walk_min: number;
  orgp_id: number | null;
}
export type StopField = "kind" | "name" | "routes" | "walk_min" | "orgp_id";
export interface Reminder { id: number; chat_id: number; text: string; fire_at: number }

export class Store {
  constructor(private db: D1Database) {}

  // --- Заметки ---
  async addNote(userId: number, text: string) {
    const r = await this.db
      .prepare("INSERT INTO notes (user_id, text, created_at) VALUES (?, ?, ?) RETURNING id")
      .bind(userId, text, now())
      .first<{ id: number }>();
    return r!.id;
  }

  async listNotes(userId: number) {
    const { results } = await this.db
      .prepare("SELECT id, text, created_at FROM notes WHERE user_id = ? ORDER BY id")
      .bind(userId)
      .all<Note>();
    return results;
  }

  async deleteNote(userId: number, id: number) {
    const r = await this.db
      .prepare("DELETE FROM notes WHERE id = ? AND user_id = ?")
      .bind(id, userId)
      .run();
    return r.meta.changes > 0;
  }

  // --- Напоминания ---
  async addReminder(chatId: number, text: string, fireAt: number) {
    const r = await this.db
      .prepare("INSERT INTO reminders (chat_id, text, fire_at) VALUES (?, ?, ?) RETURNING id")
      .bind(chatId, text, fireAt)
      .first<{ id: number }>();
    return r!.id;
  }

  async listReminders(chatId: number) {
    const { results } = await this.db
      .prepare("SELECT id, chat_id, text, fire_at FROM reminders WHERE chat_id = ? ORDER BY fire_at")
      .bind(chatId)
      .all<Reminder>();
    return results;
  }

  async deleteReminder(chatId: number, id: number) {
    const r = await this.db
      .prepare("DELETE FROM reminders WHERE id = ? AND chat_id = ?")
      .bind(id, chatId)
      .run();
    return r.meta.changes > 0;
  }

  /** Забирает наступившие напоминания и сразу удаляет их из базы. */
  async popDueReminders() {
    const { results } = await this.db
      .prepare("DELETE FROM reminders WHERE fire_at <= ? RETURNING id, chat_id, text, fire_at")
      .bind(now())
      .all<Reminder>();
    return results;
  }

  // --- Остановки ---
  async listStops() {
    const { results } = await this.db.prepare("SELECT * FROM stops ORDER BY id").all<Stop>();
    return results;
  }

  async getStop(id: number) {
    return this.db.prepare("SELECT * FROM stops WHERE id = ?").bind(id).first<Stop>();
  }

  async addStop(s: Omit<Stop, "id" | "orgp_id">) {
    const r = await this.db
      .prepare("INSERT INTO stops (kind, name, routes, walk_min) VALUES (?, ?, ?, ?) RETURNING id")
      .bind(s.kind, s.name, s.routes, s.walk_min)
      .first<{ id: number }>();
    return r!.id;
  }

  async updateStop(id: number, field: StopField, value: string | number | null) {
    // Имя поля — только из фиксированного списка, значение — через bind
    const allowed: StopField[] = ["kind", "name", "routes", "walk_min", "orgp_id"];
    if (!allowed.includes(field)) throw new Error("bad field");
    const r = await this.db.prepare(`UPDATE stops SET ${field} = ? WHERE id = ?`).bind(value, id).run();
    return r.meta.changes > 0;
  }

  async deleteStop(id: number) {
    const r = await this.db.prepare("DELETE FROM stops WHERE id = ?").bind(id).run();
    return r.meta.changes > 0;
  }

  // --- Подписка на сообщение после пар ---
  async isCommuteSub(chatId: number) {
    const r = await this.db.prepare("SELECT 1 FROM commute_subs WHERE chat_id = ?").bind(chatId).first();
    return r !== null;
  }

  async setCommuteSub(chatId: number, on: boolean) {
    const sql = on
      ? "INSERT OR IGNORE INTO commute_subs (chat_id) VALUES (?)"
      : "DELETE FROM commute_subs WHERE chat_id = ?";
    await this.db.prepare(sql).bind(chatId).run();
  }

  async listCommuteSubs() {
    const { results } = await this.db.prepare("SELECT chat_id FROM commute_subs").all<{ chat_id: number }>();
    return results.map((r) => r.chat_id);
  }

  // --- Служебные настройки ---
  async getSetting(key: string) {
    const r = await this.db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .bind(key)
      .first<{ value: string }>();
    return r?.value ?? null;
  }

  async setSetting(key: string, value: string) {
    await this.db
      .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
      .bind(key, value)
      .run();
  }

  // --- Состояние диалога ---
  async getState(userId: number) {
    const r = await this.db
      .prepare("SELECT state FROM user_state WHERE user_id = ?")
      .bind(userId)
      .first<{ state: string }>();
    return r?.state ?? null;
  }

  async setState(userId: number, state: string | null) {
    if (state === null) {
      await this.db.prepare("DELETE FROM user_state WHERE user_id = ?").bind(userId).run();
    } else {
      await this.db
        .prepare("INSERT OR REPLACE INTO user_state (user_id, state) VALUES (?, ?)")
        .bind(userId, state)
        .run();
    }
  }
}
