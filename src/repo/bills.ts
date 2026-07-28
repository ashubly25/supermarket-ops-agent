import { db, immediateTxn } from "../db/index.js";
import { getById, type Product } from "./products.js";
import * as khata from "./khata.js";
import { sellableQty, expiredQty, consumeFEFO } from "./batches.js";
import { gstBreakup, round2, roundRupee } from "../lib/money.js";

export interface Bill {
  id: number;
  chat_id: string;
  status: string;
  customer: string | null;
  payment_mode: string | null;
  payment_ref: string | null;
  subtotal: number;
  cgst: number;
  sgst: number;
  total: number;
  round_off: number;
  idempotency_key: string | null;
  ts_created: string;
  ts_final: string | null;
}

export interface BillItem {
  id: number;
  bill_id: number;
  product_id: number;
  name: string;
  hsn: string;
  qty: number;
  unit: string;
  unit_price: number;
  gst_rate: number;
  taxable: number;
  line_tax: number;
  line_total: number;
}

export class BillError extends Error {}

export function getBill(id: number): Bill | undefined {
  return db.prepare("SELECT * FROM bills WHERE id = ?").get(id) as Bill | undefined;
}

export function getItems(billId: number): BillItem[] {
  return db.prepare("SELECT * FROM bill_items WHERE bill_id = ? ORDER BY id").all(billId) as BillItem[];
}

/** Latest still-open draft for a chat, if any. */
export function currentDraft(chatId: string): Bill | undefined {
  return db
    .prepare("SELECT * FROM bills WHERE chat_id = ? AND status = 'draft' ORDER BY id DESC LIMIT 1")
    .get(chatId) as Bill | undefined;
}

export function createDraft(chatId: string): Bill {
  const info = db.prepare("INSERT INTO bills (chat_id, status) VALUES (?, 'draft')").run(chatId);
  return getBill(Number(info.lastInsertRowid))!;
}

function assertDraft(billId: number): Bill {
  const b = getBill(billId);
  if (!b) throw new BillError(`Bill #${billId} not found.`);
  if (b.status !== "draft") throw new BillError(`Bill #${billId} is already ${b.status}; cannot edit.`);
  return b;
}

/** Recompute and persist bill totals from its items. */
function recompute(billId: number): Bill {
  const items = getItems(billId);
  let subtotal = 0, cgst = 0, sgst = 0, gross = 0;
  for (const it of items) {
    subtotal = round2(subtotal + it.taxable);
    const half = round2(it.line_tax / 2);
    cgst = round2(cgst + half);
    sgst = round2(sgst + (it.line_tax - half));
    gross = round2(gross + it.line_total);
  }
  const total = roundRupee(gross);
  const roundOff = round2(total - gross);
  db.prepare("UPDATE bills SET subtotal=?, cgst=?, sgst=?, total=?, round_off=? WHERE id=?")
    .run(subtotal, cgst, sgst, total, roundOff, billId);
  return getBill(billId)!;
}

function lineFor(product: Product, qty: number) {
  const { taxable, tax, gross } = gstBreakup(product.sell_price, qty, product.gst_rate);
  return { taxable, line_tax: tax, line_total: gross };
}

/**
 * Add (or increase) a product on a draft. SOFT oversell check here against current
 * stock minus what other open drafts already claim; HARD re-check happens at finalize.
 * Below-cost sale is refused here.
 */
