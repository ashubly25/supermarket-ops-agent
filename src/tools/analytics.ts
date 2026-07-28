import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import * as analytics from "../repo/analytics.js";
import { inr } from "../lib/money.js";

function ok(text: string, data?: unknown) {
  return {
    content: [{ type: "text" as const, text }],
    ...(data !== undefined ? { structuredContent: data as Record<string, unknown> } : {}),
  };
}

export const dailyClose = tool(
  "daily_close",
  "Close the day / report a day's sales: total sales, tax collected, cash vs UPI vs card vs credit split, and top items. Defaults to today. Use for 'today's sales?' or 'close the day'.",
  { date: z.string().optional().describe("YYYY-MM-DD; omit for today") },
  async ({ date }) => {
    const r = analytics.dailyClose(date);
    if (r.bill_count === 0) return ok(`No finalized sales on ${r.date}.`, r);
    const pay = Object.entries(r.by_payment)
      .map(([m, v]) => `  ${m.toUpperCase()}: ${inr(v.amount)} (${v.count})`)
      .join("\n");
    const top = r.top_items.map((t, i) => `  ${i + 1}. ${t.name} — ${t.qty} sold, ${inr(t.revenue)}`).join("\n");
    return ok(
      `📊 ${r.date}\nBills: ${r.bill_count}\nSales: ${inr(r.gross_sales)}\nTax collected: ${inr(r.tax_collected)}\nPayments:\n${pay}\nTop items:\n${top}`,
      r
    );
  }
);

export const salesReport = tool(
  "sales_report",
  "Aggregate sales over a date range (inclusive): totals, tax, payment split, per-GST-slab breakup, daily trend, top items, low stock, khata outstanding. Use for 'this week's sales' or as the data behind an analysis deck. Compute the from/to dates from today's date.",
  {
    from: z.string().describe("Start date YYYY-MM-DD"),
    to: z.string().describe("End date YYYY-MM-DD (inclusive)"),
  },
  async ({ from, to }) => {
    const r = analytics.salesReport(from, to);
    const top = r.top_items.map((t, i) => `  ${i + 1}. ${t.name} — ${t.qty}, ${inr(t.revenue)}`).join("\n");
    return ok(
      `📈 ${r.from} → ${r.to}\nBills: ${r.bill_count}\nSales: ${inr(r.gross_sales)}\nGST collected: ${inr(r.tax_collected)}\nKhata outstanding: ${inr(r.khata_outstanding)}\nTop items:\n${top || "  (none)"}`,
      r
    );
  }
);

export const reorderSuggestions = tool(
  "reorder_suggestions",
  "Suggest WHAT TO BUY and HOW MUCH, computed from actual sales velocity (units sold per day) rather than a static reorder level — includes days of cover left and the rupee cost of the order. Use for 'what should I order?', 'reorder list', 'purchase plan'. Prefer this over low_stock when the owner is planning a purchase.",
  {
    window_days: z.number().int().default(14).describe("How many days of sales history to measure velocity over"),
    cover_days: z.number().int().default(14).describe("How many days of stock the order should cover"),
  },
  async ({ window_days, cover_days }) => {
    const rows = analytics.reorderSuggestions(window_days, cover_days);
    if (rows.length === 0) return ok("Nothing needs reordering — stock covers current demand.", { reorder: [] });
    const spend = rows.reduce((a, r) => a + r.suggest_cost, 0);
    const text =
      `Reorder plan (velocity over ${window_days}d, ${cover_days}d cover) — est. ${inr(spend)}:\n` +
      rows
        .map(
          (r) =>
            `${r.urgency === "urgent" ? "🔴" : r.urgency === "soon" ? "🟠" : "⚪"} ${r.name} ${r.size} — on hand ${r.qty} ${r.unit}, selling ${r.per_day}/day` +
            `${r.days_cover === null ? " (no sales yet)" : `, ${r.days_cover}d cover left`} → order ${r.suggest_qty} ${r.unit} (${inr(r.suggest_cost)})`
        )
        .join("\n");
    return ok(text, { reorder: rows, estimated_cost: spend });
  }
);

export const analyticsTools = [dailyClose, salesReport, reorderSuggestions];
