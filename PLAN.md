# Supermarket Ops Agent — Design & Build Plan

Harness: **Claude Agent SDK (TypeScript)**. Interface: **Telegram**. Store: **SQLite**.

---

## 1. Harness choice — why Claude Agent SDK (TS)

- `query()` runs the full **observe → reason → act → feed-result** loop internally, chaining multiple tool calls per turn. No hand-rolled router — the model orchestrates. Directly satisfies the "agent-first / no regex router" requirement.
- **Custom tools** via `tool()` + `createSdkMcpServer()` run **in-process** (same Node runtime as the DB and Telegram client) — so business rules (oversell guard, GST, idempotency) live in TS with direct SQLite access, not in a separate MCP process.
- **Zod schemas** on tools = typed, validated inputs; the model retries on mismatch.
- **Native Agent Skills** (`.claude/skills/*/SKILL.md`) — matches "author skills the way the harness expects."
- **Session resume** (`options.resume = "telegram_<chatId>"`) gives per-chat multi-turn conversation state for free.
- TS pairs cleanly with best-in-class doc libs: `grammY` (Telegram), `pdfkit`/`puppeteer` (PDF), `pptxgenjs` (PPTX), `better-sqlite3` (sync, transactional).

---

## 2. Architecture & control loop

```
Telegram (grammY long-poll)
   │  update {chatId, text|voice, update_id}
   ▼
Bot dispatcher  ── idempotency: seen(update_id)? drop
   │
   ▼
query({ prompt, options:{ resume:"telegram_<chatId>", mcpServers, systemPrompt, maxTurns } })
   │   (SDK internal loop: reason → tool_use → tool_result → repeat)
   ▼
in-process MCP tool servers  ──►  SQLite (better-sqlite3, WAL, txns)
   │                          ──►  PDF / PPTX generators → file
   ▼
result.result (final text)  +  any generated files
   │
   ▼
grammY: sendMessage / sendDocument back to chat
```

- **One chat = one session.** `resume: "telegram_<chatId>"` keeps conversation history (multi-turn bill build) without us storing transcript.
- **Durable state is NOT in the session** — stock, khata, bills, prefs live in SQLite. `/new` clears session, DB untouched → memory persists.
- `maxTurns` ~12 so multi-tool chains (lookup → validate → write → confirm) complete in one user turn.
- Files (PDF/PPTX) written to disk by tools; bot layer reads the returned path and `sendDocument`.

---

## 3. Data model (SQLite, better-sqlite3, WAL mode)

```sql
products(
  id INTEGER PK, name TEXT, brand TEXT, size TEXT,          -- "Aashirvaad Atta 5kg"
  unit TEXT,                    -- kg|g|litre|ml|packet|dozen|piece
  loose INTEGER,                -- 0/1
  hsn TEXT, gst_rate REAL,      -- 0 / 5 / 12 / 18
  cost_price REAL, mrp REAL, sell_price REAL,
  qty REAL, reorder_level REAL,
  UNIQUE(name,size)
)
stock_moves(id, product_id, delta REAL, reason TEXT, ref TEXT, ts)  -- audit trail

bills(
  id, chat_id, status TEXT,     -- draft|final
  customer TEXT, payment_mode TEXT, payment_ref TEXT,
  subtotal, cgst, sgst, total, ts_created, ts_final,
  idempotency_key TEXT UNIQUE   -- guards double-finalize
)
bill_items(id, bill_id, product_id, name, qty, unit_price, gst_rate, line_tax, line_total)

customers(id, name UNIQUE, phone, khata_balance REAL DEFAULT 0)
khata_txns(id, customer_id, amount REAL, kind TEXT, bill_id, note, ts)  -- kind: charge|payment

prefs(chat_id, key, value)      -- default_payment, default_atta, shop_name, gstin, address
processed_updates(update_id PK, ts)  -- Telegram idempotency
```

