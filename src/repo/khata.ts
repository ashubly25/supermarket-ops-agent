import { db, immediateTxn } from "../db/index.js";

export interface Customer {
  id: number;
  name: string;
  phone: string | null;
  khata_balance: number;
}

export function findCustomer(name: string): Customer | undefined {
  // Case-insensitive exact-ish match on name.
  return db
    .prepare("SELECT * FROM customers WHERE lower(name) = lower(?)")
    .get(name.trim()) as Customer | undefined;
}

export function getOrCreateCustomer(name: string, phone?: string): Customer {
  const existing = findCustomer(name);
  if (existing) return existing;
  const info = db
    .prepare("INSERT INTO customers (name, phone) VALUES (?,?)")
    .run(name.trim(), phone ?? null);
  return db.prepare("SELECT * FROM customers WHERE id = ?").get(info.lastInsertRowid) as Customer;
}

/** Add a charge to a customer's khata (they now owe more). Creates customer if new. */
export function charge(name: string, amount: number, opts: { billId?: number; note?: string } = {}): Customer {
  return immediateTxn(() => {
    const c = getOrCreateCustomer(name);
    db.prepare("UPDATE customers SET khata_balance = khata_balance + ? WHERE id = ?").run(amount, c.id);
    db.prepare(
      "INSERT INTO khata_txns (customer_id, amount, kind, bill_id, note) VALUES (?,?, 'charge', ?, ?)"
    ).run(c.id, amount, opts.billId ?? null, opts.note ?? null);
    return db.prepare("SELECT * FROM customers WHERE id = ?").get(c.id) as Customer;
  });
}

/** Record a payment against a khata. Refuses unknown customer or over-payment. */
export function payment(name: string, amount: number, note?: string): Customer {
  return immediateTxn(() => {
    const c = findCustomer(name);
    if (!c) throw new Error(`No khata found for "${name}". Nothing to settle.`);
    if (amount > c.khata_balance + 1e-6)
      throw new Error(
        `Payment ₹${amount.toFixed(2)} exceeds ${c.name}'s balance ₹${c.khata_balance.toFixed(2)}. Confirm the amount.`
      );
    db.prepare("UPDATE customers SET khata_balance = khata_balance - ? WHERE id = ?").run(amount, c.id);
    db.prepare(
      "INSERT INTO khata_txns (customer_id, amount, kind, bill_id, note) VALUES (?,?, 'payment', NULL, ?)"
    ).run(c.id, amount, note ?? null);
    return db.prepare("SELECT * FROM customers WHERE id = ?").get(c.id) as Customer;
  });
}

export function balance(name: string): Customer | undefined {
  return findCustomer(name);
}

export interface OverdueRow {
  id: number;
  name: string;
  phone: string | null;
  balance: number;
  last_payment: string | null;
  oldest_charge: string | null;
  days_outstanding: number;
}

/**
 * Customers who owe money and haven't paid in `days`. "Days outstanding" runs from
 * their last payment, or from the oldest charge if they've never paid.
 */
export function overdue(days = 14): OverdueRow[] {
  const rows = db
    .prepare(
      `SELECT c.id, c.name, c.phone, c.khata_balance balance,
              (SELECT MAX(ts) FROM khata_txns WHERE customer_id=c.id AND kind='payment') last_payment,
              (SELECT MIN(ts) FROM khata_txns WHERE customer_id=c.id AND kind='charge')  oldest_charge
       FROM customers c
       WHERE c.khata_balance > 0.009
       ORDER BY c.khata_balance DESC`
    )
    .all() as Omit<OverdueRow, "days_outstanding">[];
  const now = Date.now();
  return rows
    .map((r) => {
      const since = r.last_payment ?? r.oldest_charge;
      const d = since ? Math.floor((now - Date.parse(since.replace(" ", "T") + "Z")) / 86400000) : 0;
      return { ...r, balance: Math.round(r.balance * 100) / 100, days_outstanding: d };
    })
    .filter((r) => r.days_outstanding >= days)
    .sort((a, b) => b.days_outstanding - a.days_outstanding);
}

export function ledger(customerId: number, limit = 20) {
  return db
    .prepare("SELECT * FROM khata_txns WHERE customer_id = ? ORDER BY id DESC LIMIT ?")
    .all(customerId, limit) as { amount: number; kind: string; note: string | null; ts: string }[];
}
