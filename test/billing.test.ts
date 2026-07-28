import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(tmpdir(), `store-test-${process.pid}-bill.db`);

const { seed } = await import("../src/db/seed.ts");
const products = await import("../src/repo/products.ts");
const bills = await import("../src/repo/bills.ts");
const khata = await import("../src/repo/khata.ts");
const { gstBreakup, round2 } = await import("../src/lib/money.ts");

seed();
const CHAT = "test-chat";
const maggi = products.search("maggi", 1)[0];
const butter = products.search("amul butter", 1)[0];
const sugar = products.search("sugar loose", 1)[0];

test("GST breakup splits CGST/SGST equally and reverses inclusive price", () => {
  const b = gstBreakup(60, 2, 12); // Amul butter ₹60 incl 12%, qty 2
  assert.equal(b.gross, 120);
  assert.equal(round2(b.cgst + b.sgst), b.tax);
  assert.equal(round2(b.taxable + b.tax), b.gross);
  assert.equal(b.cgst, b.sgst); // even split when tax is even
});

test("multi-item draft builds and computes totals; stock NOT decremented", () => {
  const before = products.getById(maggi.id)!.qty;
  const d = bills.createDraft(CHAT);
  bills.addItem(d.id, sugar.id, 2);
  bills.addItem(d.id, maggi.id, 4);
  const { bill, items } = bills.addItem(d.id, butter.id, 1);
  assert.equal(items.length, 3);
  assert.ok(bill.total > 0);
  assert.equal(products.getById(maggi.id)!.qty, before, "draft must not touch stock");
});

test("edit: setItemQty updates and remove (qty 0) drops the line", () => {
  const d = bills.createDraft(CHAT);
  bills.addItem(d.id, maggi.id, 4);
  bills.addItem(d.id, butter.id, 1);
  bills.setItemQty(d.id, maggi.id, 6); // "make it 6 Maggi"
  let items = bills.getItems(d.id);
  assert.equal(items.find((i) => i.product_id === maggi.id)!.qty, 6);
  bills.setItemQty(d.id, butter.id, 0); // "drop the butter"
  items = bills.getItems(d.id);
  assert.equal(items.find((i) => i.product_id === butter.id), undefined);
});

test("OVERSELL guard: cannot add more than stock, even across concurrent drafts", () => {
  // Isolated product so leftover drafts from other tests don't interfere.
  const p = products.addProduct({
    name: "Oversell Widget", size: "1kg", unit: "packet", loose: 0, hsn: "8888",
    gst_rate: 5, cost_price: 5, mrp: 12, sell_price: 10, qty: 10, reorder_level: 1,
  });
  const d1 = bills.createDraft(CHAT);
  assert.throws(() => bills.addItem(d1.id, p.id, p.qty + 1), /in stock/);
  // Claim 9 in d1; a second draft can't claim 2 more (only 1 free across both).
  bills.addItem(d1.id, p.id, 9);
  const d2 = bills.createDraft(CHAT);
  assert.throws(() => bills.addItem(d2.id, p.id, 2), /in stock|other open bills/);
  bills.addItem(d2.id, p.id, 1); // exactly the last free unit is allowed
});

test("finalize decrements stock atomically and is IDEMPOTENT on retry", () => {
  const p0 = products.getById(sugar.id)!.qty;
  const d = bills.createDraft(CHAT);
  bills.addItem(d.id, sugar.id, 3);
  bills.setMeta(d.id, { payment_mode: "cash" });
  const key = `finalize-bill-${d.id}`;
  const r1 = bills.finalize(d.id, key);
  assert.equal(r1.bill.status, "final");
  assert.equal(products.getById(sugar.id)!.qty, round2(p0 - 3));
  // Retry same key → no double decrement.
  const r2 = bills.finalize(d.id, key);
  assert.equal(r2.bill.id, r1.bill.id);
  assert.equal(products.getById(sugar.id)!.qty, round2(p0 - 3), "retry must not double-decrement");
});

test("credit sale books to khata on finalize", () => {
  const d = bills.createDraft(CHAT);
  bills.addItem(d.id, maggi.id, 2);
  bills.setMeta(d.id, { payment_mode: "credit", customer: "Ramesh" });
  const { bill } = bills.finalize(d.id, `finalize-bill-${d.id}`);
  const c = khata.balance("Ramesh")!;
  assert.equal(round2(c.khata_balance), round2(bill.total));
});

test("khata: payment reduces balance; over-payment and unknown customer refused", () => {
  const c0 = khata.balance("Ramesh")!;
  khata.payment("Ramesh", 10);
  assert.equal(round2(khata.balance("Ramesh")!.khata_balance), round2(c0.khata_balance - 10));
  assert.throws(() => khata.payment("Ramesh", 99999), /exceeds/);
  assert.throws(() => khata.payment("Nobody", 10), /No khata/);
});

test("below-cost sale is refused at the tool/repo layer", () => {
  // Force a below-cost product and attempt to bill it.
  const p = products.addProduct({
    name: "Test LossLeader", size: "1kg", unit: "packet", loose: 0, hsn: "9999",
    gst_rate: 5, cost_price: 100, mrp: 120, sell_price: 90, qty: 10, reorder_level: 1,
  });
  const d = bills.createDraft(CHAT);
  assert.throws(() => bills.addItem(d.id, p.id, 1), /below cost/);
});
