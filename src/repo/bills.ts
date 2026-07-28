import { db, immediateTxn } from "../db/index.js";
import { getById, DISCRETE_UNITS, type Product } from "./products.js";
import * as khata from "./khata.js";
import { sellableQty, expiredQty, consumeFEFO, restoreFromBill } from "./batches.js";
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

/** Most recently finalized bill for a chat — used to answer a retried finalize. */
export function lastFinalized(chatId: string): Bill | undefined {
  return db
    .prepare("SELECT * FROM bills WHERE chat_id = ? AND status = 'final' ORDER BY id DESC LIMIT 1")
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
/**
 * Below-cost guard. `cost_price` and `sell_price` are BOTH GST-inclusive per unit
 * (schema.sql:75) — comparing them directly is like-for-like. Enforced at every
 * point a line can be priced or re-priced, not just at add time: a product's cost
 * can rise (a fresh, dearer batch) between adding a line and finalizing it.
 */
function assertNotBelowCost(p: Product): void {
  if (p.sell_price < p.cost_price)
    throw new BillError(`Refusing: ${p.name} sell ₹${p.sell_price} is below cost ₹${p.cost_price}.`);
}

/**
 * Loose vs packaged is the distinction the whole catalogue turns on, so it has to
 * mean something at the till: 2.5 kg of loose sugar is a normal sale, 2.5 packets of
 * Maggi is not a thing that exists. Without this, a mis-parsed "250 g Maggi" bills
 * 250 packets' worth of nonsense and the arithmetic all the way to the invoice is
 * internally consistent — the worst kind of wrong.
 */
export function assertSellableQuantity(p: Product, qty: number): void {
  if (DISCRETE_UNITS.has(p.unit.toLowerCase()) && !Number.isInteger(qty))
    throw new BillError(
      `${p.name} is sold by the ${p.unit} — ${qty} isn't a whole ${p.unit}. Did you mean ${Math.round(qty) || 1}?`
    );
}

/**
 * A line already on the draft, re-priced because the product's sell price moved since
 * it was added. The new price is correct — the owner is billing at today's price — but
 * it must be SAID, not slipped into a recomputed total the owner never queried.
 */
export interface Repriced {
  name: string;
  from: number;
  to: number;
}

const repricedIf = (existing: BillItem | undefined, p: Product): Repriced | undefined =>
  existing && existing.unit_price !== p.sell_price
    ? { name: p.name, from: existing.unit_price, to: p.sell_price }
    : undefined;

export function addItem(billId: number, productId: number, qty: number): { bill: Bill; items: BillItem[]; product: Product; repriced?: Repriced } {
  return immediateTxn(() => {
    assertDraft(billId);
    const p = getById(productId);
    if (!p) throw new BillError(`Product ${productId} not found.`);
    if (qty <= 0) throw new BillError("Quantity must be positive.");
    assertNotBelowCost(p);

    const existing = db
      .prepare("SELECT * FROM bill_items WHERE bill_id = ? AND product_id = ?")
      .get(billId, productId) as BillItem | undefined;
    const newQty = round2((existing?.qty ?? 0) + qty);
    assertSellableQuantity(p, newQty);

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
    return { bill, items: getItems(billId), product: p, repriced: repricedIf(existing, p) };
  });
}

/** Set an item to an exact qty, or remove it (qty <= 0 or remove flag). */
export function setItemQty(billId: number, productId: number, qty: number): { bill: Bill; items: BillItem[]; repriced?: Repriced } {
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
      assertNotBelowCost(p);
      assertSellableQuantity(p, qty);
      const l = lineFor(p, qty);
      db.prepare("UPDATE bill_items SET qty=?, unit_price=?, gst_rate=?, taxable=?, line_tax=?, line_total=? WHERE id=?")
        .run(qty, p.sell_price, p.gst_rate, l.taxable, l.line_tax, l.line_total, existing.id);
    }
    const bill = recompute(billId);
    return { bill, items: getItems(billId), repriced: qty > 0 ? repricedIf(existing, p) : undefined };
  });
}

