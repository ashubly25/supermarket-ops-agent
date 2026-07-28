import { tool } from "../lib/tool.js";
import { z } from "zod";
import * as khata from "../repo/khata.js";
import { inr } from "../lib/money.js";

function ok(text: string, data?: unknown) {
  return {
    content: [{ type: "text" as const, text }],
    ...(data !== undefined ? { structuredContent: data as Record<string, unknown> } : {}),
  };
}
function err(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

export const khataCharge = tool(
  "khata_charge",
  "Add an amount to a customer's khata (credit ledger) — they now owe more. Creates the customer if new. Use for 'put ₹500 on Ramesh's credit'.",
  {
    customer: z.string().describe("Customer name"),
    amount: z.number().positive().describe("Amount in ₹ to add to what they owe"),
    note: z.string().optional(),
  },
  async ({ customer, amount, note }) => {
    try {
      const c = khata.charge(customer, amount, { note });
      return ok(`Added ${inr(amount)} to ${c.name}'s khata. Balance now ${inr(c.khata_balance)}.`, { customer: c });
    } catch (e) {
      return err((e as Error).message);
    }
  }
);

export const khataPayment = tool(
  "khata_payment",
  "Record a payment a customer made against their khata (reduces what they owe). Paying MORE than the balance is allowed and leaves an advance the shop owes back — say so plainly when it happens. Refuses only if the customer has no khata. Use for 'Ramesh paid ₹300'.",
  {
    customer: z.string(),
    amount: z.number().positive(),
    note: z.string().optional(),
  },
  async ({ customer, amount, note }) => {
    try {
      const c = khata.payment(customer, amount, note);
      const msg =
        c.khata_balance < -1e-6
          ? `${c.name} paid ${inr(amount)}. Khata cleared, and ${inr(-c.khata_balance)} is left over as an advance you owe them.`
          : Math.abs(c.khata_balance) <= 1e-6
            ? `${c.name} paid ${inr(amount)}. Khata cleared — balance ₹0.00.`
            : `${c.name} paid ${inr(amount)}. Balance now ${inr(c.khata_balance)}.`;
      return ok(msg, { customer: c });
    } catch (e) {
      return err((e as Error).message);
    }
  }
);

export const khataBalance = tool(
  "khata_balance",
  "Check a customer's outstanding khata balance and recent ledger. Use for \"Ramesh's balance?\".",
  { customer: z.string() },
  async ({ customer }) => {
    const c = khata.balance(customer);
    if (!c) return ok(`No khata on record for "${customer}".`, { found: false });
    const recent = khata
      .ledger(c.id, 5)
      .map((t) => `  ${t.ts.slice(0, 10)} ${t.kind === "charge" ? "+" : "−"}${inr(t.amount)}${t.note ? " (" + t.note + ")" : ""}`)
      .join("\n");
    return ok(`${c.name} owes ${inr(c.khata_balance)}.\nRecent:\n${recent || "  (none)"}`, { customer: c });
  }
);

export function makeKhataTools(ctx: { chatId: string }) {
  const khataReminders = tool(
    "khata_reminders",
    "List customers whose khata has gone unpaid for N+ days, with balances, phone numbers and how long outstanding. Use for 'who owes me?', 'khata reminders', 'pending udhaar'.",
    { days: z.number().int().default(14).describe("Only show khata with no payment in this many days") },
    async ({ days }) => {
      const rows = khata.overdue(days);
      if (rows.length === 0) return ok(`No khata unpaid past ${days} days.`, { overdue: [] });
      const total = rows.reduce((a, r) => a + r.balance, 0);
      const text =
        `${rows.length} customer(s) owe ${inr(total)} (no payment in ${days}+ days):\n` +
        rows.map((r) => `• ${r.name} — ${inr(r.balance)}, ${r.days_outstanding} days${r.phone ? ` (${r.phone})` : ""}`).join("\n");
      return ok(text, { overdue: rows, total });
    }
  );

  const draftReminder = tool(
    "draft_khata_reminder",
    "Draft a polite payment-reminder message the owner can forward to a customer over WhatsApp/SMS. Does not send anything itself.",
    { customer: z.string() },
    async ({ customer }) => {
      try {
        const { reminderMessage } = await import("../jobs.js");
        const msg = reminderMessage(ctx.chatId, customer);
        return ok(`Here's the message for ${customer} — copy and send:\n\n${msg}`, { message: msg });
      } catch (e) {
        return err((e as Error).message);
      }
    }
  );

  return [khataCharge, khataPayment, khataBalance, khataReminders, draftReminder];
}

export const khataTools = [khataCharge, khataPayment, khataBalance];
