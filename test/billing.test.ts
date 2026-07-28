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
const { db } = await import("../src/db/index.ts");
const { makeBillingTools, formatBill } = await import("../src/tools/billing.ts");

seed();
const CHAT = "test-chat";
const maggi = products.search("maggi", 1)[0];
const butter = products.search("amul butter", 1)[0];
const sugar = products.search("sugar loose", 1)[0];
/** The seeded catalogue, snapshotted so margin checks ignore other tests' fixtures. */
const SKU_NAMES: string[] = (db.prepare("SELECT name FROM products ORDER BY id").all() as { name: string }[]).map((r) => r.name);

test("GST breakup splits CGST/SGST equally and reverses inclusive price", () => {
  const b = gstBreakup(21, 2, 5); // ₹21 incl 5%, qty 2 → tax ₹2.00, splits evenly
  assert.equal(b.gross, 42);
  assert.equal(round2(b.cgst + b.sgst), b.tax);
  assert.equal(round2(b.taxable + b.tax), b.gross);
  assert.equal(b.cgst, b.sgst); // even split when tax is even

  // Odd paise: the halves must still sum to the tax exactly, SGST absorbing the extra.
  const odd = gstBreakup(110, 3, 5); // tax ₹15.71
  assert.equal(round2(odd.cgst + odd.sgst), odd.tax);
  assert.equal(round2(odd.cgst - odd.sgst), 0.01);
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

test("khata: payment reduces balance; unknown customer refused", () => {
  const c0 = khata.balance("Ramesh")!;
  khata.payment("Ramesh", 10);
  assert.equal(round2(khata.balance("Ramesh")!.khata_balance), round2(c0.khata_balance - 10));
  assert.throws(() => khata.payment("Nobody", 10), /No khata/);
});

test("khata: paying more than owed leaves an advance, not an error", () => {
  khata.charge("Advance Test", 100);
  khata.payment("Advance Test", 150); // hands over a bigger note, "keep it for next time"
  assert.equal(round2(khata.balance("Advance Test")!.khata_balance), -50, "shop now owes 50 back");
  khata.charge("Advance Test", 30); // next purchase eats into the advance
  assert.equal(round2(khata.balance("Advance Test")!.khata_balance), -20);
});

test("below-cost sale is refused at the tool/repo layer", () => {
  // A below-cost SKU can no longer be created through addProduct...
  assert.throws(
    () =>
      products.addProduct({
        name: "Test LossLeader", size: "1kg", unit: "packet", loose: 0, hsn: "9999",
        gst_rate: 5, cost_price: 100, mrp: 120, sell_price: 90, qty: 10, reorder_level: 1,
      }),
    /below cost/i,
    "addProduct must refuse a sell price under cost"
  );

  // ...but it still arises the realistic way: the SKU was fine, then the wholesaler's
  // price went up. Billing it must be refused at add time, not discovered at close.
  const p = products.addProduct({
    name: "Test LossLeader", size: "1kg", unit: "packet", loose: 0, hsn: "9999",
    gst_rate: 5, cost_price: 80, mrp: 120, sell_price: 90, qty: 10, reorder_level: 1,
  });
  db.prepare("UPDATE products SET cost_price = 100 WHERE id = ?").run(p.id);

  const d = bills.createDraft(CHAT);
  assert.throws(() => bills.addItem(d.id, p.id, 1), /below cost/);
});

// ── Regressions from the pre-deploy QA audit ────────────────────────────────

test("below-cost cannot be smuggled in via receive_stock, re-price, or finalize", () => {
  const p = products.addProduct({
    name: "Margin Guard", size: "1kg", unit: "packet", loose: 0, hsn: "1101",
    gst_rate: 5, cost_price: 80, mrp: 150, sell_price: 110, qty: 20, reorder_level: 1,
  });
  // 1. receive_stock must not leave the SKU priced under cost
  assert.throws(() => products.receiveStock(p.id, 5, { sell: 50 }), /below cost/i);
  // 2. re-pricing a line after cost rises must be refused
  const d = bills.createDraft("margin");
  bills.addItem(d.id, p.id, 1);
  db.prepare("UPDATE products SET cost_price = 999 WHERE id = ?").run(p.id);
  assert.throws(() => bills.setItemQty(d.id, p.id, 3), /below cost/i);
  // 3. finalize must re-validate margin, not just stock
  bills.setMeta(d.id, { payment_mode: "cash" });
  assert.throws(() => bills.finalize(d.id, "margin-key"), /below cost|now costs/i);
  assert.equal(bills.getBill(d.id)!.status, "draft", "must not finalize a loss-making bill");
});

test("per-slab GST lines reconcile exactly with the bill footer", () => {
  const p = products.addProduct({
    name: "Odd Paise", size: "1kg", unit: "packet", loose: 0, hsn: "1101",
    gst_rate: 5, cost_price: 80, mrp: 130, sell_price: 110, qty: 30, reorder_level: 1,
  });
  const d = bills.createDraft("slabs");
  bills.addItem(d.id, p.id, 3); // line_tax has an odd paisa
  const bill = bills.getBill(d.id)!;
  const items = bills.getItems(d.id);
  const text = formatBill(bill, items);
  const slab = text.match(/CGST ₹([\d.,]+) \+ SGST ₹([\d.,]+)/g)!;
  assert.equal(slab.length, 2, "one slab line + the footer");
  assert.equal(slab[0], slab[1], "slab line must not contradict the footer");
  assert.equal(round2(bill.cgst + bill.sgst + bill.subtotal + bill.round_off), bill.total);
});

test("a retried finalize reports the finalized bill instead of erroring", async () => {
  const p = products.search("Tata Salt", 1)[0];
  const tools = Object.fromEntries(makeBillingTools({ chatId: "retry" }).map((t: any) => [t.name, t]));
  await tools.add_bill_item.def.execute({ product_id: p.id, qty: 2 }, {} as any);
  await tools.set_bill_meta.def.execute({ payment_mode: "cash" }, {} as any);
  const first = String(await tools.finalize_bill.def.execute({}, {} as any));
  assert.match(first, /finalized/i);
  const retry = String(await tools.finalize_bill.def.execute({}, {} as any));
  assert.doesNotMatch(retry, /^ERROR/, "a benign retry must not surface as an error");
  assert.match(retry, /Already finalized/i);
});

test("a quantity stated in grams is converted, not billed 1000x", async () => {
  const dal = products.search("Toor Dal", 1)[0];
  const tools = Object.fromEntries(makeBillingTools({ chatId: "grams" }).map((t: any) => [t.name, t]));
  const out = String(await tools.add_bill_item.def.execute({ product_id: dal.id, qty: 250, qty_unit: "g" }, {} as any));
  assert.doesNotMatch(out, /^ERROR/, out);
  const items = bills.getItems(bills.currentDraft("grams")!.id);
  assert.equal(items[0].qty, 0.25, "250 g against a per-kg SKU is 0.25 kg");
});

test("start_bill never opens a second draft alongside an open one", async () => {
  const tools = Object.fromEntries(makeBillingTools({ chatId: "twodrafts" }).map((t: any) => [t.name, t]));
  const first = String(await tools.start_bill.def.execute({}, {} as any));
  const id = bills.currentDraft("twodrafts")!.id;
  await tools.add_bill_item.def.execute({ product_id: maggi.id, qty: 3 }, {} as any);
  const second = String(await tools.start_bill.def.execute({}, {} as any));
  assert.match(second, /already open/i);
  assert.equal(bills.currentDraft("twodrafts")!.id, id, "must reuse the draft, not orphan it");
  const open = db.prepare("SELECT COUNT(*) c FROM bills WHERE chat_id='twodrafts' AND status='draft'").get() as { c: number };
  assert.equal(open.c, 1, "a second draft would silently reserve stock the owner cannot see");
  assert.match(first, /Bill #/);
});

test("a line re-priced mid-draft is announced, not silently absorbed", async () => {
  const p = products.search("Colgate", 1)[0];
  const tools = Object.fromEntries(makeBillingTools({ chatId: "reprice" }).map((t: any) => [t.name, t]));
  await tools.add_bill_item.def.execute({ product_id: p.id, qty: 2 }, {} as any);
  const before = bills.getBill(bills.currentDraft("reprice")!.id)!.total;
  db.prepare("UPDATE products SET sell_price = ? WHERE id = ?").run(p.sell_price + 10, p.id);
  const out = String(await tools.set_bill_item.def.execute({ product_id: p.id, qty: 2 }, {} as any));
  assert.match(out, /re-priced/i, "a total that moves on its own must be explained");
  const after = bills.getBill(bills.currentDraft("reprice")!.id)!.total;
  assert.ok(after > before, `expected the new price to apply: ${before} -> ${after}`);
  db.prepare("UPDATE products SET sell_price = ? WHERE id = ?").run(p.sell_price, p.id);
});

test("setMeta refuses a bill that is no longer a draft", () => {
  const p = products.search("Lux", 1)[0];
  const b = bills.createDraft("metaguard");
  bills.addItem(b.id, p.id, 1);
  bills.setMeta(b.id, { payment_mode: "cash" });
  bills.finalize(b.id, "k-metaguard");
  assert.throws(() => bills.setMeta(b.id, { payment_mode: "upi" }), /already final/i);
});

test("packaged goods cannot be sold in fractions; loose goods can", () => {
  const b = bills.createDraft("wholeunits");
  assert.throws(
    () => bills.addItem(b.id, maggi.id, 2.5),
    /whole packet/i,
    "2.5 packets of Maggi is not a thing that exists"
  );
  const { items } = bills.addItem(b.id, sugar.id, 2.5);
  assert.equal(items[0].qty, 2.5, "2.5 kg of loose sugar is a normal sale");
  bills.addItem(b.id, maggi.id, 3);
  assert.throws(() => bills.setItemQty(b.id, maggi.id, 1.5), /whole packet/i);
});

test("stock-in refuses a fractional count of a packaged good", () => {
  assert.throws(() => products.receiveStock(maggi.id, 10.5, {}), /whole packet/i);
  const before = products.getById(sugar.id)!.qty;
  products.receiveStock(sugar.id, 12.5, {});
  assert.equal(products.getById(sugar.id)!.qty, before + 12.5, "loose stock arrives by weight");
});

test("seeded margins are real kirana trade margins, not invented ones", () => {
  // Seeded SKUs only — other tests create fixture products with deliberately silly prices.
  const seeded = SKU_NAMES.map(() => "?").join(",");
  const rows = db.prepare(`SELECT name, cost_price c, sell_price s FROM products WHERE name IN (${seeded})`).all(...SKU_NAMES) as any[];
  assert.equal(rows.length, SKU_NAMES.length, "every seeded SKU must be present");
  for (const r of rows) {
    const m = ((r.s - r.c) / r.c) * 100;
    assert.ok(m > 0, `${r.name} must sell above cost`);
    assert.ok(m <= 15, `${r.name} at ${m.toFixed(1)}% is far above a real kirana margin`);
  }
  const blended = rows.reduce((a, r) => a + ((r.s - r.c) / r.c) * 100, 0) / rows.length;
  assert.ok(blended >= 6 && blended <= 12, `blended margin ${blended.toFixed(1)}% should sit near 10%`);
});

// ── Correcting mistakes without leaving the chat ────────────────────────────

test("void_bill restores the exact batches, reverses khata, and keeps the audit trail", () => {
  const p = products.addProduct({
    name: "Voidable Item", size: "1kg", unit: "packet", loose: 0, hsn: "1101",
    gst_rate: 5, cost_price: 80, mrp: 120, sell_price: 100, qty: 0, reorder_level: 1,
  });
  // Two dated batches so FEFO has a real choice, and the restore must hit both.
  products.receiveStock(p.id, 4, { expiry: "2099-01-01" });
  products.receiveStock(p.id, 6, { expiry: "2099-06-01" });
  const before = products.getById(p.id)!.qty;

  const d = bills.createDraft("voiding");
  bills.addItem(d.id, p.id, 7); // spans both batches: 4 from the first, 3 from the second
  bills.setMeta(d.id, { payment_mode: "credit", customer: "VoidCustomer" });
  const { bill } = bills.finalize(d.id, `finalize-bill-${d.id}`);
  assert.equal(products.getById(p.id)!.qty, before - 7);
  assert.equal(round2(khata.balance("VoidCustomer")!.khata_balance), round2(bill.total));

  const r = bills.voidBill(bill.id, "billed the wrong customer");
  assert.equal(r.restored, 7, "every unit must come back");
  assert.equal(r.unrestorable, 0);
  assert.equal(products.getById(p.id)!.qty, before, "stock restored to pre-sale level");
  assert.equal(round2(khata.balance("VoidCustomer")!.khata_balance), 0, "khata charge reversed");
  assert.equal(bills.getBill(bill.id)!.status, "void");
  assert.equal(bills.getItems(bill.id).length, 1, "lines are KEPT — a void is auditable, not a delete");

  // Batches, not just the total: FEFO must be able to sell the same 7 again.
  const b2 = bills.createDraft("voiding2");
  bills.addItem(b2.id, p.id, 7);
  assert.equal(bills.getItems(b2.id)[0].qty, 7);
});

test("void_bill refuses a draft, a double void, and a missing reason", () => {
  const d = bills.createDraft("voidguards");
  bills.addItem(d.id, maggi.id, 1);
  assert.throws(() => bills.voidBill(d.id, "nope"), /draft/i, "a draft is abandoned, not voided");
  bills.setMeta(d.id, { payment_mode: "cash" });
  const { bill } = bills.finalize(d.id, `finalize-bill-${d.id}`);
  assert.throws(() => bills.voidBill(bill.id, "   "), /reason/i);
  bills.voidBill(bill.id, "duplicate entry");
  assert.throws(() => bills.voidBill(bill.id, "again"), /already void/i);
});

test("adjust_stock records breakage and a stock-take, and cannot go negative", () => {
  const p = products.addProduct({
    name: "Breakable Item", size: "1L", unit: "packet", loose: 0, hsn: "2202",
    gst_rate: 5, cost_price: 30, mrp: 45, sell_price: 40, qty: 0, reorder_level: 1,
  });
  products.receiveStock(p.id, 20, {});
  products.adjustStock(p.id, -2, "two bottles broke in transit");
  assert.equal(products.getById(p.id)!.qty, 18);
  products.adjustStock(p.id, 3, "found a crate behind the fridge");
  assert.equal(products.getById(p.id)!.qty, 21);
  assert.throws(() => products.adjustStock(p.id, -99, "stock-take"), /negative/i);
  assert.throws(() => products.adjustStock(p.id, -1, "  "), /reason/i);
  assert.throws(() => products.adjustStock(p.id, 0, "nothing"), /zero/i);
  assert.throws(() => products.adjustStock(p.id, -1.5, "half a packet"), /whole packet/i);
  // The correction must remain sellable stock, and must NOT read as demand.
  assert.equal(bills.getItems(bills.addItem(bills.createDraft("adj").id, p.id, 21).bill.id)[0].qty, 21);
  const dem = db.prepare("SELECT COUNT(*) c FROM stock_moves WHERE product_id=? AND reason='sale'").get(p.id) as any;
  assert.equal(dem.c, 0, "adjustments are journalled as 'adjust', never as sales");
});

test("a voided bill drops out of the day's sales figures", async () => {
  const analytics = await import("../src/repo/analytics.ts");
  const p = products.addProduct({
    name: "Void Analytics", size: "1kg", unit: "packet", loose: 0, hsn: "1101",
    gst_rate: 5, cost_price: 80, mrp: 130, sell_price: 120, qty: 50, reorder_level: 1,
  });
  const d = bills.createDraft("voidanalytics");
  bills.addItem(d.id, p.id, 2);
  bills.setMeta(d.id, { payment_mode: "cash" });
  const { bill } = bills.finalize(d.id, `finalize-bill-${d.id}`);
  const today = new Date().toISOString().slice(0, 10);
  const withSale = analytics.dailyClose(today).gross_sales;
  assert.ok(withSale >= bill.total, "the sale should be in today's close");
  bills.voidBill(bill.id, "test void");
  assert.equal(round2(analytics.dailyClose(today).gross_sales), round2(withSale - bill.total),
    "a voided bill must not be counted as revenue");
});