export function setMeta(billId: number, meta: { payment_mode?: string; payment_ref?: string; customer?: string }): Bill {
  // Transactional like every other mutator: without it, the draft check and the write
  // straddle a window in which a concurrent finalize could land, and we'd stamp a
  // payment mode onto an already-final bill.
  return immediateTxn(() => {
    assertDraft(billId);
    const sets: string[] = [];
    const params: Record<string, unknown> = { id: billId };
    if (meta.payment_mode !== undefined) { sets.push("payment_mode=@pm"); params.pm = meta.payment_mode; }
    if (meta.payment_ref !== undefined) { sets.push("payment_ref=@pr"); params.pr = meta.payment_ref; }
    if (meta.customer !== undefined) { sets.push("customer=@cu"); params.cu = meta.customer; }
    if (sets.length) db.prepare(`UPDATE bills SET ${sets.join(", ")} WHERE id=@id`).run(params);
    return getBill(billId)!;
  });
}

/** A draft older than this is treated as abandoned and stops reserving stock. */
const DRAFT_CLAIM_TTL_HOURS = 12;

/**
 * Qty of a product locked in OTHER open drafts (concurrency-aware oversell guard).
 *
 * Only RECENT drafts count. Nothing ever deletes a draft the owner walked away from,
 * so without a cutoff an abandoned bill would reserve its stock forever and slowly
 * make the shop refuse sales it can actually fulfil. The reservation still fails
 * safe — a stale draft that is later finalized hits the hard re-check in finalize().
 */
function claimedElsewhere(productId: number, exceptBillId: number): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(bi.qty),0) q FROM bill_items bi
       JOIN bills b ON b.id = bi.bill_id
       WHERE bi.product_id = ? AND b.status = 'draft' AND b.id != ?
         AND b.ts_created >= datetime('now', ?)`
    )
    .get(productId, exceptBillId, `-${DRAFT_CLAIM_TTL_HOURS} hours`) as { q: number };
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

    // HARD re-check against live stock AND live cost, then decrement FEFO. Both can
    // have moved since the line was added — a dearer batch received in between would
    // otherwise book a loss-making sale.
    for (const it of items) {
      const p = getById(it.product_id)!;
      assertNotBelowCost(p);
      if (it.unit_price < p.cost_price)
        throw new BillError(`Refusing: ${p.name} is on the bill at ₹${it.unit_price} but now costs ₹${p.cost_price}. Re-price or drop the line.`);
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

/**
 * Void a finalized bill and put the store back where it was: restore the exact batches
 * the sale consumed, reverse a khata charge if it was a credit sale, and mark the bill
 * `void`. The bill row and its lines are KEPT — a voided bill is part of the audit
 * trail, and a shop that can silently delete sales cannot be reconciled.
 *
 * This exists because mis-billing is routine and the chat is the only surface there is.
 * Without it the owner's only remedy for a wrong bill is opening the database by hand.
 */
export function voidBill(billId: number, reason: string): { bill: Bill; restored: number; unrestorable: number; khataReversed: number } {
  return immediateTxn(() => {
    const b = getBill(billId);
    if (!b) throw new BillError(`Bill #${billId} not found.`);
    if (b.status === "void") throw new BillError(`Bill #${billId} is already void.`);
    if (b.status !== "final") throw new BillError(`Bill #${billId} is a ${b.status} — just edit or abandon it, nothing to void.`);
    if (!reason.trim()) throw new BillError("Give a reason for voiding — it goes on the audit trail.");

    const { restored, unrestorable } = restoreFromBill(billId);

    // A credit sale put the total on someone's khata; voiding must take it back off.
    let khataReversed = 0;
    if (b.payment_mode === "credit" && b.customer) {
      khata.payment(b.customer, b.total, `Void of bill #${billId}: ${reason}`);
      khataReversed = b.total;
    }

    db.prepare("UPDATE bills SET status='void', payment_ref = ? WHERE id = ?")
      .run(`VOID: ${reason}`.slice(0, 200), billId);
    return { bill: getBill(billId)!, restored, unrestorable, khataReversed };
  });
}
