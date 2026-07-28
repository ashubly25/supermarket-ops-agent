import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(tmpdir(), `store-test-${process.pid}-stretch.db`);

const { db } = await import("../src/db/index.ts");
const products = await import("../src/repo/products.ts");
const batches = await import("../src/repo/batches.ts");
const bills = await import("../src/repo/bills.ts");
const khata = await import("../src/repo/khata.ts");
const analytics = await import("../src/repo/analytics.ts");
const schedules = await import("../src/repo/schedules.ts");

const day = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

function mkProduct(name: string, qty = 0, extra: Partial<any> = {}) {
  return products.addProduct({
    name, size: "1kg", unit: "packet", loose: 0, hsn: "1111",
    gst_rate: 5, cost_price: 10, mrp: 20, sell_price: 18, qty, reorder_level: 5, ...extra,
  } as any);
}

// ───────────────────────────── FEFO ─────────────────────────────

test("FEFO: the soonest-expiring batch is consumed first", () => {
  const p = mkProduct("FEFO Curd");
  products.receiveStock(p.id, 5, { expiry: day(30), batch_no: "LATE" });
  products.receiveStock(p.id, 4, { expiry: day(5), batch_no: "SOON" });

  const d = bills.createDraft("chatF");
  bills.addItem(d.id, p.id, 6);
  bills.setMeta(d.id, { payment_mode: "cash" });
  bills.finalize(d.id, `finalize-bill-${d.id}`);

  const rows = db
    .prepare("SELECT batch_no, qty FROM batches WHERE product_id=? ORDER BY expiry")
    .all(p.id) as { batch_no: string; qty: number }[];
  assert.deepEqual(rows, [{ batch_no: "SOON", qty: 0 }, { batch_no: "LATE", qty: 3 }],
    "SOON batch drains fully before LATE is touched");
  assert.equal(products.getById(p.id)!.qty, 3);
});

test("expired stock is NOT sellable and cannot be billed", () => {
  const p = mkProduct("Old Milk");
  // Backdate a batch directly — addBatch refuses past expiry at the tool layer.
  db.prepare("INSERT INTO batches (product_id, qty, cost_price, expiry) VALUES (?,?,?,?)")
    .run(p.id, 10, 10, day(-2));
  db.prepare("UPDATE products SET qty = 10 WHERE id = ?").run(p.id);

  assert.equal(batches.sellableQty(p.id), 0);
  assert.equal(batches.expiredQty(p.id), 10);

  const d = bills.createDraft("chatX");
  assert.throws(() => bills.addItem(d.id, p.id, 1), /EXPIRED|sellable/);
});

test("partly-expired stock: only the good batch can be sold", () => {
  const p = mkProduct("Mixed Paneer");
  db.prepare("INSERT INTO batches (product_id, qty, cost_price, expiry) VALUES (?,?,?,?)")
    .run(p.id, 4, 10, day(-1));
  db.prepare("UPDATE products SET qty = 4 WHERE id = ?").run(p.id);
  products.receiveStock(p.id, 3, { expiry: day(10) });

  assert.equal(batches.sellableQty(p.id), 3);
  const d = bills.createDraft("chatM");
  assert.throws(() => bills.addItem(d.id, p.id, 4), /sellable/);
  bills.addItem(d.id, p.id, 3); // the fresh batch is fine
});

test("write_off_expired removes expired stock and refuses fresh batches", () => {
  const p = mkProduct("Writeoff Bread");
  db.prepare("INSERT INTO batches (product_id, qty, cost_price, expiry) VALUES (?,?,?,?)")
    .run(p.id, 6, 10, day(-3));
  db.prepare("UPDATE products SET qty = 6 WHERE id = ?").run(p.id);
  const fresh = products.receiveStock(p.id, 2, { expiry: day(9) });
  assert.equal(fresh.qty, 8);

  const done = batches.writeOffExpired({ product_id: p.id });
  assert.equal(done.length, 1);
  assert.equal(done[0].qty, 6);
  assert.equal(products.getById(p.id)!.qty, 2, "only the expired batch leaves stock");

  const freshBatch = db.prepare("SELECT id FROM batches WHERE product_id=? AND expiry=?").get(p.id, day(9)) as { id: number };
  assert.throws(() => batches.writeOffExpired({ batch_id: freshBatch.id }), /not expired/);
  assert.equal(products.getById(p.id)!.qty, 2, "refused write-off changed nothing");
});

test("receive_stock refuses an already-past expiry date", () => {
  const p = mkProduct("Past Date Item");
  assert.throws(() => products.receiveStock(p.id, 5, { expiry: day(-1) }), /already past/);
  assert.equal(products.getById(p.id)!.qty, 0, "nothing received");
});

// ─────────────────────── Reorder from velocity ───────────────────────

