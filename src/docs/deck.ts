import pptxgen from "pptxgenjs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SalesReport, ReorderRow } from "../repo/analytics.js";
import type { ExpiringRow } from "../repo/batches.js";
import type { ShopInfo } from "../lib/shop.js";
import { ARTIFACTS_DIR } from "../config.js";

const DARK = "111827";
const GRAY = "6B7280";
const money = (n: number) => "Rs. " + n.toLocaleString("en-IN", { maximumFractionDigits: 0 });

export interface DeckExtras {
  reorder?: ReorderRow[];
  expiring?: ExpiringRow[];
}

/** Build a PPTX analysis deck with real charts from a SalesReport. Returns the path. */
export async function generateDeckPptx(
  r: SalesReport,
  shop: ShopInfo,
  chatId: string,
  extras: DeckExtras = {}
): Promise<string> {
  const dir = join(ARTIFACTS_DIR, chatId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `analysis-${r.from}_to_${r.to}.pptx`);
  const BRAND = shop.brand_color; // owner's brand colour themes the whole deck

  const pptx = new pptxgen();
  pptx.author = shop.name;
  pptx.title = `Sales Analysis ${r.from} to ${r.to}`;
  pptx.defineLayout({ name: "W", width: 10, height: 5.63 });
  pptx.layout = "W";

  // --- Slide 1: Title + KPIs ---
  const s1 = pptx.addSlide();
  s1.background = { color: "FFFFFF" };
  s1.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 10, h: 1.4, fill: { color: BRAND } });
  s1.addText(shop.name, { x: 0.4, y: 0.25, w: 9, h: 0.5, fontSize: 26, bold: true, color: "FFFFFF" });
  s1.addText(`Sales Analysis  ·  ${r.from} → ${r.to}`, { x: 0.4, y: 0.82, w: 9, h: 0.4, fontSize: 14, color: "E5EEFF" });

  const avg = r.bill_count ? r.gross_sales / r.bill_count : 0;
  const kpis: [string, string][] = [
    ["Total Sales", money(r.gross_sales)],
    ["Bills", String(r.bill_count)],
    ["GST Collected", money(r.tax_collected)],
    ["Avg Bill", money(avg)],
    ["Khata Outstanding", money(r.khata_outstanding)],
  ];
  kpis.forEach(([label, val], i) => {
    const x = 0.4 + i * 1.9;
    s1.addShape(pptx.ShapeType.roundRect, { x, y: 1.8, w: 1.7, h: 1.2, fill: { color: "F3F6FB" }, line: { color: "DDE3EC", width: 1 }, rectRadius: 0.08 });
    s1.addText(val, { x, y: 1.95, w: 1.7, h: 0.5, fontSize: 18, bold: true, align: "center", color: DARK });
    s1.addText(label, { x, y: 2.5, w: 1.7, h: 0.4, fontSize: 10, align: "center", color: GRAY });
  });
  s1.addText(insights(r, extras), { x: 0.4, y: 3.3, w: 9.2, h: 2.0, fontSize: 12, color: DARK, bullet: { code: "2022" }, lineSpacingMultiple: 1.3 });

  // --- Slide 2: Top items (bar) + payment split (doughnut) ---
  const s2 = pptx.addSlide();
  s2.addText("Top Selling Items & Payment Mix", { x: 0.4, y: 0.2, w: 9, h: 0.5, fontSize: 20, bold: true, color: DARK });
  if (r.top_items.length) {
    s2.addChart(pptx.ChartType.bar, [{
      name: "Revenue",
      labels: r.top_items.map((t) => t.name.length > 18 ? t.name.slice(0, 17) + "…" : t.name),
      values: r.top_items.map((t) => t.revenue),
    }], { x: 0.3, y: 0.9, w: 5.7, h: 4.4, barDir: "bar", showValue: true, chartColors: [BRAND], catAxisLabelFontSize: 9, valAxisLabelFontSize: 9, showTitle: false });
  } else {
    s2.addText("No sales in range.", { x: 0.3, y: 2.5, w: 5.7, h: 0.5, align: "center", color: GRAY });
  }
  const payEntries = Object.entries(r.by_payment);
  if (payEntries.length) {
    s2.addChart(pptx.ChartType.doughnut, [{
      name: "Payments",
      labels: payEntries.map(([k]) => k.toUpperCase()),
      values: payEntries.map(([, v]) => v),
    }], { x: 6.1, y: 0.9, w: 3.6, h: 4.4, showLegend: true, legendPos: "b", showPercent: true, chartColors: ["1F6FEB", "16A34A", "F59E0B", "DC2626", "6B7280"], holeSize: 55 });
  }

  // --- Slide 3: Daily trend (line) + GST slab table ---
  const s3 = pptx.addSlide();
  s3.addText("Daily Sales Trend & GST Breakup", { x: 0.4, y: 0.2, w: 9, h: 0.5, fontSize: 20, bold: true, color: DARK });
  if (r.daily.length) {
    s3.addChart(pptx.ChartType.line, [{
      name: "Sales",
      labels: r.daily.map((d) => d.date.slice(5)),
      values: r.daily.map((d) => d.sales),
    }], { x: 0.3, y: 0.9, w: 5.9, h: 4.3, chartColors: [BRAND], lineSize: 3, showValue: false, catAxisLabelFontSize: 9, valAxisLabelFontSize: 9 });
  } else {
    s3.addText("No daily data.", { x: 0.3, y: 2.5, w: 5.9, h: 0.5, align: "center", color: GRAY });
  }
  const slabRows: pptxgen.TableRow[] = [
    [
      { text: "GST%", options: { bold: true, fill: { color: BRAND }, color: "FFFFFF" } },
      { text: "Taxable", options: { bold: true, fill: { color: BRAND }, color: "FFFFFF" } },
      { text: "Tax", options: { bold: true, fill: { color: BRAND }, color: "FFFFFF" } },
    ],
    ...r.by_slab.map((s) => [
      { text: `${s.gst_rate}%` }, { text: money(s.taxable) }, { text: money(s.tax) },
    ]),
  ];
  s3.addText("GST collected by slab", { x: 6.4, y: 0.9, w: 3.3, h: 0.3, fontSize: 12, bold: true, color: DARK });
  s3.addTable(slabRows.length > 1 ? slabRows : [...slabRows, [{ text: "—" }, { text: "—" }, { text: "—" }]], {
    x: 6.4, y: 1.25, w: 3.3, fontSize: 11, border: { type: "solid", color: "DDE3EC", pt: 1 }, rowH: 0.35,
  });

  // --- Slide 4: Stock health ---
  const s4 = pptx.addSlide();
  s4.addText("Stock Health — Reorder Now", { x: 0.4, y: 0.2, w: 9, h: 0.5, fontSize: 20, bold: true, color: DARK });
  if (r.low_stock.length) {
    const rows: pptxgen.TableRow[] = [
      ["Item", "Size", "On hand", "Reorder at"].map((t) => ({ text: t, options: { bold: true, fill: { color: BRAND }, color: "FFFFFF" } })),
      ...r.low_stock.map((p) => [
        { text: p.name }, { text: p.size }, { text: `${p.qty} ${p.unit}` }, { text: String(p.reorder_level) },
      ]),
    ];
    s4.addTable(rows, { x: 0.4, y: 0.9, w: 9.2, fontSize: 12, border: { type: "solid", color: "DDE3EC", pt: 1 }, rowH: 0.38 });
  } else {
    s4.addText("✔ All items above reorder level. Stock is healthy.", { x: 0.4, y: 2.5, w: 9.2, h: 0.6, fontSize: 16, align: "center", color: "16A34A" });
  }

  // --- Slide 5: Reorder plan from sales velocity ---
  const reorder = extras.reorder ?? [];
  if (reorder.length) {
    const s5 = pptx.addSlide();
    s5.addText("Reorder Plan — from sales velocity", { x: 0.4, y: 0.2, w: 9, h: 0.5, fontSize: 20, bold: true, color: DARK });
    const spend = reorder.reduce((a, x) => a + x.suggest_cost, 0);
    s5.addText(`Suggested purchase: ${money(spend)} across ${reorder.length} SKU(s), sized to ~2 weeks of cover.`,
      { x: 0.4, y: 0.68, w: 9.2, h: 0.3, fontSize: 11, color: GRAY });
    const urgencyColor = { urgent: "DC2626", soon: "F59E0B", watch: GRAY } as const;
    const rows: pptxgen.TableRow[] = [
      ["Item", "On hand", "Sold/day", "Days cover", "Order", "Cost"].map((t) => ({
        text: t, options: { bold: true, fill: { color: BRAND }, color: "FFFFFF" },
      })),
      ...reorder.slice(0, 10).map((x) => [
        { text: `${x.name} ${x.size}`, options: { color: urgencyColor[x.urgency] } },
        { text: `${x.qty} ${x.unit}` },
        { text: String(x.per_day) },
        { text: x.days_cover === null ? "—" : String(x.days_cover) },
        { text: `${x.suggest_qty} ${x.unit}` },
        { text: money(x.suggest_cost) },
      ]),
    ];
    s5.addTable(rows, { x: 0.4, y: 1.05, w: 9.2, fontSize: 11, border: { type: "solid", color: "DDE3EC", pt: 1 }, rowH: 0.34 });
    s5.addText("Red = under 3 days of cover.", { x: 0.4, y: 5.1, w: 9.2, h: 0.3, fontSize: 9, color: GRAY });
  }

  // --- Slide 6: Expiry watch (FEFO) ---
  const expiring = extras.expiring ?? [];
  if (expiring.length) {
    const s6 = pptx.addSlide();
    s6.addText("Expiry Watch (FEFO)", { x: 0.4, y: 0.2, w: 9, h: 0.5, fontSize: 20, bold: true, color: DARK });
    const atRisk = expiring.reduce((a, x) => a + x.value_at_cost, 0);
    s6.addText(`${money(atRisk)} of stock at risk. Sell oldest-expiry first; write off anything past date.`,
      { x: 0.4, y: 0.68, w: 9.2, h: 0.3, fontSize: 11, color: GRAY });
    const rows: pptxgen.TableRow[] = [
      ["Item", "Batch", "Qty", "Expiry", "Days left", "Value"].map((t) => ({
        text: t, options: { bold: true, fill: { color: BRAND }, color: "FFFFFF" },
      })),
      ...expiring.slice(0, 10).map((x) => [
        { text: `${x.name} ${x.size}`, options: { color: x.days_left < 0 ? "DC2626" : x.days_left <= 7 ? "F59E0B" : DARK } },
        { text: x.batch_no ?? `#${x.batch_id}` },
        { text: `${x.qty} ${x.unit}` },
        { text: x.expiry },
        { text: x.days_left < 0 ? `EXPIRED ${-x.days_left}d` : String(x.days_left) },
        { text: money(x.value_at_cost) },
      ]),
    ];
    s6.addTable(rows, { x: 0.4, y: 1.05, w: 9.2, fontSize: 11, border: { type: "solid", color: "DDE3EC", pt: 1 }, rowH: 0.34 });
  }

  await pptx.writeFile({ fileName: path });
  return path;
}

