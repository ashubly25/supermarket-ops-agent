import * as analytics from "./repo/analytics.js";
import * as batches from "./repo/batches.js";
import * as khata from "./repo/khata.js";
import * as schedules from "./repo/schedules.js";
import { queueFile } from "./repo/updates.js";
import { getPrefs } from "./repo/prefs.js";
import { shopInfo } from "./lib/shop.js";
import { generateDeckPptx } from "./docs/deck.js";
import { inr } from "./lib/money.js";

export const dayShift = (days: number, from = new Date()): string => {
  const d = new Date(from);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};

/**
 * Build the analysis deck for a range and queue it for delivery. Shared by the
 * agent's generate_analysis_deck tool and the weekly scheduler, so a scheduled
 * deck is byte-identical to one the owner asks for.
 */
export async function buildDeck(chatId: string, from: string, to: string) {
  const report = analytics.salesReport(from, to);
  const extras = {
    reorder: analytics.reorderSuggestions(14, 14),
    expiring: batches.expiringSoon(30),
  };
  const path = await generateDeckPptx(report, shopInfo(chatId), chatId, extras);
  queueFile(chatId, path, `Sales analysis ${from} → ${to}`);
  return { path, report, extras };
}

/** Owner-facing reminder digest for khata that has gone quiet. */
export function khataDigest(chatId: string): { text: string; count: number } {
  const raw = Number(getPrefs(chatId).khata_reminder_days);
  const days = Number.isFinite(raw) && raw >= 0 ? raw : 14; // ignore a garbled pref

  const rows = khata.overdue(days);
  if (rows.length === 0) return { text: `No khata overdue past ${days} days. All settled up.`, count: 0 };
  const total = rows.reduce((a, r) => a + r.balance, 0);
  const lines = rows
    .slice(0, 10)
    .map((r) => `• ${r.name} — ${inr(r.balance)}, ${r.days_outstanding} days${r.phone ? ` (${r.phone})` : ""}`);
  return {
    count: rows.length,
    text:
      `🔔 Khata reminders — ${rows.length} customer(s) owe ${inr(total)} (no payment in ${days}+ days):\n` +
      lines.join("\n") +
      `\n\nSay "remind <name>" and I'll draft the message to send them.`,
  };
}

/** Message the owner can copy-paste/forward to a customer. */
export function reminderMessage(chatId: string, customer: string): string {
  const c = khata.balance(customer);
  if (!c) throw new Error(`No khata found for "${customer}".`);
  const shop = shopInfo(chatId);
  const row = khata.overdue(0).find((r) => r.id === c.id);
  const since = row ? ` (outstanding ${row.days_outstanding} days)` : "";
  return (
    `Namaste ${c.name} 🙏\n` +
    `Your khata balance at ${shop.name} is ${inr(c.khata_balance)}${since}.\n` +
    `Kindly settle at your convenience — cash or UPI both fine.\n` +
    `Thank you! — ${shop.name}, ${shop.phone}`
  );
}

export interface JobResult {
  kind: string;
  chat_id: string;
  summary: string;
}

/** Execute one scheduled job. Called only after schedules.claim() succeeds. */
export async function runJob(s: schedules.Schedule): Promise<JobResult> {
  const chatId = s.chat_id;
  if (s.kind === "weekly_deck") {
    const from = dayShift(-6);
    const to = dayShift(0);
    const { report } = await buildDeck(chatId, from, to);
    schedules.queueNotice(
      chatId,
      `📊 Your weekly analysis deck (${from} → ${to}) — ${report.bill_count} bills, sales ${inr(report.gross_sales)}, GST ${inr(report.tax_collected)}.`
    );
    return { kind: s.kind, chat_id: chatId, summary: `deck ${from}→${to}` };
  }
  if (s.kind === "khata_reminder") {
    const d = khataDigest(chatId);
    if (d.count > 0) schedules.queueNotice(chatId, d.text);
    return { kind: s.kind, chat_id: chatId, summary: `${d.count} overdue` };
  }
  if (s.kind === "daily_close") {
    const c = analytics.dailyClose();
    const pay = Object.entries(c.by_payment).map(([k, v]) => `${k} ${inr(v.amount)}`).join(", ") || "—";
    schedules.queueNotice(
      chatId,
      `🧾 Day close ${c.date}: ${c.bill_count} bills, sales ${inr(c.gross_sales)}, GST ${inr(c.tax_collected)}.\nPayments: ${pay}.` +
        (c.top_items.length ? `\nTop: ${c.top_items.map((t) => `${t.name} (${inr(t.revenue)})`).join(", ")}` : "")
    );
    return { kind: s.kind, chat_id: chatId, summary: `${c.bill_count} bills` };
  }
  throw new Error(`Unknown job kind ${s.kind}`);
}

/**
 * One scheduler tick: claim and run everything due. claim() is an atomic
 * compare-and-set on the slot key, so a restart mid-tick can't double-send.
 */
export async function tick(now = new Date()): Promise<JobResult[]> {
  const out: JobResult[] = [];
  for (const s of schedules.due(now)) {
    if (!schedules.claim(s, now)) continue;
    try {
      out.push(await runJob(s));
    } catch (e) {
      console.error(`scheduled job ${s.kind} for ${s.chat_id} failed:`, e);
      schedules.queueNotice(s.chat_id, `⚠️ Scheduled ${s.kind} failed: ${(e as Error).message}`);
    }
  }
  return out;
}