export function addItem(billId: number, productId: number, qty: number): { bill: Bill; items: BillItem[]; product: Product } {
  return immediateTxn(() => {
    assertDraft(billId);
    const p = getById(productId);
    if (!p) throw new BillError(`Product ${productId} not found.`);
    if (qty <= 0) throw new BillError("Quantity must be positive.");
    if (p.sell_price < p.cost_price)
      throw new BillError(`Refusing: ${p.name} sell ₹${p.sell_price} is below cost ₹${p.cost_price}.`);

    const existing = db
      .prepare("SELECT * FROM bill_items WHERE bill_id = ? AND product_id = ?")
      .get(billId, productId) as BillItem | undefined;
    const newQty = round2((existing?.qty ?? 0) + qty);

    // Available = SELLABLE stock (expired batches excluded) minus what other drafts claim.
    const sellable = sellableQty(productId);
    const claimed = claimedElsewhere(productId, billId);
    if (newQty + claimed > sellable + 1e-9) {
      const exp = expiredQty(productId);
      throw new BillError(
        `Only ${sellable} ${p.unit} of ${p.name} sellable in stock${claimed ? ` (${claimed} already on other open bills)` : ""}` +
          `${exp > 0 ? `, plus ${exp} EXPIRED which cannot be sold` : ""}; cannot put ${newQty} on this bill.`
      );
    }

    const l = lineFor(p, newQty);
    if (existing) {
      db.prepare("UPDATE bill_items SET qty=?, unit_price=?, gst_rate=?, taxable=?, line_tax=?, line_total=? WHERE id=?")
        .run(newQty, p.sell_price, p.gst_rate, l.taxable, l.line_tax, l.line_total, existing.id);
    } else {
      db.prepare(
        `INSERT INTO bill_items (bill_id, product_id, name, hsn, qty, unit, unit_price, gst_rate, taxable, line_tax, line_total)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      ).run(billId, productId, `${p.name} ${p.size}`, p.hsn, newQty, p.unit, p.sell_price, p.gst_rate, l.taxable, l.line_tax, l.line_total);
    }
    const bill = recompute(billId);
    return { bill, items: getItems(billId), product: p };
  });
}

/** Set an item to an exact qty, or remove it (qty <= 0 or remove flag). */
export function setItemQty(billId: number, productId: number, qty: number): { bill: Bill; items: BillItem[] } {
  return immediateTxn(() => {
    assertDraft(billId);
    const p = getById(productId);
    if (!p) throw new BillError(`Product ${productId} not found.`);
    const existing = db.prepare("SELECT * FROM bill_items WHERE bill_id=? AND product_id=?").get(billId, productId) as BillItem | undefined;
    if (!existing) throw new BillError(`${p.name} is not on bill #${billId}.`);

    if (qty <= 0) {
      db.prepare("DELETE FROM bill_items WHERE id = ?").run(existing.id);
    } else {
      const sellable = sellableQty(productId);
      const claimed = claimedElsewhere(productId, billId);
      if (qty + claimed > sellable + 1e-9)
        throw new BillError(`Only ${sellable} ${p.unit} of ${p.name} sellable; cannot set ${qty}.`);
      const l = lineFor(p, qty);
      db.prepare("UPDATE bill_items SET qty=?, unit_price=?, gst_rate=?, taxable=?, line_tax=?, line_total=? WHERE id=?")
        .run(qty, p.sell_price, p.gst_rate, l.taxable, l.line_tax, l.line_total, existing.id);
    }
    const bill = recompute(billId);
    return { bill, items: getItems(billId) };
  });
}

export function setMeta(billId: number, meta: { payment_mode?: string; payment_ref?: string; customer?: string }): Bill {
  assertDraft(billId);
  const sets: string[] = [];
  const params: Record<string, unknown> = { id: billId };
  if (meta.payment_mode !== undefined) { sets.push("payment_mode=@pm"); params.pm = meta.payment_mode; }
  if (meta.payment_ref !== undefined) { sets.push("payment_ref=@pr"); params.pr = meta.payment_ref; }
  if (meta.customer !== undefined) { sets.push("customer=@cu"); params.cu = meta.customer; }
  if (sets.length) db.prepare(`UPDATE bills SET ${sets.join(", ")} WHERE id=@id`).run(params);
  return getBill(billId)!;
}

/** Qty of a product locked in OTHER open drafts (concurrency-aware oversell guard). */
function claimedElsewhere(productId: number, exceptBillId: number): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(bi.qty),0) q FROM bill_items bi
       JOIN bills b ON b.id = bi.bill_id
       WHERE bi.product_id = ? AND b.status = 'draft' AND b.id != ?`
    )
    .get(productId, exceptBillId) as { q: number };
  return row.q;
}

/**
 * Finalize a draft: ONE immediate transaction — re-check stock, decrement, mark final,
 * journal stock moves, and (if credit) charge the customer's khata.
 * Idempotent: a repeated finalize with the same idempotency_key returns the existing
 * finalized bill without double-billing or double-decrementing.
 */
export function finalize(billId: number, idempotencyKey: string): { bill: Bill; items: BillItem[] } {
  return immediateTxn(() => {
    // Idempotency: has this key already finalized a bill?
    const prior = db.prepare("SELECT * FROM bills WHERE idempotency_key = ?").get(idempotencyKey) as Bill | undefined;
    if (prior) return { bill: prior, items: getItems(prior.id) };

    const b = getBill(billId);
    if (!b) throw new BillError(`Bill #${billId} not found.`);
    if (b.status === "final") return { bill: b, items: getItems(billId) };
    if (b.status !== "draft") throw new BillError(`Bill #${billId} is ${b.status}.`);

    const items = getItems(billId);
    if (items.length === 0) throw new BillError("Cannot finalize an empty bill.");

    // HARD oversell re-check against live SELLABLE stock, then decrement FEFO.
    for (const it of items) {
      const p = getById(it.product_id)!;
      const sellable = sellableQty(it.product_id);
      if (it.qty > sellable + 1e-9)
        throw new BillError(`Stock changed: only ${sellable} ${p.unit} of ${p.name} sellable, bill needs ${it.qty}. Adjust the bill.`);
    }
    // First-Expiry-First-Out: oldest-expiring batch goes out first; expired never does.
    for (const it of items) consumeFEFO(it.product_id, it.qty, String(billId));

    const bill = recompute(billId);
    db.prepare("UPDATE bills SET status='final', idempotency_key=?, ts_final=datetime('now') WHERE id=?")
      .run(idempotencyKey, billId);

    // Credit sale → khata charge.
    if (bill.payment_mode === "credit") {
      if (!bill.customer) throw new BillError("Credit bill needs a customer name for the khata.");
      khata.charge(bill.customer, bill.total, { billId, note: `Bill #${billId}` });
    }
    return { bill: getBill(billId)!, items: getItems(billId) };
  });
}
