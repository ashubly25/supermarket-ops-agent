import { db } from "../db/index.js";
import { round2 } from "../lib/money.js";

export interface DayClose {
  date: string;
  bill_count: number;
  gross_sales: number;
  taxable: number;
  tax_collected: number;
  by_payment: Record<string, { count: number; amount: number }>;
  top_items: { name: string; qty: number; revenue: number }[];
}

export interface SalesReport {
  from: string;
  to: string;
  bill_count: number;
  gross_sales: number;
  tax_collected: number;
  by_payment: Record<string, number>;
  by_slab: { gst_rate: number; taxable: number; tax: number }[];
  daily: { date: string; sales: number }[];
  top_items: { name: string; qty: number; revenue: number }[];
  low_stock: { name: string; size: string; qty: number; unit: string; reorder_level: number }[];
  khata_outstanding: number;
}

export interface ReorderRow {
  product_id: number;
  name: string;
  size: string;
  unit: string;
  qty: number;
  reorder_level: number;
  sold: number;          // units sold in the window
  per_day: number;       // sales velocity
  days_cover: number | null;  // null = no sales seen (can't project)
  suggest_qty: number;   // units to buy to reach the cover target
  suggest_cost: number;  // ₹ at current cost price
  urgency: "urgent" | "soon" | "watch";
}

/**
 * Reorder suggestions from actual sales velocity (stock_moves reason='sale'),
 * not just the static reorder level. Buy enough to cover `coverDays`, with a
 * safety buffer, minus what's on hand. Only returns items that need buying.
 */
export function reorderSuggestions(windowDays = 14, coverDays = 14): ReorderRow[] {
  const rows = db
    .prepare(
      `SELECT p.id product_id, p.name, p.size, p.unit, p.qty, p.reorder_level, p.cost_price,
              COALESCE(-SUM(CASE WHEN sm.reason='sale' THEN sm.delta END), 0) sold
       FROM products p
       LEFT JOIN stock_moves sm
         ON sm.product_id = p.id AND sm.ts >= datetime('now', ?)
       GROUP BY p.id
       ORDER BY sold DESC`
    )
    .all(`-${windowDays} days`) as any[];

  const out: ReorderRow[] = [];
  for (const r of rows) {
    const perDay = round2(r.sold / windowDays);
    const daysCover = perDay > 0 ? round2(r.qty / perDay) : null;
    // Target = velocity × cover window × 1.2 safety buffer; fall back to reorder level.
    const target = perDay > 0 ? perDay * coverDays * 1.2 : r.reorder_level;
    const need = Math.ceil(target - r.qty);
    if (need <= 0) continue;
    const urgency: ReorderRow["urgency"] =
      daysCover !== null && daysCover <= 3 ? "urgent" : r.qty <= r.reorder_level ? "soon" : "watch";
    out.push({
      product_id: r.product_id, name: r.name, size: r.size, unit: r.unit,
      qty: round2(r.qty), reorder_level: r.reorder_level,
      sold: round2(r.sold), per_day: perDay, days_cover: daysCover,
      suggest_qty: need, suggest_cost: round2(need * r.cost_price), urgency,
    });
  }
  const rank = { urgent: 0, soon: 1, watch: 2 };
  return out.sort((a, b) => rank[a.urgency] - rank[b.urgency] || b.per_day - a.per_day);
}