- **Money**: store paise-safe (compute in decimals, round each line's tax to 2dp, GST split = tax/2 each). Consider integer paise if precision bites.
- Every stock change goes through `stock_moves` → auditable, reversible.

---

## 4. Skill & tool surface

**Skills** = domain playbooks (SKILL.md, model-invoked). **Tools** = thin, single-purpose, rule-enforcing DB ops.

### Skills (`.claude/skills/`)
| Skill | Role |
|-------|------|
| `inventory` | receive stock, add product (asks GST/HSN if missing), stock queries, low-stock. |
| `billing` | multi-turn bill build/edit, GST maths rules, finalize discipline, oversell handling. |
| `khata` | credit charge / payment / balance; refuse settling nonexistent khata. |
| `analytics` | daily close, weekly deck; what to chart, what insights to surface. |
| `documents` | when/how to emit PDF invoice & PPTX deck. |

System prompt stays **thin**: persona (kirana shop owner's assistant, terse Hindi-English OK), "always ground via tools, never invent price/product", "ask when ambiguous". Business rules do NOT live here.

### Tools (Zod-schema'd, in-process)
**Inventory**
- `find_product(query)` → fuzzy match, returns candidates (grounding + disambiguation).
- `add_product({name,size,unit,loose,gst_rate,hsn,cost,mrp,sell,reorder})`.
- `receive_stock({product_id, qty, cost?, mrp?})` → += qty, logs move.
- `get_stock(product_id)` · `low_stock()`.

**Billing**
- `create_draft_bill({chat_id})` → bill_id (status=draft).
- `add_bill_item({bill_id, product_query, qty})` → resolves product, checks stock ≥ qty (**oversell guard here**), checks sell ≥ cost (**below-cost guard**), computes line GST, appends. Returns running bill.
- `edit_bill_item({bill_id, product, new_qty|remove})`.
- `set_bill_meta({bill_id, payment_mode, payment_ref, customer?})`.
- `finalize_bill({bill_id, idempotency_key})` → **single SQLite transaction**: re-check all stock, decrement, mark final, write khata charge if credit. Idempotency key dedupes retries.

**Khata**
- `khata_charge({customer, amount, bill_id?})` · `khata_payment({customer, amount})` (refuse if no customer/over-payment → confirm) · `khata_balance({customer})`.

**Analytics / docs**
- `daily_close({date?})` → totals, tax, cash/UPI split, top items.
- `sales_report({from,to})` → aggregates for deck.
- `generate_invoice_pdf({bill_id})` → path. Pulls shop_name/GSTIN from prefs.
- `generate_analysis_pptx({from,to})` → path, real charts.

**Memory**
- `get_prefs({chat_id})` · `set_pref({chat_id,key,value})`. Loaded into system prompt per chat at query start.

Design stance: tools are **thin and dumb about intent** but **strict about rules**. The model composes them; a tool never trusts the model on stock/price/GST — it recomputes and guards.

---

## 5. Hard parts — how each is solved

| Hard part | Solution (at the tool/data layer) |
|-----------|-----------------------------------|
| **Grounding** | Price/GST/stock only ever returned by `find_product`/`get_stock`. System prompt forbids inventing; tools are the sole source. |
| **Oversell guard** | Checked in `add_bill_item` AND re-checked inside `finalize_bill` transaction. Refuse → tool returns `isError` with "only N in stock". |
| **GST correctness** | Per-item `gst_rate` from DB. Line tax = round(price·qty·rate/100, 2); CGST=SGST=tax/2. Bill shows per-slab breakup. Grand total rounded. |
| **Multi-turn bills** | Draft persisted in `bills`/`bill_items`; edits mutate draft; **stock only decremented on `finalize_bill`**. |
| **Idempotency** | (a) `processed_updates(update_id)` drops redelivered Telegram updates. (b) `bills.idempotency_key UNIQUE` → retried finalize is a no-op returning the same bill. |
| **Concurrency** | `better-sqlite3` synchronous + `BEGIN IMMEDIATE` transactions; finalize re-reads qty inside txn. WAL mode. Serialized writes → no negative stock under two-bills-at-once. |
| **Guardrails** | Below-cost sell → refuse/confirm in `add_bill_item`. No stock-delete tool exposed. Khata settle on missing customer → tool refuses. |
| **Real artifacts** | `pdfkit` GST invoice (shop header, GSTIN, HSN, per-line tax, CGST/SGST breakup, totals in words). `pptxgenjs` deck with native bar/pie/line charts from `sales_report`. |
| **Memory across sessions** | `prefs` table keyed by chat_id, injected into system prompt each turn. `/new` clears SDK session only; prefs survive. |

---

## 6. Deploy — Oracle Cloud Always Free VM

- **Host: Oracle Cloud "Always Free" VM** (ARM Ampere, always-on, persistent boot volume). Free forever, no scale-to-zero, persistent disk → no code/architecture compromise vs serverless free tiers (which sleep on idle or lose the SQLite file on redeploy).
- Node service in **Docker**, `grammY` **long-polling** (no public URL / webhook needed), `better-sqlite3` file on the VM's persistent disk. `docker compose up -d`, restart-always.
- Chosen over Fly/Railway (card-gated / trial-credit, not truly free) and over Render/Koyeb/Cloud-Run free (idle-sleep breaks long-poll, ephemeral disk breaks SQLite).
- `TELEGRAM_BOT_TOKEN` + `ANTHROPIC_API_KEY` via env/secrets. Owner creates bot via BotFather, drops token in.
- README lists `@bot_handle`, the hard-part write-up, and a 4–5 min recording.

---

## 7. Build phases (order)

1. Scaffold: TS project, better-sqlite3 schema + migrations, seed real SKUs.
2. Inventory tools + `inventory`/nothing-else path; wire grammY + `query()` loop + session resume.
3. Billing tools + `billing` skill (draft→edit→finalize, guards). This is the core.
4. Khata skill+tools.
5. Analytics + daily close.
6. PDF invoice, then PPTX deck.
7. Prefs/memory + `/new` behavior.
8. Idempotency + concurrency hardening + tests.
9. Deploy, record, README.

---

## Decisions locked
1. **Deploy**: Oracle Cloud Always Free VM + Docker + long-poll (see §6).
2. **PDF**: `pdfkit` (pure JS, light — no headless Chrome on the VM). Branded template = later stretch.
3. **Stretch**: core first; leave hooks for voice / Hindi / reorder-from-velocity.
4. **Token**: placeholder env `TELEGRAM_BOT_TOKEN` — owner creates bot via BotFather, drops it in. Not needed to build.
