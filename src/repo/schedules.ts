import { db } from "../db/index.js";

export type ScheduleKind = "weekly_deck" | "khata_reminder" | "daily_close";

export interface Schedule {
  id: number;
  chat_id: string;
  kind: ScheduleKind;
  weekday: number | null; // 0=Sun .. 6=Sat; null = every day
  hour: number;
  minute: number;
  enabled: number;
  last_run: string | null;
}

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function describe(s: Schedule): string {
  const when = s.weekday === null ? "every day" : `every ${WEEKDAYS[s.weekday]}`;
  const t = `${String(s.hour).padStart(2, "0")}:${String(s.minute).padStart(2, "0")}`;
  return `${s.kind} — ${when} at ${t}${s.enabled ? "" : " (paused)"}`;
}

export function upsert(s: Omit<Schedule, "id" | "last_run">): Schedule {
  db.prepare(
    `INSERT INTO schedules (chat_id, kind, weekday, hour, minute, enabled)
     VALUES (@chat_id,@kind,@weekday,@hour,@minute,@enabled)
     ON CONFLICT(chat_id, kind) DO UPDATE SET
       weekday=excluded.weekday, hour=excluded.hour, minute=excluded.minute, enabled=excluded.enabled`
  ).run(s);
  return db.prepare("SELECT * FROM schedules WHERE chat_id=? AND kind=?").get(s.chat_id, s.kind) as Schedule;
}

export function list(chatId?: string): Schedule[] {
  return chatId
    ? (db.prepare("SELECT * FROM schedules WHERE chat_id=? ORDER BY kind").all(chatId) as Schedule[])
    : (db.prepare("SELECT * FROM schedules ORDER BY chat_id, kind").all() as Schedule[]);
}

export function remove(chatId: string, kind: string): boolean {
  return db.prepare("DELETE FROM schedules WHERE chat_id=? AND kind=?").run(chatId, kind).changes > 0;
}

/** Slot key for a fire — one per schedule per calendar day. */
const slotKey = (now: Date, s: Schedule) =>
  `${now.toISOString().slice(0, 10)}T${String(s.hour).padStart(2, "0")}:${String(s.minute).padStart(2, "0")}`;

/** Schedules whose time has arrived today and that haven't fired for that slot yet. */
export function due(now = new Date()): Schedule[] {
  const mins = now.getHours() * 60 + now.getMinutes();
  return list().filter((s) => {
    if (!s.enabled) return false;
    if (s.weekday !== null && s.weekday !== now.getDay()) return false;
    if (mins < s.hour * 60 + s.minute) return false; // not yet
    return s.last_run !== slotKey(now, s);
  });
}

/**
 * Atomically claim a due schedule. Returns false if another tick (or a restart
 * mid-run) already took this slot — so a job never double-sends.
 */
export function claim(s: Schedule, now = new Date()): boolean {
  const key = slotKey(now, s);
  const info = db
    .prepare("UPDATE schedules SET last_run=? WHERE id=? AND (last_run IS NULL OR last_run != ?)")
    .run(key, s.id, key);
  return info.changes === 1;
}

/** Plain-text push queued by the scheduler; the bot drains it. */
export function queueNotice(chatId: string, text: string): void {
  db.prepare("INSERT INTO notices (chat_id, text, sent) VALUES (?,?,0)").run(chatId, text);
}

export function takeNotices(chatId: string): { id: number; text: string }[] {
  return db.prepare("SELECT id, text FROM notices WHERE chat_id=? AND sent=0 ORDER BY id").all(chatId) as {
    id: number;
    text: string;
  }[];
}

export function markNoticeSent(id: number): void {
  db.prepare("UPDATE notices SET sent=1 WHERE id=?").run(id);
}

export function chatsWithPending(): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT chat_id FROM notices WHERE sent=0
       UNION SELECT DISTINCT chat_id FROM outbox WHERE sent=0`
    )
    .all() as { chat_id: string }[];
  return rows.map((r) => r.chat_id);
}
