import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(tmpdir(), `store-test-${process.pid}-hard.db`);

const { seed } = await import("../src/db/seed.ts");
const products = await import("../src/repo/products.ts");
const bills = await import("../src/repo/bills.ts");
const updates = await import("../src/repo/updates.ts");
const prefs = await import("../src/repo/prefs.ts");

seed();

test("ingress idempotency: a redelivered update_id is dropped", () => {
  assert.equal(updates.markProcessed(1001), true); // first time → process
  assert.equal(updates.markProcessed(1001), false); // redelivery → drop
  assert.equal(updates.markProcessed(1002), true);
});

test("preferences survive a /new session reset (only session id is cleared)", () => {
  const CHAT = "pref-chat";
  prefs.setPref(CHAT, "default_payment", "upi");
  prefs.setPref(CHAT, "__session_id", "abc-123");
  // Simulate /new: agent.resetSession deletes only __session_id.
  prefs.deletePref(CHAT, "__session_id");
  assert.equal(prefs.getPref(CHAT, "default_payment"), "upi", "durable pref must remain");
  assert.equal(prefs.getPref(CHAT, "__session_id"), undefined, "session must be cleared");
});

test("concurrency: two drafts cannot jointly oversell; stock never goes negative", () => {
  const p = products.addProduct({
    name: "Concurrency Item", size: "1kg", unit: "packet", loose: 0, hsn: "7777",
    gst_rate: 5, cost_price: 5, mrp: 12, sell_price: 10, qty: 5, reorder_level: 1,
  });
  const a = bills.createDraft("chatA");
  const b = bills.createDraft("chatB");
  bills.addItem(a.id, p.id, 5); // A claims all 5
  assert.throws(() => bills.addItem(b.id, p.id, 1), /in stock|other open bills/); // B blocked

  bills.setMeta(a.id, { payment_mode: "cash" });
  bills.finalize(a.id, `finalize-bill-${a.id}`);
  assert.equal(products.getById(p.id)!.qty, 0);
  assert.ok(products.getById(p.id)!.qty >= 0, "stock must never be negative");
});

test("finalize hard re-check catches stock that vanished after add", async () => {
  const { db } = await import("../src/db/index.ts");
  const p = products.addProduct({
    name: "Vanish Item", size: "1kg", unit: "packet", loose: 0, hsn: "7778",
    gst_rate: 5, cost_price: 5, mrp: 12, sell_price: 10, qty: 3, reorder_level: 1,
  });
  const d = bills.createDraft("chatV");
  bills.addItem(d.id, p.id, 3);
  bills.setMeta(d.id, { payment_mode: "cash" });
  // Stock disappears out-of-band (e.g. manual adjustment) between add and finalize.
  db.prepare("UPDATE products SET qty = 0 WHERE id = ?").run(p.id);
  assert.throws(() => bills.finalize(d.id, `finalize-bill-${d.id}`), /Stock changed|only/);
  assert.equal(products.getById(p.id)!.qty, 0, "failed finalize must not decrement");
});

test("empty bill cannot be finalized", () => {
  const d = bills.createDraft("chatEmpty");
  bills.setMeta(d.id, { payment_mode: "cash" });
  assert.throws(() => bills.finalize(d.id, `finalize-bill-${d.id}`), /empty/);
});
