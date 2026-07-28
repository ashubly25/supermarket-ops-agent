import PDFDocument from "pdfkit";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Bill, BillItem } from "../repo/bills.js";
import { ARTIFACTS_DIR } from "../config.js";
import { round2 } from "../lib/money.js";
import { rupeesInWords } from "../lib/words.js";

export type { ShopInfo } from "../lib/shop.js";
import type { ShopInfo } from "../lib/shop.js";

const R = (n: number) => "Rs. " + n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Helvetica (WinAnsi) has no ₹ glyph — owner-supplied text would print as junk. */
const ascii = (s: string) => s.replace(/₹/g, "Rs. ").replace(/[^\x00-\xFF]/g, "");

/** Render a GST-correct tax invoice PDF for a finalized bill. Returns the file path. */
export function generateInvoicePdf(bill: Bill, items: BillItem[], shop: ShopInfo, chatId: string): Promise<string> {
  const dir = join(ARTIFACTS_DIR, chatId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `invoice-${bill.id}.pdf`);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 40 });
    const stream = createWriteStream(path);
    doc.pipe(stream);
    stream.on("finish", () => resolve(path));
    stream.on("error", reject);

    const left = 40;
    const right = 555;
    const width = right - left;
    const brand = "#" + shop.brand_color;
    const modern = shop.template === "modern";

    // --- Branded header: shop identity, accent band ---
    if (modern) {
      doc.rect(0, 0, 595, 96).fill(brand);
    }
    const headText = modern ? "#FFFFFF" : "#000000";
    const subText = modern ? "#E8EEF9" : "#444444";

    const hx = left;
    doc.fontSize(18).font("Helvetica-Bold").fillColor(headText).text(ascii(shop.name), hx, 38);
    doc.fontSize(9).font("Helvetica").fillColor(subText)
      .text(ascii(shop.address), hx, 62, { width: 300 })
      .text(ascii(`GSTIN: ${shop.gstin}   |   Ph: ${shop.phone}   |   State: ${shop.state}`), hx, undefined, { width: 300 });
    doc.fillColor(headText).fontSize(13).font("Helvetica-Bold").text("TAX INVOICE", left, 38, { width, align: "right" });
    doc.fillColor(subText).fontSize(9).font("Helvetica")
      .text(`Invoice No: INV-${String(bill.id).padStart(5, "0")}`, left, 60, { width, align: "right" })
      .text(`Date: ${(bill.ts_final ?? bill.ts_created).slice(0, 19).replace("T", " ")}`, { width, align: "right" });

    // Accent rule under the header in classic mode.
    doc.moveTo(left, 100).lineTo(right, 100).lineWidth(modern ? 0 : 2).strokeColor(brand).stroke();
    doc.lineWidth(1).fillColor("#000");

    doc.fontSize(9).fillColor("#000")
      .text(ascii(`Bill to: ${bill.customer ?? "Walk-in Customer"}`), left, 110)
      .text(`Payment: ${(bill.payment_mode ?? "-").toUpperCase()}${bill.payment_ref ? " / " + bill.payment_ref : ""}`, left, 110, { width, align: "right" });

    // --- Table header ---
    let y = 135;
    // Widths sum to exactly `width` so the last column stays inside the page band.
    const spec: [string, number, "left" | "right"][] = [
      ["#", 16, "left"], ["Item", 130, "left"], ["HSN", 40, "left"], ["Qty", 46, "right"],
      ["Rate", 48, "right"], ["Taxable", 56, "right"], ["GST%", 32, "right"],
      ["CGST", 46, "right"], ["SGST", 46, "right"], ["Amount", 55, "right"],
    ];
    let cx = left;
    const cols = spec.map(([t, w, a]) => {
      const col = { t, x: cx, w, a };
      cx += w;
      return col;
    });
    doc.rect(left, y - 4, width, 18).fill(brand).fillColor("#FFFFFF");
    doc.fontSize(8).font("Helvetica-Bold");
    for (const c of cols) doc.text(c.t, c.x, y, { width: c.w, align: c.a });
    y += 18;

    doc.font("Helvetica").fontSize(8).fillColor("#000");
    items.forEach((it, i) => {
      const cgst = round2(it.line_tax / 2);
      const sgst = round2(it.line_tax - cgst);
      const row = [
        String(i + 1), ascii(it.name), it.hsn || "-", `${it.qty} ${it.unit}`,
        R(it.unit_price), R(it.taxable), `${it.gst_rate}%`, R(cgst), R(sgst), R(it.line_total),
      ];
      row.forEach((v, j) => doc.text(v, cols[j].x, y, { width: cols[j].w, align: cols[j].a }));
      y += 16;
      if (y > 720) { doc.addPage(); y = 60; }
    });

    doc.moveTo(left, y).lineTo(right, y).strokeColor("#ccc").stroke();
    y += 8;

    // --- Per-slab tax summary ---
    const bySlab = new Map<number, { taxable: number; cgst: number; sgst: number }>();
    for (const it of items) {
      const s = bySlab.get(it.gst_rate) ?? { taxable: 0, cgst: 0, sgst: 0 };
      const lineHalf = round2(it.line_tax / 2);
      s.taxable = round2(s.taxable + it.taxable);
      s.cgst = round2(s.cgst + lineHalf);
      s.sgst = round2(s.sgst + (it.line_tax - lineHalf));
      bySlab.set(it.gst_rate, s);
    }
    doc.fontSize(8).font("Helvetica-Bold").text("GST Summary", left, y);
    y += 14;
    doc.font("Helvetica");
    for (const [rate, s] of [...bySlab.entries()].sort((a, b) => a[0] - b[0])) {
      doc.text(`${rate}% on ${R(s.taxable)}  =  CGST ${R(s.cgst)} + SGST ${R(s.sgst)}`, left, y);
      y += 13;
    }

    // --- Totals block (right) ---
    const tx = left + 330;
    let ty = y - (bySlab.size * 13) - 14;
    const totalRow = (label: string, val: string, bold = false) => {
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 10 : 9);
      doc.text(label, tx, ty, { width: 120, align: "right" });
      doc.text(val, tx + 120, ty, { width: 105, align: "right" });
      ty += bold ? 18 : 14;
    };
    totalRow("Taxable value:", R(bill.subtotal));
    totalRow("CGST:", R(bill.cgst));
    totalRow("SGST:", R(bill.sgst));
    if (bill.round_off) totalRow("Round-off:", R(bill.round_off));
    totalRow("GRAND TOTAL:", R(bill.total), true);

    y = Math.max(y, ty) + 10;
    doc.font("Helvetica-Oblique").fontSize(9).text(`Amount in words: ${rupeesInWords(bill.total)}`, left, y, { width });
    y += 28;
    doc.font("Helvetica").fontSize(8).fillColor("#666")
      .text("This is a computer-generated invoice. Goods once sold are not returnable unless defective.", left, y, { width, align: "center" });
    if (shop.footer) doc.text(ascii(shop.footer), { width, align: "center" });
    doc.fillColor(brand).font("Helvetica-Bold")
      .text(ascii(`Thank you for shopping at ${shop.name}!`), { width, align: "center" });

    doc.end();
  });
}
