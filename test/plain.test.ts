import { test } from "node:test";
import assert from "node:assert/strict";
import { toPlainText } from "../src/lib/plain.js";

// Both fixtures are real replies the deployed bot sent to Telegram, where they rendered
// with literal asterisks and raw pipe rows on the owner's phone.

test("bold markers are dropped but the number survives", () => {
  const out = toPlainText("You have **50 kg** of loose sugar left (sell price ₹46/kg, MRP ₹48).");
  assert.equal(out, "You have 50 kg of loose sugar left (sell price ₹46/kg, MRP ₹48).");
  assert.ok(!out.includes("*"));
});

test("a pipe table becomes one line per row, keeping every value", () => {
  const table = [
    "Expiring soon:",
    "",
    "| Item | Qty | Expires | Days Left | Value at Cost |",
    "|---|---|---|---|---|",
    "| Britannia Bread 400g | 20 packets | 2026-07-30 | 2d | ₹800 |",
    "| Amul Taaza Milk 500ml | 40 packets | 2026-07-31 | 3d | ₹1,000 |",
  ].join("\n");
  const out = toPlainText(table);

  assert.ok(!out.includes("|"), `pipes survived: ${out}`);
  assert.ok(!out.includes("---"));
  assert.ok(out.includes("Britannia Bread 400g"));
  assert.ok(out.includes("20 packets"));
  assert.ok(out.includes("2026-07-30"));
  assert.ok(out.includes("₹800"));
  // One line per data row, not one line per cell.
  assert.equal(out.split("\n").filter((l) => l.startsWith("•")).length, 2);
});

test("headings, bullets, inline code and links are flattened", () => {
  const out = toPlainText("## Today\n- 5 bills\n- `₹1,415` total\n[docs](https://x.com)");
  assert.ok(!out.includes("#"));
  assert.ok(!out.includes("`"));
  assert.ok(out.includes("• 5 bills"));
  assert.ok(out.includes("₹1,415"));
  assert.ok(out.includes("docs (https://x.com)"));
});

test("plain text and arithmetic are left exactly alone", () => {
  const plain = "Bill #6 finalized — 2 Maggi ₹28.00, paid cash. Stock now 98 packet.";
  assert.equal(toPlainText(plain), plain);
  // A lone asterisk used as multiplication must not be eaten as italics.
  assert.equal(toPlainText("6 * 14 = 84"), "6 * 14 = 84");
});
