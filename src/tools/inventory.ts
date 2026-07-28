import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import * as products from "../repo/products.js";
import * as batches from "../repo/batches.js";
import { inr } from "../lib/money.js";

/** Compact human-readable product line for the model + owner. */
function line(p: products.Product): string {
  const tag = p.loose ? " (loose)" : "";
  const expired = batches.expiredQty(p.id);
  const exp = expired > 0 ? `, ${expired} EXPIRED (not sellable)` : "";
  const code = p.barcode ? `, barcode ${p.barcode}` : "";
  return `#${p.id} ${p.name} ${p.size}${tag} — stock ${p.qty} ${p.unit}${exp}, sell ${inr(p.sell_price)}, MRP ${inr(p.mrp)}, GST ${p.gst_rate}% (HSN ${p.hsn})${code}`;
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

export const findProduct = tool(
  "find_product",
  "Search the catalogue for products by free-text name (e.g. 'atta', 'amul butter', 'maggi'). Returns ranked candidates with id, price, GST and current stock. ALWAYS use this to resolve a product before billing or receiving stock — never invent a product or price.",
  { query: z.string().describe("Free-text product name the owner typed") },
  async ({ query }) => {
    const found = products.search(query, 6);
    if (found.length === 0) return ok(`No product matches "${query}". It may need to be added with add_product.`, { candidates: [] });
    const text = found.map(line).join("\n");
    return ok(text, { candidates: found });
  }
);

export const getStock = tool(
  "get_stock",
  "Get current stock and price detail for a specific product id (resolve the id via find_product first).",
  { product_id: z.number().int().describe("products.id") },
  async ({ product_id }) => {
    const p = products.getById(product_id);
    if (!p) return err(`No product with id ${product_id}.`);
    return ok(line(p), { product: p });
  }
);

export const lowStock = tool(
  "low_stock",
  "List all products at or below their reorder level — i.e. what is running out and should be reordered.",
  {},
  async () => {
    const list = products.lowStock();
    if (list.length === 0) return ok("Nothing is below reorder level. Stock looks healthy.", { low: [] });
    const text = "Running low / reorder:\n" + list.map((p) => `${line(p)} — reorder at ${p.reorder_level}`).join("\n");
    return ok(text, { low: list });
  }
);

export const addProduct = tool(
  "add_product",
  "Add a NEW product to the catalogue. Only call after confirming it doesn't already exist (via find_product). Ask the owner for any missing GST rate / HSN / prices rather than guessing.",
  {
    name: z.string().describe("Brand + item, e.g. 'Amul Butter'"),
    size: z.string().describe("Pack size, e.g. '100g', '1L', or 'loose' for by-weight items"),
    unit: z.enum(["kg", "g", "litre", "ml", "packet", "dozen", "piece"]),
    loose: z.boolean().default(false).describe("true if sold loose by weight/volume"),
    gst_rate: z.number().describe("GST slab %: 0, 5, 12 or 18"),
    hsn: z.string().default("").describe("HSN code if known"),
    cost_price: z.number().describe("Purchase cost per unit"),
    mrp: z.number().describe("Maximum retail price"),
    sell_price: z.number().describe("Selling price (GST-inclusive)"),
    qty: z.number().default(0).describe("Opening stock quantity"),
    reorder_level: z.number().default(0),
  },
  async (a) => {
    const dupe = products.search(`${a.name} ${a.size}`, 1)[0];
    if (dupe && dupe.score >= 0.99)
      return err(`"${dupe.name} ${dupe.size}" already exists as #${dupe.id}. Use receive_stock to add quantity instead.`);
    if (a.sell_price < a.cost_price)
      return err(`Refusing: sell price ${inr(a.sell_price)} is below cost ${inr(a.cost_price)}. Confirm the numbers.`);
    const p = products.addProduct({
      name: a.name, size: a.size, unit: a.unit, loose: a.loose ? 1 : 0,
      hsn: a.hsn, gst_rate: a.gst_rate, cost_price: a.cost_price, mrp: a.mrp,
      sell_price: a.sell_price, qty: a.qty, reorder_level: a.reorder_level,
    });
    return ok(`Added ${line(p)}`, { product: p });
  }
);

export const receiveStock = tool(
  "receive_stock",
  "Record incoming stock for an existing product (goods received). Increments quantity and optionally updates cost / MRP / sell price. Resolve product_id via find_product first.",
  {
    product_id: z.number().int(),
    qty: z.number().positive().describe("Quantity received, in the product's unit"),
    cost_price: z.number().optional().describe("New per-unit cost if it changed"),
    mrp: z.number().optional(),
    sell_price: z.number().optional(),
    expiry: z.string().optional().describe("Batch expiry date YYYY-MM-DD, for perishables (milk, bread, curd, eggs). Ask the owner if the item is perishable and they didn't say."),
    batch_no: z.string().optional().describe("Supplier batch/lot number if the owner gives one"),
  },
  async (a) => {
    const p0 = products.getById(a.product_id);
    if (!p0) return err(`No product with id ${a.product_id}.`);
    try {
      const p = products.receiveStock(a.product_id, a.qty, {
        cost: a.cost_price, mrp: a.mrp, sell: a.sell_price,
        expiry: a.expiry ?? null, batch_no: a.batch_no ?? null,
      });
      const tag = a.expiry ? ` as a batch expiring ${a.expiry}` : "";
      return ok(`Received ${a.qty} ${p.unit}${tag}. ${line(p)}`, { product: p });
    } catch (e) {
      return err((e as Error).message);
    }
  }
);

export const expiringSoon = tool(
  "expiring_soon",
  "List stock batches that are expiring within N days (or already expired). Use for 'what's expiring?', 'anything going bad?', expiry/FEFO checks, and before pushing perishables.",
  { days: z.number().int().default(30).describe("Look-ahead window in days") },
  async ({ days }) => {
    const rows = batches.expiringSoon(days);
    if (rows.length === 0) return ok(`Nothing expiring in the next ${days} days.`, { expiring: [] });
    const text = rows
      .map((r) =>
        r.days_left < 0
          ? `⚠️ EXPIRED ${-r.days_left}d ago — ${r.name} ${r.size} batch ${r.batch_no ?? "#" + r.batch_id}: ${r.qty} ${r.unit} (${inr(r.value_at_cost)} at cost). Write it off.`
          : `${r.name} ${r.size} batch ${r.batch_no ?? "#" + r.batch_id}: ${r.qty} ${r.unit}, expires ${r.expiry} (${r.days_left}d left, ${inr(r.value_at_cost)} at cost)`
      )
      .join("\n");
    return ok(text, { expiring: rows });
  }
);

export const writeOffExpired = tool(
  "write_off_expired",
  "Write off EXPIRED stock — removes it from sellable quantity and journals the loss. Refuses any batch that is not actually past its expiry date. Confirm with the owner before calling; this destroys stock value.",
  {
    product_id: z.number().int().optional().describe("Write off all expired batches of this product"),
    batch_id: z.number().int().optional().describe("Write off one specific batch"),
  },
  async (a) => {
    try {
      const done = batches.writeOffExpired({ product_id: a.product_id, batch_id: a.batch_id });
      if (done.length === 0) return ok("Nothing expired to write off.", { written_off: [] });
      const qty = done.reduce((s, d) => s + d.qty, 0);
      return ok(`Wrote off ${done.length} expired batch(es), ${qty} units total.`, { written_off: done });
    } catch (e) {
      return err((e as Error).message);
    }
  }
);

export const findByBarcode = tool(
  "find_by_barcode",
  "Look up a product by its barcode/EAN digits — use when the owner sends a photo of a barcode or types the digits. If nothing matches, fall back to find_product on the visible brand name, then offer to link the barcode with set_barcode.",
  { barcode: z.string().describe("The barcode digits, e.g. '8901058000221'") },
  async ({ barcode }) => {
    const p = products.getByBarcode(barcode);
    if (!p) return ok(`No product is linked to barcode ${barcode} yet.`, { product: null, barcode });
    return ok(line(p), { product: p });
  }
);

export const setBarcode = tool(
  "set_barcode",
  "Link a barcode/EAN to an existing product so future scans resolve instantly. Resolve product_id via find_product first.",
  { product_id: z.number().int(), barcode: z.string() },
  async ({ product_id, barcode }) => {
    if (!products.getById(product_id)) return err(`No product with id ${product_id}.`);
    try {
      const p = products.setBarcode(product_id, barcode);
      return ok(`Linked barcode ${barcode} → ${p.name} ${p.size}.`, { product: p });
    } catch (e) {
      return err((e as Error).message);
    }
  }
);

export const inventoryTools = [
  findProduct, getStock, lowStock, addProduct, receiveStock,
  expiringSoon, writeOffExpired, findByBarcode, setBarcode,
];
