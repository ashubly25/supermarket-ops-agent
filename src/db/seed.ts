import { db, migrate } from "./index.js";

/**
 * Seed real Indian kirana SKUs with correct GST slabs & HSN codes.
 * Slabs: 0% (loose/unbranded staples, salt, bread, milk),
 *        5% (packaged staples, edible oil, sugar, tea),
 *        12% (butter/ghee, namkeen),
 *        18% (biscuits, noodles, detergent, soap, chocolate, toothpaste).
 * cost < sell < mrp. qty and reorder_level set for demo.
 */
type Seed = {
  name: string; size: string; unit: string; loose: number;
  hsn: string; gst: number; cost: number; mrp: number; sell: number;
  qty: number; reorder: number;
  /** EAN-13 printed on the pack, so a photo of the barcode resolves the SKU. */
  barcode?: string;
  /** Days from today this stock expires — seeds a dated batch for FEFO demos. */
  expires_in?: number;
};

const SKUS: Seed[] = [
  // --- 0% staples ---
  { name: "Aashirvaad Atta", size: "5kg", unit: "packet", loose: 0, hsn: "1101", gst: 5, cost: 245, mrp: 285, sell: 275, qty: 30, reorder: 8, barcode: "8901725111212" },
  { name: "Tata Salt", size: "1kg", unit: "packet", loose: 0, hsn: "2501", gst: 0, cost: 22, mrp: 28, sell: 26, qty: 60, reorder: 15, barcode: "8901725100018" },
  { name: "Amul Taaza Milk", size: "500ml", unit: "packet", loose: 0, hsn: "0401", gst: 0, cost: 25, mrp: 28, sell: 27, qty: 40, reorder: 20, barcode: "8901262010023", expires_in: 3 },
  { name: "Britannia Bread", size: "400g", unit: "packet", loose: 0, hsn: "1905", gst: 0, cost: 40, mrp: 50, sell: 48, qty: 20, reorder: 10, barcode: "8901063011007", expires_in: 2 },
  // --- loose (0% unbranded) ---
  { name: "Sugar (loose)", size: "loose", unit: "kg", loose: 1, hsn: "1701", gst: 5, cost: 40, mrp: 48, sell: 46, qty: 50, reorder: 10 },
  { name: "Rice Sona Masoori (loose)", size: "loose", unit: "kg", loose: 1, hsn: "1006", gst: 0, cost: 52, mrp: 65, sell: 62, qty: 80, reorder: 20 },
  { name: "Toor Dal (loose)", size: "loose", unit: "kg", loose: 1, hsn: "0713", gst: 0, cost: 110, mrp: 135, sell: 130, qty: 40, reorder: 10 },
  { name: "Wheat Atta (loose)", size: "loose", unit: "kg", loose: 1, hsn: "1101", gst: 0, cost: 32, mrp: 42, sell: 40, qty: 60, reorder: 15 },
  // --- 5% ---
  { name: "Fortune Sunflower Oil", size: "1L", unit: "packet", loose: 0, hsn: "1512", gst: 5, cost: 130, mrp: 155, sell: 149, qty: 25, reorder: 8 },
  { name: "Tata Tea Gold", size: "500g", unit: "packet", loose: 0, hsn: "0902", gst: 5, cost: 240, mrp: 290, sell: 275, qty: 18, reorder: 6 },
  // --- 12% ---
  { name: "Amul Butter", size: "100g", unit: "packet", loose: 0, hsn: "0405", gst: 12, cost: 52, mrp: 62, sell: 60, qty: 35, reorder: 10, barcode: "8901262260015", expires_in: 45 },
  { name: "Haldiram Aloo Bhujia", size: "200g", unit: "packet", loose: 0, hsn: "2106", gst: 12, cost: 45, mrp: 55, sell: 52, qty: 22, reorder: 8, barcode: "8904063200015", expires_in: 20 },
  // --- 18% ---
  { name: "Maggi Masala Noodles", size: "70g", unit: "packet", loose: 0, hsn: "1902", gst: 18, cost: 12, mrp: 14, sell: 14, qty: 100, reorder: 25, barcode: "8901058000221", expires_in: 180 },
  { name: "Parle-G Biscuit", size: "250g", unit: "packet", loose: 0, hsn: "1905", gst: 18, cost: 22, mrp: 27, sell: 26, qty: 70, reorder: 20, barcode: "8901719101021", expires_in: 120 },
  { name: "Surf Excel Detergent", size: "1kg", unit: "packet", loose: 0, hsn: "3402", gst: 18, cost: 110, mrp: 135, sell: 128, qty: 28, reorder: 8 },
  { name: "Lux Soap", size: "100g", unit: "piece", loose: 0, hsn: "3401", gst: 18, cost: 28, mrp: 38, sell: 35, qty: 50, reorder: 15 },
  { name: "Colgate Toothpaste", size: "100g", unit: "piece", loose: 0, hsn: "3306", gst: 18, cost: 45, mrp: 60, sell: 55, qty: 30, reorder: 10 },
  { name: "Cadbury Dairy Milk", size: "50g", unit: "piece", loose: 0, hsn: "1806", gst: 18, cost: 30, mrp: 40, sell: 38, qty: 45, reorder: 12 },
];

export function seed(): number {
  migrate();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO products
      (name, size, unit, loose, hsn, gst_rate, cost_price, mrp, sell_price, qty, reorder_level, barcode, perishable)
     VALUES (@name, @size, @unit, @loose, @hsn, @gst, @cost, @mrp, @sell, @qty, @reorder, @barcode, @perishable)`
  );
  const addBatch = db.prepare(
    "INSERT INTO batches (product_id, batch_no, qty, cost_price, expiry) VALUES (?, 'opening', ?, ?, ?)"
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
        barcode: r.barcode ?? null,
        perishable: r.expires_in != null ? 1 : 0,
      });
      if (info.changes === 0) continue; // already seeded
      n += 1;
      // Opening stock as a batch, dated when the SKU is perishable → FEFO has real data.
      if (r.qty > 0)
        addBatch.run(Number(info.lastInsertRowid), r.qty, r.cost, r.expires_in != null ? dayShift(r.expires_in) : null);
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
