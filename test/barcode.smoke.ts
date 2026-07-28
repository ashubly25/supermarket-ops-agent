import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.DB_PATH = join(tmpdir(), `bc-${process.pid}.db`);

const { seed } = await import("../src/db/seed.ts");
const products = await import("../src/repo/products.ts");
const inv = await import("../src/tools/inventory.ts");
seed();

// 1. Photo-of-barcode path: digits → SKU
const p = products.getByBarcode("8901725111212");
console.log("barcode 8901725111212 →", p ? `${p.name} ${p.size} (#${p.id})` : "NOT FOUND");

// 2. Unknown barcode → null (model then falls back to find_product)
console.log("unknown barcode →", products.getByBarcode("0000000000000") ?? "null (fallback to find_product)");

// 3. Teach a new barcode via set_barcode, then resolve it
const maggi = products.search("maggi", 1)[0];
products.setBarcode(maggi.id, "9990001112223");
const linked = products.getByBarcode("9990001112223");
console.log("after set_barcode →", linked ? `${linked.name} (#${linked.id})` : "FAIL");

// 4. Duplicate barcode guarded
try {
  products.setBarcode(products.search("sugar", 1)[0].id, "9990001112223");
  console.log("dup guard → FAIL (allowed clash)");
} catch (e) {
  console.log("dup guard →", (e as Error).message);
}

// 5. tools registered
console.log("tools registered →", inv.inventoryTools.map((t: any) => t.name).filter((n: string) => /barcode/.test(n)).join(", "));
