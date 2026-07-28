-- Supermarket Ops Agent — schema. Money stored as REAL rupees; rounded at compute time.
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS products (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,           -- brand+item, e.g. "Aashirvaad Atta"
  size          TEXT NOT NULL,           -- "5kg", "1L", "70g", "loose"
  unit          TEXT NOT NULL,           -- kg|g|litre|ml|packet|dozen|piece
  loose         INTEGER NOT NULL DEFAULT 0,  -- 0 packaged, 1 loose (priced by weight)
  hsn           TEXT NOT NULL DEFAULT '',
  gst_rate      REAL NOT NULL DEFAULT 0,     -- 0 | 5 | 18 | 40  (GST 2.0, from 22 Sep 2025)
  cost_price    REAL NOT NULL DEFAULT 0,     -- per unit (per kg/L for loose)
  mrp           REAL NOT NULL DEFAULT 0,
  sell_price    REAL NOT NULL DEFAULT 0,
  qty           REAL NOT NULL DEFAULT 0,     -- current stock (in `unit`)
  reorder_level REAL NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(name, size)
);

-- Every stock change is journalled here for audit / reversal.
CREATE TABLE IF NOT EXISTS stock_moves (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  delta      REAL NOT NULL,               -- +receive, -sale
  reason     TEXT NOT NULL,               -- receive|sale|adjust
  ref        TEXT,                        -- bill id, etc.
  ts         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL UNIQUE,
  phone         TEXT,
  khata_balance REAL NOT NULL DEFAULT 0,  -- +ve = customer owes shop
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS khata_txns (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  amount      REAL NOT NULL,              -- always positive magnitude
  kind        TEXT NOT NULL,              -- charge|payment
  bill_id     INTEGER REFERENCES bills(id),
  note        TEXT,
  ts          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bills (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'draft', -- draft|final|void
  customer        TEXT,
  payment_mode    TEXT,                   -- cash|upi|card|credit
  payment_ref     TEXT,
  subtotal        REAL NOT NULL DEFAULT 0, -- taxable value (ex-GST)
  cgst            REAL NOT NULL DEFAULT 0,
  sgst            REAL NOT NULL DEFAULT 0,
  total           REAL NOT NULL DEFAULT 0, -- rounded grand total
  round_off       REAL NOT NULL DEFAULT 0,
  idempotency_key TEXT UNIQUE,            -- guards double-finalize
  ts_created      TEXT NOT NULL DEFAULT (datetime('now')),
  ts_final        TEXT
);

CREATE TABLE IF NOT EXISTS bill_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_id    INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  name       TEXT NOT NULL,              -- snapshot at add time
  hsn        TEXT NOT NULL DEFAULT '',
  qty        REAL NOT NULL,
  unit       TEXT NOT NULL,
  unit_price REAL NOT NULL,              -- GST-inclusive sell price per unit
  gst_rate   REAL NOT NULL,
  taxable    REAL NOT NULL,              -- ex-GST line value
  line_tax   REAL NOT NULL,              -- total GST on line (cgst+sgst)
  line_total REAL NOT NULL               -- taxable + line_tax
);

-- Owner preferences, per chat. Survives /new (session reset).
CREATE TABLE IF NOT EXISTS prefs (
  chat_id TEXT NOT NULL,
  key     TEXT NOT NULL,
  value   TEXT NOT NULL,
  PRIMARY KEY (chat_id, key)
);

-- Telegram update idempotency: drop redelivered updates.
CREATE TABLE IF NOT EXISTS processed_updates (
  update_id INTEGER PRIMARY KEY,
  ts        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Files (PDF/PPTX) a tool generated during a run, for the bot to send after the turn.
CREATE TABLE IF NOT EXISTS outbox (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  path    TEXT NOT NULL,
  caption TEXT NOT NULL DEFAULT '',
  sent    INTEGER NOT NULL DEFAULT 0,
  ts      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bills_status ON bills(status, ts_final);
CREATE INDEX IF NOT EXISTS idx_bill_items_bill ON bill_items(bill_id);
CREATE INDEX IF NOT EXISTS idx_stock_moves_product ON stock_moves(product_id);
CREATE INDEX IF NOT EXISTS idx_khata_cust ON khata_txns(customer_id);

-- ─────────────────────────── Stretch: batches / expiry (FEFO) ───────────────────────────
-- Stock is held in batches. products.qty stays the denormalised total of ACTIVE batches
-- (self-healing: see repo/batches.ts ensureBacking). Sales consume First-Expiry-First-Out.
CREATE TABLE IF NOT EXISTS batches (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  INTEGER NOT NULL REFERENCES products(id),
  batch_no    TEXT,
  qty         REAL NOT NULL,                  -- remaining in this batch
  cost_price  REAL NOT NULL DEFAULT 0,
  expiry      TEXT,                           -- YYYY-MM-DD; NULL = non-perishable
  status      TEXT NOT NULL DEFAULT 'active', -- active | written_off
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_batches_fefo ON batches(product_id, status, expiry, id);

-- ─────────────────────────── Stretch: scheduled jobs ───────────────────────────
-- Owner-set recurring pushes (weekly analysis deck, khata reminder sweep).
CREATE TABLE IF NOT EXISTS schedules (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id  TEXT NOT NULL,
  kind     TEXT NOT NULL,                     -- weekly_deck | khata_reminder | daily_close
  weekday  INTEGER,                           -- 0=Sun..6=Sat; NULL = every day
  hour     INTEGER NOT NULL DEFAULT 9,        -- local hour 0-23
  minute   INTEGER NOT NULL DEFAULT 0,
  enabled  INTEGER NOT NULL DEFAULT 1,
  last_run TEXT,                              -- YYYY-MM-DDTHH:MM slot key; guards double-fire
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(chat_id, kind)
);

-- Plain text the scheduler wants pushed to a chat (deck files still go via `outbox`).
CREATE TABLE IF NOT EXISTS notices (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  text    TEXT NOT NULL,
  sent    INTEGER NOT NULL DEFAULT 0,
  ts      TEXT NOT NULL DEFAULT (datetime('now'))
);
