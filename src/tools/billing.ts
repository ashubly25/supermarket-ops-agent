import { tool } from "../lib/tool.js";
import { z } from "zod";
import * as bills from "../repo/bills.js";
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

/** Human-readable running bill with per-slab GST breakup. */
export function formatBill(bill: bills.Bill, items: bills.BillItem[]): string {
  if (items.length === 0) return `Bill #${bill.id} (draft) — empty.`;
  const lines = items.map(
    (it) => `  • ${it.name} × ${it.qty} ${it.unit} @ ${inr(it.unit_price)} = ${inr(it.line_total)} (GST ${it.gst_rate}%)`
  );
  // Per-slab tax summary.
  const bySlab = new Map<number, { taxable: number; tax: number }>();
  for (const it of items) {
    const s = bySlab.get(it.gst_rate) ?? { taxable: 0, tax: 0 };
    s.taxable = round2(s.taxable + it.taxable);
    s.tax = round2(s.tax + it.line_tax);
    bySlab.set(it.gst_rate, s);
  }
  const slabLines = [...bySlab.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([rate, s]) => `    ${rate}%: taxable ${inr(s.taxable)}, CGST ${inr(round2(s.tax / 2))} + SGST ${inr(round2(s.tax - s.tax / 2))}`);

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
    "Start a new draft bill for this chat. Usually not needed — add_bill_item auto-creates a draft. Use to force a fresh bill.",
    {},
    async () => {
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
    },
    async ({ product_id, qty }) => {
      try {
        const draft = draftOrCreate();
        const { bill, items } = bills.addItem(draft.id, product_id, qty);
        return ok(formatBill(bill, items), { bill_id: bill.id, total: bill.total });
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
    },
    async ({ product_id, qty }) => {
      try {
        const draft = bills.currentDraft(ctx.chatId);
        if (!draft) return err("No open draft bill to edit.");
        const { bill, items } = bills.setItemQty(draft.id, product_id, qty);
        return ok(formatBill(bill, items), { bill_id: bill.id, total: bill.total });
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
        if (!draft) return err("No open draft bill to finalize.");
        if (!draft.payment_mode) return err("Set a payment mode (cash/upi/card/credit) before finalizing.");
        const key = `finalize-bill-${draft.id}`;
        const { bill, items } = bills.finalize(draft.id, key);
        return ok(`✅ Bill finalized.\n${formatBill(bill, items)}`, { bill_id: bill.id, total: bill.total });
      } catch (e) {
        return err((e as Error).message);
      }
    }
  );

  return [startBill, addBillItem, setBillItem, setBillMeta, showBill, finalizeBill];
}
