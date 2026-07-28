import { db } from "../db/index.js";

/**
 * Telegram redelivers updates on network hiccups. Record each update_id once;
 * a redelivered update returns false → the bot drops it (idempotency at ingress).
 */
export function markProcessed(updateId: number): boolean {
  const info = db
    .prepare("INSERT OR IGNORE INTO processed_updates (update_id) VALUES (?)")
    .run(updateId);
  return info.changes === 1; // true = first time seen
}

/** Per-chat agent outbox: tools drop generated file paths here; the bot sends & marks them. */
export function queueFile(chatId: string, path: string, caption: string): void {
  db.prepare(
    "INSERT INTO outbox (chat_id, path, caption, sent) VALUES (?,?,?,0)"
  ).run(chatId, path, caption);
}

export function takeOutbox(chatId: string): { id: number; path: string; caption: string }[] {
  const rows = db
    .prepare("SELECT id, path, caption FROM outbox WHERE chat_id = ? AND sent = 0 ORDER BY id")
    .all(chatId) as { id: number; path: string; caption: string }[];
  return rows;
}

export function markSent(id: number): void {
  db.prepare("UPDATE outbox SET sent = 1 WHERE id = ?").run(id);
}