test("reorder suggestions size the order from sales velocity", () => {
  const fast = mkProduct("Fast Mover", 10);
  const slow = mkProduct("Slow Mover", 200);

  // 28 units sold over the window → 2/day → needs ~2*14*1.2 = 33.6 → order 24 more.
  const d = bills.createDraft("chatR");
  bills.addItem(d.id, fast.id, 8);
  bills.setMeta(d.id, { payment_mode: "cash" });
  bills.finalize(d.id, `finalize-bill-${d.id}`);
  db.prepare("INSERT INTO stock_moves (product_id, delta, reason, ref) VALUES (?,?, 'sale', 'backfill')")
    .run(fast.id, -20);

  const rows = analytics.reorderSuggestions(14, 14);
  const f = rows.find((r) => r.product_id === fast.id);
  assert.ok(f, "fast mover appears in the reorder plan");
  assert.equal(f!.per_day, 2);
  assert.equal(f!.days_cover, 1, "2 left ÷ 2 per day");
  assert.equal(f!.urgency, "urgent");
  assert.ok(f!.suggest_qty >= 30 && f!.suggest_cost === f!.suggest_qty * 10);
  assert.ok(!rows.some((r) => r.product_id === slow.id), "well-stocked slow mover is not suggested");
});

test("velocity ignores non-sale stock moves (receive / reconcile)", () => {
  const p = mkProduct("Receive Only", 3);
  products.receiveStock(p.id, 50, {});
  const row = analytics.reorderSuggestions(14, 14).find((r) => r.product_id === p.id);
  assert.equal(row, undefined, "receiving stock is not demand");
});

// ─────────────────────── Khata reminders ───────────────────────

test("khata overdue lists only stale, still-owing customers", () => {
  khata.charge("Ramesh", 500, { note: "old" });
  khata.charge("Suresh", 300, { note: "old" });
  khata.payment("Suresh", 300);
  khata.charge("Naya", 100);

  // Age Ramesh's charge by 20 days; Naya stays fresh.
  db.prepare("UPDATE khata_txns SET ts = datetime('now','-20 days') WHERE customer_id = (SELECT id FROM customers WHERE name='Ramesh')").run();

  const rows = khata.overdue(14);
  assert.deepEqual(rows.map((r) => r.name), ["Ramesh"]);
  assert.equal(rows[0].balance, 500);
  assert.ok(rows[0].days_outstanding >= 20);
  assert.equal(khata.overdue(365).length, 0, "nothing is a year stale");
});

// ─────────────────────── Scheduling ───────────────────────

test("a due schedule fires once per slot, even if the tick repeats", () => {
  const s = schedules.upsert({ chat_id: "chatS", kind: "weekly_deck", weekday: null, hour: 0, minute: 0, enabled: 1 });
  const now = new Date();
  now.setHours(9, 30, 0, 0);

  assert.ok(schedules.due(now).some((x) => x.id === s.id), "midnight schedule is due at 09:30");
  assert.equal(schedules.claim(s, now), true, "first claim wins");
  assert.equal(schedules.claim(s, now), false, "second claim for the same slot is refused");
  assert.ok(!schedules.due(now).some((x) => x.id === s.id), "no longer due once claimed");
});

test("schedules respect weekday and paused state", () => {
  const now = new Date();
  now.setHours(23, 0, 0, 0);
  const otherDay = (now.getDay() + 1) % 7;
  const s = schedules.upsert({ chat_id: "chatW", kind: "khata_reminder", weekday: otherDay, hour: 8, minute: 0, enabled: 1 });
  assert.ok(!schedules.due(now).some((x) => x.id === s.id), "wrong weekday → not due");

  const t = schedules.upsert({ chat_id: "chatW", kind: "daily_close", weekday: null, hour: 8, minute: 0, enabled: 0 });
  assert.ok(!schedules.due(now).some((x) => x.id === t.id), "paused → not due");
});

test("notices queue and drain once", () => {
  schedules.queueNotice("chatN", "hello");
  assert.equal(schedules.takeNotices("chatN").length, 1);
  const n = schedules.takeNotices("chatN")[0];
  schedules.markNoticeSent(n.id);
  assert.equal(schedules.takeNotices("chatN").length, 0);
  assert.ok(!schedules.chatsWithPending().includes("chatN"));
});

// ─────────────────────── Barcode ───────────────────────

test("barcode links a SKU and refuses being attached to two products", () => {
  const a = mkProduct("Barcode A");
  const b = mkProduct("Barcode B");
  products.setBarcode(a.id, "8901058000221");
  assert.equal(products.getByBarcode("8901058000221")!.id, a.id);
  assert.throws(() => products.setBarcode(b.id, "8901058000221"), /already on/);
});
