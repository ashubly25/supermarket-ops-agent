import { db, migrate } from "./index.js";

/**
 * Seed real Indian kirana SKUs with correct GST slabs & HSN codes.
 * Slabs under GST 2.0 (56th Council, in force 22 Sep 2025 — the 12% and 28% slabs
 * were abolished and most kirana FMCG moved down to 5%):
 *        0%  (loose/unbranded staples, salt, bread, fresh milk),
 *        5%  (packaged staples, oil, sugar, tea, butter/ghee, namkeen, biscuits,
 *             noodles, soap, toothpaste, chocolate),
 *        18% (washing preparations — HSN 3402 stayed in Schedule III),
 *        40% (demerit: aerated drinks, pan masala, tobacco).
 * cost < sell <= mrp. Costs are set from REAL kirana trade margins, not round numbers:
 * ~4% on milk, 7-9% on staples, 10-13% on FMCG, ~10% on MRP-controlled lines like
 * Coca-Cola. A blended ~10% is what a corner store actually lives on — inflate it to
 * 20% and every profit figure the analytics tools report is fiction.
 * qty and reorder_level set for demo.
 */
type Seed = {
  name: string; size: string; unit: string; loose: number;
  hsn: string; gst: number; cost: number; mrp: number; sell: number;
  qty: number; reorder: number;
  /** Days from today this stock expires — seeds a dated batch for FEFO demos. */
  expires_in?: number;
  /** Short shelf life → the agent asks for a date on stock-in. Long-life packaged
   *  goods still carry an expiry batch, but shouldn't trigger that question. */
  perishable?: number;
  /** Carve this much of `qty` into a second batch that is ALREADY past date, so the
   *  expired-stock path is demonstrable out of the box: it is excluded from sellable
   *  quantity (the oversell guard refuses it) and `write_off_expired` can clear it.
   *  Total stock is unchanged — the fresh batch just gets the remainder. */
  stale?: { qty: number; days_ago: number };
};

