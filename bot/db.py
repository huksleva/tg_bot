import time

import aiosqlite

SCHEMA = """
CREATE TABLE IF NOT EXISTS notes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    text       TEXT    NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS reminders (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id  INTEGER NOT NULL,
    text     TEXT    NOT NULL,
    fire_at  INTEGER NOT NULL
);
"""


class Database:
    def __init__(self, path: str):
        self.path = path
        self.conn: aiosqlite.Connection | None = None

    async def connect(self) -> None:
        self.conn = await aiosqlite.connect(self.path)
        self.conn.row_factory = aiosqlite.Row
        await self.conn.executescript(SCHEMA)
        await self.conn.commit()

    async def close(self) -> None:
        if self.conn:
            await self.conn.close()

    # --- Заметки ---
    async def add_note(self, user_id: int, text: str) -> int:
        cur = await self.conn.execute(
            "INSERT INTO notes (user_id, text, created_at) VALUES (?, ?, ?)",
            (user_id, text, int(time.time())),
        )
        await self.conn.commit()
        return cur.lastrowid

    async def list_notes(self, user_id: int) -> list[aiosqlite.Row]:
        cur = await self.conn.execute(
            "SELECT id, text, created_at FROM notes WHERE user_id = ? ORDER BY id", (user_id,)
        )
        return await cur.fetchall()

    async def delete_note(self, user_id: int, note_id: int) -> bool:
        cur = await self.conn.execute(
            "DELETE FROM notes WHERE id = ? AND user_id = ?", (note_id, user_id)
        )
        await self.conn.commit()
        return cur.rowcount > 0

    # --- Напоминания ---
    async def add_reminder(self, chat_id: int, text: str, fire_at: int) -> int:
        cur = await self.conn.execute(
            "INSERT INTO reminders (chat_id, text, fire_at) VALUES (?, ?, ?)",
            (chat_id, text, fire_at),
        )
        await self.conn.commit()
        return cur.lastrowid

    async def list_reminders(self, chat_id: int) -> list[aiosqlite.Row]:
        cur = await self.conn.execute(
            "SELECT id, text, fire_at FROM reminders WHERE chat_id = ? ORDER BY fire_at", (chat_id,)
        )
        return await cur.fetchall()

    async def delete_reminder(self, chat_id: int, rem_id: int) -> bool:
        cur = await self.conn.execute(
            "DELETE FROM reminders WHERE id = ? AND chat_id = ?", (rem_id, chat_id)
        )
        await self.conn.commit()
        return cur.rowcount > 0

    async def pop_due_reminders(self) -> list[aiosqlite.Row]:
        now = int(time.time())
        cur = await self.conn.execute(
            "SELECT id, chat_id, text FROM reminders WHERE fire_at <= ?", (now,)
        )
        rows = await cur.fetchall()
        if rows:
            await self.conn.executemany(
                "DELETE FROM reminders WHERE id = ?", [(r["id"],) for r in rows]
            )
            await self.conn.commit()
        return rows
