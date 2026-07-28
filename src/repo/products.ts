import { db, immediateTxn } from "../db/index.js";
import { matchScore } from "../lib/fuzzy.js";
import { addBatch } from "./batches.js";

export interface Product {
  id: number;
  name: string;
  size: string;
  unit: string;
  loose: number;
  hsn: string;
  gst_rate: number;
  cost_price: number;
  mrp: number;
  sell_price: number;
  qty: number;
  reorder_level: number;
  barcode: string | null;
  perishable: number;
}

export function getByBarcode(code: string): Product | undefined {
  return db.prepare("SELECT * FROM products WHERE barcode = ?").get(code.trim()) as Product | undefined;
}

export function setBarcode(productId: number, code: string): Product {
  const clash = getByBarcode(code);
  if (clash && clash.id !== productId)
    throw new Error(`Barcode ${code} is already on "${clash.name} ${clash.size}" (#${clash.id}).`);
  db.prepare("UPDATE products SET barcode = ? WHERE id = ?").run(code.trim(), productId);
  return getById(productId)!;
}

export function getById(id: number): Product | undefined {
  return db.prepare("SELECT * FROM products WHERE id = ?").get(id) as Product | undefined;
}

/** Ranked candidate list for a free-text query. Empty query → all products. */
export function search(query: string, limit = 5): Array<Product & { score: number }> {
  const all = db.prepare("SELECT * FROM products").all() as Product[];
  if (!query.trim()) return all.slice(0, limit).map((p) => ({ ...p, score: 1 }));
  return all
    .map((p) => ({ ...p, score: matchScore(query, p.name, p.size) }))
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function lowStock(): Product[] {
  return db
    .prepare("SELECT * FROM products WHERE qty <= reorder_level ORDER BY (qty - reorder_level) ASC")
    .all() as Product[];
}

export function addProduct(p: Omit<Product, "id" | "barcode" | "perishable"> & { barcode?: string | null; perishable?: number }): Product {
  return immediateTxn(() => {
    const info = db
      .prepare(
        `INSERT INTO products (name, size, unit, loose, hsn, gst_rate, cost_price, mrp, sell_price, qty, reorder_level, barcode, perishable)
         VALUES (@name,@size,@unit,@loose,@hsn,@gst_rate,@cost_price,@mrp,@sell_price,@qty,@reorder_level,@barcode,@perishable)`
      )
      .run({ ...p, barcode: p.barcode ?? null, perishable: p.perishable ?? 0 });
    const id = Number(info.lastInsertRowid);
    // Opening stock becomes its first batch, so FEFO has backing from day one.
    if (p.qty > 0) addBatch(id, p.qty, { cost_price: p.cost_price });
    return getById(id)!;
  });
}

/**
 * Receive stock: += qty as a NEW batch (optionally with expiry / batch no),
 * optionally refresh cost/mrp/sell, journal the move. Atomic.
 */
export function receiveStock(
  productId: number,
  qty: number,
  opts: { cost?: number; mrp?: number; sell?: number; expiry?: string | null; batch_no?: string | null } = {}
): Product {
  return immediateTxn(() => {
    const p = getById(productId);
    if (!p) throw new Error(`Product ${productId} not found`);
    const sets: string[] = ["qty = qty + @qty"];
    if (opts.cost != null) sets.push("cost_price = @cost");
    if (opts.mrp != null) sets.push("mrp = @mrp");
    if (opts.sell != null) sets.push("sell_price = @sell");
    if (opts.expiry) sets.push("perishable = 1");
    db.prepare(`UPDATE products SET ${sets.join(", ")} WHERE id = @id`).run({
      id: productId,
      qty,
      cost: opts.cost,
      mrp: opts.mrp,
      sell: opts.sell,
    });
    const batch = addBatch(productId, qty, {
      expiry: opts.expiry ?? null,
      batch_no: opts.batch_no ?? null,
      cost_price: opts.cost ?? p.cost_price,
    });
    db.prepare(
      "INSERT INTO stock_moves (product_id, delta, reason, ref, batch_id) VALUES (?,?, 'receive', NULL, ?)"
    ).run(productId, qty, batch.id);
    return getById(productId)!;
  });
}
