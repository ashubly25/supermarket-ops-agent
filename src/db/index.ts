import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DB_PATH = process.env.DB_PATH ?? "./data/store.db";

// Ensure the data dir exists before opening the file.
mkdirSync(dirname(resolve(DB_PATH)), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
// Wait up to 5s for a lock instead of throwing SQLITE_BUSY — smooths concurrent writes.
db.pragma("busy_timeout = 5000");

/** ALTER TABLE ADD COLUMN isn't idempotent in SQLite — check first. */
function addColumn(table: string, column: string, decl: string): void {
  const cols = db.pragma(`table_info(${table})`) as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

/** Apply schema.sql (idempotent — all CREATE ... IF NOT EXISTS) plus column migrations. */
export function migrate(): void {
  const sql = readFileSync(resolve(__dirname, "schema.sql"), "utf8");
  db.exec(sql);

  // Stretch migrations on pre-existing tables.
  addColumn("products", "barcode", "TEXT");            // EAN/UPC for scan-to-bill
  addColumn("products", "perishable", "INTEGER NOT NULL DEFAULT 0");
  addColumn("stock_moves", "batch_id", "INTEGER");     // audit: which batch a sale came out of
  db.exec("CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode)");
}

/**
 * Run `fn` inside an IMMEDIATE transaction so writers serialize and
 * concurrent bills / stock-ins can't corrupt stock. better-sqlite3 is
 * synchronous, so the whole callback runs atomically w.r.t. other writers.
 */
export function immediateTxn<T>(fn: () => T): T {
  const run = db.transaction(fn);
  // `.immediate` acquires the write lock up-front (BEGIN IMMEDIATE).
  return (run as unknown as { immediate: () => T }).immediate();
}

migrate();
