import { db, immediateTxn } from "../db/index.js";
import { round2 } from "../lib/money.js";

export interface Batch {
  id: number;
  product_id: number;
  batch_no: string | null;
  qty: number;
  cost_price: number;
  expiry: string | null;
  status: string;
  received_at: string;
}

export class BatchError extends Error {}

export const today = (): string => new Date().toISOString().slice(0, 10);

/**
 * Self-healing invariant: products.qty == SUM(active batch qty).
 * Products created before batch tracking (or straight through addProduct) get a
 * synthetic non-perishable batch for the difference, so FEFO always has backing
 * and no legacy stock becomes unsellable. Call inside a write txn.
 */
export function ensureBacking(productId: number): void {
  const row = db
    .prepare(
      `SELECT p.qty AS pq, COALESCE((SELECT SUM(qty) FROM batches WHERE product_id=p.id AND status='active'),0) AS bq
       FROM products p WHERE p.id = ?`
    )
    .get(productId) as { pq: number; bq: number } | undefined;
  if (!row) throw new BatchError(`Product ${productId} not found.`);
  const gap = round2(row.pq - row.bq);
  if (gap > 1e-9) {
    // products.qty ahead of the batches (legacy rows, manual top-up) → synthesise a batch.
    db.prepare(
      "INSERT INTO batches (product_id, batch_no, qty, cost_price, expiry) VALUES (?, 'opening', ?, (SELECT cost_price FROM products WHERE id=?), NULL)"
    ).run(productId, gap, productId);
  } else if (gap < -1e-9) {
    // Stock removed out-of-band (manual adjustment) → shrink batches so FEFO can't
    // hand out quantity the product no longer has. Latest-expiring goes first.
    let left = -gap;
    const rows = db
      .prepare(
        `SELECT id, qty FROM batches WHERE product_id=? AND status='active' AND qty > 0
         ORDER BY (expiry IS NULL) DESC, expiry DESC, id DESC`
      )
      .all(productId) as { id: number; qty: number }[];
    for (const b of rows) {
      if (left <= 1e-9) break;
      const take = Math.min(b.qty, left);
      db.prepare("UPDATE batches SET qty = qty - ? WHERE id = ?").run(take, b.id);
      db.prepare(
        "INSERT INTO stock_moves (product_id, delta, reason, ref, batch_id) VALUES (?,?, 'adjust', 'reconcile', ?)"
      ).run(productId, -take, b.id);
      left = round2(left - take);
    }
  }
}

/** Batches available to sell, in FEFO order: soonest expiry first, NULL (non-perishable) last. */
export function fefoBatches(productId: number, asOf = today()): Batch[] {
  return db
    .prepare(
      `SELECT * FROM batches
       WHERE product_id = ? AND status = 'active' AND qty > 0
         AND (expiry IS NULL OR expiry >= ?)
       ORDER BY (expiry IS NULL) ASC, expiry ASC, id ASC`
    )
    .all(productId, asOf) as Batch[];
}

/** Stock that may legally be sold today — excludes expired batches. */
export function sellableQty(productId: number, asOf = today()): number {
  immediateTxn(() => ensureBacking(productId));
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(qty),0) q FROM batches
       WHERE product_id=? AND status='active' AND (expiry IS NULL OR expiry >= ?)`
    )
    .get(productId, asOf) as { q: number };
  return round2(row.q);
}

export function expiredQty(productId: number, asOf = today()): number {
  const row = db
    .prepare("SELECT COALESCE(SUM(qty),0) q FROM batches WHERE product_id=? AND status='active' AND expiry < ?")
    .get(productId, asOf) as { q: number };
  return round2(row.q);
}

/** Record incoming goods as a batch. Caller updates products.qty in the same txn. */
export function addBatch(
  productId: number,
  qty: number,
  opts: { expiry?: string | null; batch_no?: string | null; cost_price?: number } = {}
): Batch {
  if (qty <= 0) throw new BatchError("Batch quantity must be positive.");
  if (opts.expiry && !/^\d{4}-\d{2}-\d{2}$/.test(opts.expiry))
    throw new BatchError(`Expiry must be YYYY-MM-DD, got "${opts.expiry}".`);
  if (opts.expiry && opts.expiry < today())
    throw new BatchError(`Refusing: expiry ${opts.expiry} is already past. Check the date on the pack.`);
  const info = db
    .prepare(
      `INSERT INTO batches (product_id, batch_no, qty, cost_price, expiry)
       VALUES (?,?,?,COALESCE(?,(SELECT cost_price FROM products WHERE id=?)),?)`
    )
    .run(productId, opts.batch_no ?? null, qty, opts.cost_price ?? null, productId, opts.expiry ?? null);
  return db.prepare("SELECT * FROM batches WHERE id = ?").get(info.lastInsertRowid) as Batch;
}

/**
 * Consume `qty` FEFO for a sale. Expired batches are skipped (never sold), so a
 * product whose only stock is expired refuses the sale rather than shipping it.
 * Decrements products.qty and journals one stock_move per batch touched.
 * MUST run inside an immediate transaction (finalize provides one).
 */
export function consumeFEFO(productId: number, qty: number, ref: string, asOf = today()): Batch[] {
  ensureBacking(productId);
  const avail = db
    .prepare(
      `SELECT COALESCE(SUM(qty),0) q FROM batches
       WHERE product_id=? AND status='active' AND (expiry IS NULL OR expiry >= ?)`
    )
    .get(productId, asOf) as { q: number };
  if (qty > avail.q + 1e-9) {
    const exp = expiredQty(productId, asOf);
    throw new BatchError(
      `Only ${round2(avail.q)} sellable in stock, need ${qty}.` +
        (exp > 0 ? ` (${exp} more is EXPIRED — write it off, don't sell it.)` : "")
    );
  }

  let left = qty;
  const touched: Batch[] = [];
  for (const b of fefoBatches(productId, asOf)) {
    if (left <= 1e-9) break;
    const take = Math.min(b.qty, left);
    db.prepare("UPDATE batches SET qty = qty - ? WHERE id = ?").run(take, b.id);
    db.prepare(
      "INSERT INTO stock_moves (product_id, delta, reason, ref, batch_id) VALUES (?,?, 'sale', ?, ?)"
    ).run(productId, -take, ref, b.id);
    left = round2(left - take);
    touched.push({ ...b, qty: take });
  }
  db.prepare("UPDATE products SET qty = qty - ? WHERE id = ?").run(qty, productId);
  return touched;
}