function insights(r: SalesReport, extras: DeckExtras = {}): string {
  const out: string[] = [];
  const expired = (extras.expiring ?? []).filter((e) => e.days_left < 0);
  const soon = (extras.expiring ?? []).filter((e) => e.days_left >= 0 && e.days_left <= 14);
  const urgent = (extras.reorder ?? []).filter((x) => x.urgency === "urgent");
  const tail = () => {
    if (urgent.length) out.push(`${urgent.length} SKU(s) under 3 days of cover — order today (${urgent.map((u) => u.name).slice(0, 3).join(", ")}).`);
    if (expired.length) out.push(`${expired.length} expired batch(es) still on the shelf — write off ${money(expired.reduce((a, e) => a + e.value_at_cost, 0))}.`);
    else if (soon.length) out.push(`${soon.length} batch(es) expire within 14 days — push them first (FEFO).`);
    return out.join("\n");
  };
  if (r.bill_count === 0) {
    out.push("No finalized sales in this period.");
    return tail();
  }
  const top = r.top_items[0];
  if (top) out.push(`Best seller: ${top.name} — ${money(top.revenue)} across ${top.qty} units.`);
  const pays = Object.entries(r.by_payment).sort((a, b) => b[1] - a[1]);
  if (pays[0]) out.push(`Most sales via ${pays[0][0].toUpperCase()} (${money(pays[0][1])}).`);
  out.push(`GST liability for the period: ${money(r.tax_collected)}.`);
  if (r.khata_outstanding > 0) out.push(`Khata outstanding to collect: ${money(r.khata_outstanding)}.`);
  if (r.low_stock.length) out.push(`${r.low_stock.length} item(s) at/below reorder level — restock to avoid lost sales.`);
  return tail();
}
