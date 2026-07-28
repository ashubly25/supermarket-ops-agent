import { db } from "../db/index.js";

export function getPrefs(chatId: string): Record<string, string> {
  const rows = db.prepare("SELECT key, value FROM prefs WHERE chat_id = ?").all(chatId) as {
    key: string;
    value: string;
  }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export function getPref(chatId: string, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM prefs WHERE chat_id = ? AND key = ?").get(chatId, key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setPref(chatId: string, key: string, value: string): void {
  db.prepare(
    `INSERT INTO prefs (chat_id, key, value) VALUES (?,?,?)
     ON CONFLICT(chat_id, key) DO UPDATE SET value = excluded.value`
  ).run(chatId, key, value);
}

export function deletePref(chatId: string, key: string): void {
  db.prepare("DELETE FROM prefs WHERE chat_id = ? AND key = ?").run(chatId, key);
}