const SKUS: Seed[] = [
  // --- staples: 0% loose/unbranded, 5% pre-packaged & labelled ---
  { name: "Aashirvaad Atta", size: "5kg", unit: "packet", loose: 0, hsn: "1101", gst: 5, cost: 255, mrp: 285, sell: 275, qty: 30, reorder: 8 },
  { name: "Tata Salt", size: "1kg", unit: "packet", loose: 0, hsn: "2501", gst: 0, cost: 24, mrp: 28, sell: 26, qty: 60, reorder: 15 },
  { name: "Amul Taaza Milk", size: "500ml", unit: "packet", loose: 0, hsn: "0401", gst: 0, cost: 26, mrp: 28, sell: 27, qty: 40, reorder: 20, expires_in: 3, perishable: 1 },
  { name: "Britannia Bread", size: "400g", unit: "packet", loose: 0, hsn: "1905", gst: 0, cost: 44, mrp: 50, sell: 48, qty: 20, reorder: 10, expires_in: 2, perishable: 1, stale: { qty: 4, days_ago: 1 } },
  // --- loose by weight (0%, except sugar which is 5% loose or packed) ---
  { name: "Sugar (loose)", size: "loose", unit: "kg", loose: 1, hsn: "1701", gst: 5, cost: 43, mrp: 48, sell: 46, qty: 50, reorder: 10 },
  { name: "Rice Sona Masoori (loose)", size: "loose", unit: "kg", loose: 1, hsn: "1006", gst: 0, cost: 57, mrp: 65, sell: 62, qty: 80, reorder: 20 },
  { name: "Toor Dal (loose)", size: "loose", unit: "kg", loose: 1, hsn: "0713", gst: 0, cost: 120, mrp: 135, sell: 130, qty: 40, reorder: 10 },
  { name: "Wheat Atta (loose)", size: "loose", unit: "kg", loose: 1, hsn: "1101", gst: 0, cost: 37, mrp: 42, sell: 40, qty: 60, reorder: 15 },
  // --- 5% ---
  { name: "Fortune Sunflower Oil", size: "1L", unit: "packet", loose: 0, hsn: "1512", gst: 5, cost: 138, mrp: 155, sell: 149, qty: 25, reorder: 8 },
  { name: "Tata Tea Gold", size: "500g", unit: "packet", loose: 0, hsn: "0902", gst: 5, cost: 250, mrp: 290, sell: 275, qty: 18, reorder: 6 },
  // --- 5% (GST 2.0 moved most kirana FMCG down from 12/18%) ---
  { name: "Amul Butter", size: "100g", unit: "packet", loose: 0, hsn: "0405", gst: 5, cost: 56, mrp: 62, sell: 60, qty: 35, reorder: 10, expires_in: 45, perishable: 1 },
  { name: "Haldiram Aloo Bhujia", size: "200g", unit: "packet", loose: 0, hsn: "2106", gst: 5, cost: 46, mrp: 55, sell: 52, qty: 22, reorder: 8, expires_in: 20 },
  { name: "Maggi Masala Noodles", size: "70g", unit: "packet", loose: 0, hsn: "1902", gst: 5, cost: 12.6, mrp: 14, sell: 14, qty: 100, reorder: 25, expires_in: 180 },
  { name: "Parle-G Biscuit", size: "250g", unit: "packet", loose: 0, hsn: "1905", gst: 5, cost: 23.5, mrp: 27, sell: 26, qty: 70, reorder: 20, expires_in: 120 },
  { name: "Lux Soap", size: "100g", unit: "piece", loose: 0, hsn: "3401", gst: 5, cost: 31, mrp: 38, sell: 35, qty: 50, reorder: 15 },
  { name: "Colgate Toothpaste", size: "100g", unit: "piece", loose: 0, hsn: "3306", gst: 5, cost: 49, mrp: 60, sell: 55, qty: 30, reorder: 10 },
  { name: "Cadbury Dairy Milk", size: "50g", unit: "piece", loose: 0, hsn: "1806", gst: 5, cost: 34, mrp: 40, sell: 38, qty: 45, reorder: 12 },
  // --- 18% (washing preparations, HSN 3402, stayed in Schedule III) ---
  { name: "Surf Excel Detergent", size: "1kg", unit: "packet", loose: 0, hsn: "3402", gst: 18, cost: 115, mrp: 135, sell: 128, qty: 28, reorder: 8 },
  // --- 40% demerit slab (aerated drinks, pan masala, tobacco) ---
  { name: "Coca-Cola", size: "750ml", unit: "packet", loose: 0, hsn: "2202", gst: 40, cost: 38, mrp: 45, sell: 42, qty: 24, reorder: 8 },
];

export function seed(): number {
  migrate();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO products
      (name, size, unit, loose, hsn, gst_rate, cost_price, mrp, sell_price, qty, reorder_level, perishable)
     VALUES (@name, @size, @unit, @loose, @hsn, @gst, @cost, @mrp, @sell, @qty, @reorder, @perishable)`
  );
  const addBatch = db.prepare(
    "INSERT INTO batches (product_id, batch_no, qty, cost_price, expiry) VALUES (?, ?, ?, ?, ?)"
  );
  const dayShift = (d: number) => {
    const x = new Date();
    x.setDate(x.getDate() + d);
    return x.toISOString().slice(0, 10);
  };

  const tx = db.transaction((rows: Seed[]) => {
    let n = 0;
    for (const r of rows) {
      const info = insert.run({
        ...r,
        perishable: r.perishable ?? 0,
      });
      if (info.changes === 0) continue; // already seeded
      n += 1;
      // Opening stock as a batch, dated when the SKU is perishable → FEFO has real data.
      const id = Number(info.lastInsertRowid);
      const stale = r.stale && r.stale.qty < r.qty ? r.stale : undefined;
      if (stale) addBatch.run(id, "old-stock", stale.qty, r.cost, dayShift(-stale.days_ago));
      const fresh = r.qty - (stale?.qty ?? 0);
      if (fresh > 0) addBatch.run(id, "opening", fresh, r.cost, r.expires_in != null ? dayShift(r.expires_in) : null);
    }
    return n;
  });
  return tx(SKUS);
}

// Run directly: `npm run seed`
if (import.meta.url === `file://${process.argv[1]}`) {
  const n = seed();
  console.log(`Seeded ${n} new product(s). Total products: ${(db.prepare("SELECT COUNT(*) c FROM products").get() as { c: number }).c}`);
}