export interface ExpiringRow {
  product_id: number;
  name: string;
  size: string;
  unit: string;
  batch_id: number;
  batch_no: string | null;
  qty: number;
  expiry: string;
  days_left: number;
  value_at_cost: number;
}

/** Batches expiring within `days` (negative days_left = already expired). */
export function expiringSoon(days = 30, asOf = today()): ExpiringRow[] {
  const cutoff = new Date(asOf + "T00:00:00Z");
  cutoff.setUTCDate(cutoff.getUTCDate() + days);
  const to = cutoff.toISOString().slice(0, 10);
  const rows = db
    .prepare(
      `SELECT b.id batch_id, b.batch_no, b.qty, b.expiry, b.cost_price, p.id product_id, p.name, p.size, p.unit
       FROM batches b JOIN products p ON p.id = b.product_id
       WHERE b.status='active' AND b.qty > 0 AND b.expiry IS NOT NULL AND b.expiry <= ?
       ORDER BY b.expiry ASC`
    )
    .all(to) as any[];
  const base = Date.parse(asOf + "T00:00:00Z");
  return rows.map((r) => ({
    product_id: r.product_id,
    name: r.name,
    size: r.size,
    unit: r.unit,
    batch_id: r.batch_id,
    batch_no: r.batch_no,
    qty: round2(r.qty),
    expiry: r.expiry,
    days_left: Math.round((Date.parse(r.expiry + "T00:00:00Z") - base) / 86400000),
    value_at_cost: round2(r.qty * r.cost_price),
  }));
}

/** Write off expired stock (whole product, or one batch). Journals reason='expiry'. */
export function writeOffExpired(opts: { product_id?: number; batch_id?: number } = {}, asOf = today()) {
  return immediateTxn(() => {
    const where = opts.batch_id
      ? { sql: "id = ?", args: [opts.batch_id] as unknown[] }
      : opts.product_id
        ? { sql: "product_id = ? AND status='active' AND expiry < ?", args: [opts.product_id, asOf] }
        : { sql: "status='active' AND expiry < ?", args: [asOf] };
    const rows = db.prepare(`SELECT * FROM batches WHERE ${where.sql}`).all(...where.args) as Batch[];
    const done: { batch_id: number; product_id: number; qty: number; expiry: string | null }[] = [];
    for (const b of rows) {
      if (b.status !== "active" || b.qty <= 0) continue;
      if (b.expiry === null || b.expiry >= asOf)
        throw new BatchError(`Batch #${b.id} is not expired (expiry ${b.expiry ?? "none"}). Refusing to write it off.`);
      db.prepare("UPDATE batches SET qty = 0, status='written_off' WHERE id = ?").run(b.id);
      db.prepare("UPDATE products SET qty = qty - ? WHERE id = ?").run(b.qty, b.product_id);
      db.prepare(
        "INSERT INTO stock_moves (product_id, delta, reason, ref, batch_id) VALUES (?,?, 'expiry', ?, ?)"
      ).run(b.product_id, -b.qty, `expired ${b.expiry}`, b.id);
      done.push({ batch_id: b.id, product_id: b.product_id, qty: round2(b.qty), expiry: b.expiry });
    }
    return done;
  });
}
