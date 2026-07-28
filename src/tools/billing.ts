import { tool } from "../lib/tool.js";
import { z } from "zod";
import * as bills from "../repo/bills.js";
import * as products from "../repo/products.js";
import { inr, round2 } from "../lib/money.js";

export interface Ctx {
  chatId: string;
}

function ok(text: string, data?: unknown) {
  return {
    content: [{ type: "text" as const, text }],
    ...(data !== undefined ? { structuredContent: data as Record<string, unknown> } : {}),
  };
}
function err(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

/**
 * Normalise a quantity the owner stated in a sub-unit. "250 gram dal" must not become
 * qty 250 against a per-kg SKU — that is a 1000x billing error, and it only fails
 * loudly today because the oversell guard happens to catch it. Grams/millilitres are
 * converted to the product's own unit; anything else is passed through.
 */
function toProductUnit(qty: number, stated: string | undefined, productUnit: string): number {
  if (!stated) return qty;
  const from = stated.toLowerCase();
  const to = productUnit.toLowerCase();
  if (from === to) return qty;
  if (from === "g" && to === "kg") return qty / 1000;
  if (from === "kg" && to === "g") return qty * 1000;
  if (from === "ml" && to === "litre") return qty / 1000;
  if (from === "litre" && to === "ml") return qty * 1000;
  return qty; // packet/piece/dozen etc. — nothing to convert
}

/**
 * A line is always priced at the product's CURRENT sell price, so touching a line
 * whose price moved mid-draft re-prices it. That is the right number to bill, but a
 * total that shifts for a reason the owner didn't ask for looks like a bug — say it.
 */
function repriceNote(r: bills.Repriced | undefined): string {
  return r ? `⚠️ ${r.name} re-priced ${inr(r.from)} → ${inr(r.to)} (price changed since it went on this bill).\n` : "";
}

/** Human-readable running bill with per-slab GST breakup. */
export function formatBill(bill: bills.Bill, items: bills.BillItem[]): string {
  if (items.length === 0) return `Bill #${bill.id} (draft) — empty.`;
  const lines = items.map(
    (it) => `  • ${it.name} × ${it.qty} ${it.unit} @ ${inr(it.unit_price)} = ${inr(it.line_total)} (GST ${it.gst_rate}%)`
  );
  // Per-slab tax summary.
  // Accumulate the halves PER LINE, exactly as recompute() builds the bill totals.
  // Halving the slab subtotal instead would round differently and print a CGST/SGST
  // pair that contradicts the footer on the same message.
  const bySlab = new Map<number, { taxable: number; cgst: number; sgst: number }>();
  for (const it of items) {
    const s = bySlab.get(it.gst_rate) ?? { taxable: 0, cgst: 0, sgst: 0 };
    const half = round2(it.line_tax / 2);
    s.taxable = round2(s.taxable + it.taxable);
    s.cgst = round2(s.cgst + half);
    s.sgst = round2(s.sgst + (it.line_tax - half));
    bySlab.set(it.gst_rate, s);
  }
  const slabLines = [...bySlab.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([rate, s]) => `    ${rate}%: taxable ${inr(s.taxable)}, CGST ${inr(s.cgst)} + SGST ${inr(s.sgst)}`);

  const head = `Bill #${bill.id} (${bill.status})${bill.customer ? " — " + bill.customer : ""}`;
  const pay = bill.payment_mode ? `\nPayment: ${bill.payment_mode.toUpperCase()}${bill.payment_ref ? " (" + bill.payment_ref + ")" : ""}` : "";
  return (
    `${head}\n${lines.join("\n")}\n` +
    `Taxable: ${inr(bill.subtotal)}\nGST breakup:\n${slabLines.join("\n")}\n` +
    `CGST ${inr(bill.cgst)} + SGST ${inr(bill.sgst)}${bill.round_off ? `\nRound-off: ${inr(bill.round_off)}` : ""}\n` +
    `TOTAL: ${inr(bill.total)}${pay}`
  );
}

export function makeBillingTools(ctx: Ctx) {
  const draftOrCreate = () => bills.currentDraft(ctx.chatId) ?? bills.createDraft(ctx.chatId);

  const startBill = tool(
    "start_bill",
    "Start a draft bill for this chat. Usually not needed — add_bill_item auto-creates one. If a draft is already open it is returned as-is rather than a second bill being created.",
    {},
    async () => {
      // Never create a second draft alongside an open one. currentDraft() only ever
      // returns the newest, so the older bill would be orphaned — invisible to the
      // owner, yet still reserving its stock against every other sale until the
      // claim TTL expires.
      const open = bills.currentDraft(ctx.chatId);
      if (open) {
        const items = bills.getItems(open.id);
        return ok(
          `A draft is already open — continuing on it.\n${formatBill(open, items)}`,
          { bill_id: open.id, reused: true }
        );
      }
      const b = bills.createDraft(ctx.chatId);
      return ok(`Started ${formatBill(b, [])}`, { bill_id: b.id });
    }
  );

  const addBillItem = tool(
    "add_bill_item",
    "Add a product line to the current draft bill (auto-creates the draft if none is open). Resolve product_id via find_product first. Enforces the oversell guard (stock can't go negative) and refuses below-cost sales. Does NOT decrement stock — that happens only on finalize_bill.",
    {
      product_id: z.number().int().describe("products.id from find_product"),
      qty: z.number().positive().describe("Quantity in the product's unit (e.g. 2 for 2kg loose sugar, 4 for 4 packets)"),
      qty_unit: z
        .enum(["kg", "g", "litre", "ml", "packet", "piece", "dozen"])
        .optional()
        .describe("Pass ONLY when the owner stated a different unit from the product's own — e.g. '250 gram dal' on a per-kg SKU is qty=250, qty_unit='g'. It will be converted."),
    },
    async ({ product_id, qty, qty_unit }) => {
      try {
        const draft = draftOrCreate();
        const prod = products.getById(product_id);
        if (!prod) return err(`No product with id ${product_id}.`);
        const { bill, items, repriced } = bills.addItem(draft.id, product_id, toProductUnit(qty, qty_unit, prod.unit));
        return ok(repriceNote(repriced) + formatBill(bill, items), { bill_id: bill.id, total: bill.total, repriced });
      } catch (e) {
        return err((e as Error).message);
      }
    }
  );

  const setBillItem = tool(
    "set_bill_item",
    "Edit the current draft: set a product line to an exact quantity, or remove it (qty = 0 removes). Use for 'drop the butter' or 'make it 6 Maggi'.",
    {
      product_id: z.number().int(),
      qty: z.number().min(0).describe("New exact quantity; 0 removes the line"),
      qty_unit: z
        .enum(["kg", "g", "litre", "ml", "packet", "piece", "dozen"])
        .optional()
        .describe("Pass ONLY when the owner stated a different unit from the product's own; it will be converted."),
    },
    async ({ product_id, qty, qty_unit }) => {
      try {
        const draft = bills.currentDraft(ctx.chatId);
        if (!draft) return err("No open draft bill to edit.");
        const prod = products.getById(product_id);
        if (!prod) return err(`No product with id ${product_id}.`);
        const { bill, items, repriced } = bills.setItemQty(draft.id, product_id, qty > 0 ? toProductUnit(qty, qty_unit, prod.unit) : 0);
        return ok(repriceNote(repriced) + formatBill(bill, items), { bill_id: bill.id, total: bill.total, repriced });
      } catch (e) {
        return err((e as Error).message);
      }
    }
  );

  const setBillMeta = tool(
    "set_bill_meta",
    "Set payment mode / reference / customer on the current draft. payment_mode 'credit' books the total to the customer's khata on finalize (customer required).",
    {
      payment_mode: z.enum(["cash", "upi", "card", "credit"]).optional(),
      payment_ref: z.string().optional().describe("UPI/card txn reference"),
      customer: z.string().optional().describe("Customer name (required for credit)"),
    },
    async (a) => {
      try {
        const draft = bills.currentDraft(ctx.chatId);
        if (!draft) return err("No open draft bill.");
        const bill = bills.setMeta(draft.id, a);
        return ok(formatBill(bill, bills.getItems(bill.id)), { bill_id: bill.id });
      } catch (e) {
        return err((e as Error).message);
      }
    }
  );

  const showBill = tool(
    "show_bill",
    "Show the current draft bill for this chat (items, GST breakup, total).",
    {},
    async () => {
      const draft = bills.currentDraft(ctx.chatId);
      if (!draft) return ok("No open draft bill.");
      return ok(formatBill(draft, bills.getItems(draft.id)), { bill_id: draft.id });
    }
  );

  const finalizeBill = tool(
    "finalize_bill",
    "Finalize the current draft: re-checks stock, decrements it atomically, marks the bill final, and books khata if credit. Idempotent — safe to retry, will not double-bill. Ensure payment_mode is set first.",
    {},
    async () => {
      try {
        const draft = bills.currentDraft(ctx.chatId);
        if (!draft) {
          // A retried finalize (Telegram redelivery, or the model repeating itself)
          // arrives with no draft left, because the previous call consumed it. Report
          // the bill it already finalized rather than an error the model might
          // "fix" by rebuilding the whole bill.
          const done = bills.lastFinalized(ctx.chatId);
          if (done) return ok(`Already finalized — nothing further to do.\n${formatBill(done, bills.getItems(done.id))}`, { bill_id: done.id, total: done.total, idempotent_replay: true });
          return err("No open draft bill to finalize.");
        }
        if (!draft.payment_mode) return err("Set a payment mode (cash/upi/card/credit) before finalizing.");
        const key = `finalize-bill-${draft.id}`;
        const { bill, items } = bills.finalize(draft.id, key);
        return ok(`✅ Bill finalized.\n${formatBill(bill, items)}`, { bill_id: bill.id, total: bill.total });
      } catch (e) {
        return err((e as Error).message);
      }
    }
  );

  const voidBill = tool(
    "void_bill",
    "Reverse a FINALIZED bill that was wrong: restores the exact stock batches the sale consumed, reverses the khata charge if it was a credit sale, and marks the bill void. The bill is kept, not deleted — a voided bill stays on the audit trail. Requires a reason. Confirm with the owner before calling: this reverses a completed sale.",
    {
      bill_id: z.number().int().optional().describe("Bill to void; defaults to the most recently finalized bill in this chat"),
      reason: z.string().min(1).describe("Why it is being voided, in the owner's words — it is recorded on the bill"),
    },
    async ({ bill_id, reason }) => {
      try {
        const target = bill_id ?? bills.lastFinalized(ctx.chatId)?.id;
        if (!target) return err("No finalized bill to void in this chat.");
        const { bill, restored, unrestorable, khataReversed } = bills.voidBill(target, reason);
        const notes = [
          `Bill #${bill.id} voided (${reason}).`,
          restored > 0 ? `${restored} units returned to stock.` : "",
          khataReversed > 0 ? `${inr(khataReversed)} taken back off ${bill.customer}'s khata.` : "",
          unrestorable > 0 ? `⚠️ ${unrestorable} units could NOT be returned — their batch was written off since the sale.` : "",
        ].filter(Boolean);
        return ok(notes.join("\n"), { bill_id: bill.id, restored, unrestorable, khata_reversed: khataReversed });
      } catch (e) {
        return err((e as Error).message);
      }
    }
  );

  return [startBill, addBillItem, setBillItem, setBillMeta, showBill, finalizeBill, voidBill];
}
