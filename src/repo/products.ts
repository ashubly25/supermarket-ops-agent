import { db, immediateTxn } from "../db/index.js";
import { matchScore } from "../lib/fuzzy.js";
import { round2 } from "../lib/money.js";
import { addBatch, ensureBacking } from "./batches.js";

/**
 * Units you cannot have a fraction of. Weight/volume units (kg, g, litre, ml) are
 * fractional by nature — that is exactly what "loose" means in a kirana.
 */
export const DISCRETE_UNITS = new Set(["packet", "piece", "dozen"]);

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
  perishable: number;
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

export function addProduct(p: Omit<Product, "id" | "perishable"> & { perishable?: number }): Product {
  return immediateTxn(() => {
    const info = db
      .prepare(
        `INSERT INTO products (name, size, unit, loose, hsn, gst_rate, cost_price, mrp, sell_price, qty, reorder_level, perishable)
         VALUES (@name,@size,@unit,@loose,@hsn,@gst_rate,@cost_price,@mrp,@sell_price,@qty,@reorder_level,@perishable)`
      )
      .run({ ...p, perishable: p.perishable ?? 0 });
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
    // Same whole-unit rule as the till: you cannot take delivery of 50.5 packets.
    if (DISCRETE_UNITS.has(p.unit.toLowerCase()) && !Number.isInteger(qty))
      throw new Error(`${p.name} comes by the ${p.unit} — ${qty} isn't a whole ${p.unit}.`);
    // Receiving can change cost and/or sell. Whatever the resulting pair is, it must
    // not leave the SKU priced below cost — otherwise every later sale books a loss
    // and the below-cost guard at bill time is bypassed entirely.
    const nextCost = opts.cost ?? p.cost_price;
    const nextSell = opts.sell ?? p.sell_price;
    if (nextSell < nextCost)
      throw new Error(
        `Refusing: that would leave ${p.name} selling at ₹${nextSell} below cost ₹${nextCost}. ` +
          `Give a new sell price at or above cost.`
      );
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

/**
 * Correct stock against a physical count: breakage, theft, a rat in the rice, or a
 * miscount at stock-take. Signed delta, mandatory reason, journalled as 'adjust'.
 *
 * Deliberately NOT a delete: it cannot drive stock negative, and `reorder_suggestions`
 * already ignores non-sale moves so a correction never masquerades as demand. Removing
 * stock shrinks batches FEFO via ensureBacking() so the remaining expiry dates stay real.
 */
export function adjustStock(productId: number, delta: number, reason: string): Product {
  return immediateTxn(() => {
    const p = getById(productId);
    if (!p) throw new Error(`Product ${productId} not found`);
    if (delta === 0) throw new Error("Adjustment of zero — nothing to record.");
    if (!reason.trim()) throw new Error("Give a reason for the adjustment — it goes on the audit trail.");
    if (DISCRETE_UNITS.has(p.unit.toLowerCase()) && !Number.isInteger(delta))
      throw new Error(`${p.name} comes by the ${p.unit} — ${delta} isn't a whole ${p.unit}.`);
    const next = round2(p.qty + delta);
    if (next < 0)
      throw new Error(`Refusing: that would leave ${p.name} at ${next}. Stock cannot go negative — counted ${p.qty} ${p.unit} on hand.`);

    if (delta > 0) {
      // Found stock has no known batch; give it one so FEFO still has something to read.
      addBatch(productId, delta, { batch_no: "adjust", cost_price: p.cost_price, expiry: null });
      db.prepare("INSERT INTO stock_moves (product_id, delta, reason, ref) VALUES (?,?, 'adjust', ?)").run(productId, delta, reason);
      db.prepare("UPDATE products SET qty = ? WHERE id = ?").run(next, productId);
    } else {
      // Shrink first, then let ensureBacking() reconcile the batches FEFO.
      db.prepare("UPDATE products SET qty = ? WHERE id = ?").run(next, productId);
      db.prepare("INSERT INTO stock_moves (product_id, delta, reason, ref) VALUES (?,?, 'adjust', ?)").run(productId, delta, reason);
      ensureBacking(productId);
    }
    return getById(productId)!;
  });
}