/** Close the books for a single day (default: today). */
export function dailyClose(date?: string): DayClose {
  const d = date ?? new Date().toISOString().slice(0, 10);
  const where = "status='final' AND date(ts_final)=?";

  const head = db
    .prepare(`SELECT COUNT(*) c, COALESCE(SUM(total),0) g, COALESCE(SUM(subtotal),0) t, COALESCE(SUM(cgst+sgst),0) tax FROM bills WHERE ${where}`)
    .get(d) as { c: number; g: number; t: number; tax: number };

  const pay = db
    .prepare(`SELECT COALESCE(payment_mode,'unknown') pm, COUNT(*) c, COALESCE(SUM(total),0) amt FROM bills WHERE ${where} GROUP BY pm`)
    .all(d) as { pm: string; c: number; amt: number }[];

  const top = db
    .prepare(
      `SELECT bi.name, SUM(bi.qty) qty, SUM(bi.line_total) rev
       FROM bill_items bi JOIN bills b ON b.id=bi.bill_id
       WHERE b.${where} GROUP BY bi.name ORDER BY rev DESC LIMIT 5`
    )
    .all(d) as { name: string; qty: number; rev: number }[];

  return {
    date: d,
    bill_count: head.c,
    gross_sales: round2(head.g),
    taxable: round2(head.t),
    tax_collected: round2(head.tax),
    by_payment: Object.fromEntries(pay.map((p) => [p.pm, { count: p.c, amount: round2(p.amt) }])),
    top_items: top.map((t) => ({ name: t.name, qty: round2(t.qty), revenue: round2(t.rev) })),
  };
}

/** Aggregate sales over a date range [from, to] inclusive. Powers the analysis deck. */
export function salesReport(from: string, to: string): SalesReport {
  const where = "status='final' AND date(ts_final) BETWEEN ? AND ?";
  const args = [from, to];

  const head = db
    .prepare(`SELECT COUNT(*) c, COALESCE(SUM(total),0) g, COALESCE(SUM(cgst+sgst),0) tax FROM bills WHERE ${where}`)
    .get(...args) as { c: number; g: number; tax: number };

  const pay = db
    .prepare(`SELECT COALESCE(payment_mode,'unknown') pm, COALESCE(SUM(total),0) amt FROM bills WHERE ${where} GROUP BY pm`)
    .all(...args) as { pm: string; amt: number }[];

  const slab = db
    .prepare(
      `SELECT bi.gst_rate, SUM(bi.taxable) taxable, SUM(bi.line_tax) tax
       FROM bill_items bi JOIN bills b ON b.id=bi.bill_id
       WHERE b.${where} GROUP BY bi.gst_rate ORDER BY bi.gst_rate`
    )
    .all(...args) as { gst_rate: number; taxable: number; tax: number }[];

  const daily = db
    .prepare(`SELECT date(ts_final) d, COALESCE(SUM(total),0) s FROM bills WHERE ${where} GROUP BY d ORDER BY d`)
    .all(...args) as { d: string; s: number }[];

  const top = db
    .prepare(
      `SELECT bi.name, SUM(bi.qty) qty, SUM(bi.line_total) rev
       FROM bill_items bi JOIN bills b ON b.id=bi.bill_id
       WHERE b.${where} GROUP BY bi.name ORDER BY rev DESC LIMIT 8`
    )
    .all(...args) as { name: string; qty: number; rev: number }[];

  const low = db
    .prepare("SELECT name, size, qty, unit, reorder_level FROM products WHERE qty <= reorder_level ORDER BY (qty-reorder_level) LIMIT 10")
    .all() as SalesReport["low_stock"];

  const khataRow = db.prepare("SELECT COALESCE(SUM(khata_balance),0) k FROM customers").get() as { k: number };

  return {
    from, to,
    bill_count: head.c,
    gross_sales: round2(head.g),
    tax_collected: round2(head.tax),
    by_payment: Object.fromEntries(pay.map((p) => [p.pm, round2(p.amt)])),
    by_slab: slab.map((s) => ({ gst_rate: s.gst_rate, taxable: round2(s.taxable), tax: round2(s.tax) })),
    daily: daily.map((x) => ({ date: x.d, sales: round2(x.s) })),
    top_items: top.map((t) => ({ name: t.name, qty: round2(t.qty), revenue: round2(t.rev) })),
    low_stock: low,
    khata_outstanding: round2(khataRow.k),
  };
}
