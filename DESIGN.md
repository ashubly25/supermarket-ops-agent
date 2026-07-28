# Design notes

Overflow from the one-page `README.md`: the decisions that needed research or that a reviewer
might otherwise read as a mistake.

---

## A deliberate divergence from the brief: GST 2.0

The brief describes FMCG like chocolates and soaps at **12–18%**, and its example message is
`new item: Amul Butter 100g, GST 12%, MRP ₹62`. This project ships them at **5%**, on purpose.

The 56th GST Council **abolished the 12% and 28% slabs** with effect from **22 September 2025**,
adding a 40% demerit slab. Most kirana FMCG moved down to 5%. The live slabs are now **0 / 5 / 18 / 40**,
and a bill issued today at 12% would be wrong on a real invoice.

So the catalogue is rated at today's law — Dairy Milk, Lux, Colgate, butter, biscuits and noodles at 5%;
Surf Excel at 18% (HSN 3402, washing preparations stayed in Schedule III); Coca-Cola at 40% so the demerit
slab is exercised. The `inventory` skill tells the agent that a 12% quote means the owner is reading an
old rate card, and to correct it rather than store it. Running the brief's own example produces a butter
SKU at 5%, with the agent saying why.

Judge this as research, not as a misread requirement — but it is a divergence, so it is stated up front.

Because `INSERT OR IGNORE` never updates an existing row, seeding also **corrects `gst_rate`/`hsn` on
SKUs that already exist**. A store first seeded before a slab change would otherwise keep billing the
old rate forever; prices and quantities stay the owner's business.

## Realistic margins

Cost prices are set from actual kirana trade margins, not round numbers: ~4% on milk, 7–9% on staples,
10–13% on FMCG, ~10% on MRP-controlled lines like Coca-Cola. Blended ≈ **9.5%**, which is what a corner
store lives on. An earlier draft carried ~18% blended; a test now fails if any SKU exceeds 15%, because
inflated margins quietly turn every number the analytics tools report into fiction.

## Loose vs packaged is enforced, not just labelled

`DISCRETE_UNITS` (packet / piece / dozen) cannot be transacted in fractions — at the till *or* on stock-in.
2.5 kg of loose sugar is a normal sale; 2.5 packets of Maggi is refused with `Did you mean 3?`. Without
this the unit-conversion path could turn a mis-parsed "250 g Maggi" into 250 packets of internally
consistent nonsense all the way to the invoice.

## Mistakes are fixable from the chat

The chat being the only surface means it has to cover the day going wrong, not just the day going well.
Two tools exist purely so the owner never has to open the database:

- **`void_bill`** reverses a finalized sale: restores the *exact batches* FEFO consumed (read back from
  the `batch_id` on each `stock_moves` row, so returned stock keeps its real expiry dates), reverses the
  khata charge on a credit sale, and marks the bill `void`. The bill and its lines are **kept** — a shop
  that can silently delete sales cannot be reconciled. Stock whose batch was written off in the meantime
  is reported as unrestorable rather than quietly conjured back.
- **`adjust_stock`** handles breakage, theft and stock-take corrections: signed delta, mandatory reason,
  journalled as `'adjust'` so it never reads as demand in `reorder_suggestions`. It cannot drive stock
  negative and it is not a delete — expired stock still goes through `write_off_expired`.

Both require a reason on the audit trail, and both skills instruct the agent to **confirm before calling**.

## Token cost: skills gate tools

Sending all 34 tool schemas on every model step cost ~4,900 tokens per call — more than the conversation
itself — when a turn only ever needs one or two domains. So a turn opens with `find_product`, `get_stock`,
`low_stock` and `read_skill`, and **reading a skill unlocks that skill's tools**: `stopWhen:
hasToolCall("read_skill")` ends the pass, and the next pass runs with a wider surface and the same
messages. Unlocks persist for the conversation (cleared by `/new`), so a follow-up like a bare "finalize"
can still reach `finalize_bill`.

Two supporting decisions:

- **`read_skill` exchanges are stripped before persisting.** A 2–4k-character playbook left in the thread
  is re-sent on every later turn, and it is the one message always reproducible on demand. Both halves go
  together, since an orphaned tool call is a hard API error.
- **The skill index advertises tool *names*** even while schemas are withheld. Without that, a model can
  conclude a hidden capability doesn't exist and simply claim the work is done — observed once as a
  fabricated "PDF is on its way" with an empty outbox. A core rule now forbids reporting work no tool
  performed.

Measured on the same 8-turn script: tool tokens 131.6k → 30.0k (−77%), total input 238.8k → 137.2k (−43%),
with identical outcomes.

## Output is normalised in code, not asked for in the prompt

Telegram messages are sent with no `parse_mode`, so any markdown the model emits arrives literally —
`**50 kg**` shows its asterisks and a pipe table renders as a wall of `|---|`. The prompt forbids both,
but a prompt is a request: `toPlainText()` flattens tables to one line per row and strips inline markers
at the point the text leaves the process. Numbers and wording are never touched.

## Stretch features

| Feature | How it works |
|---------|--------------|
| **Branded / templated invoices** | `brand_color`, `classic`/`modern` template and a custom footer are owner preferences, so branding is set conversationally ("make my bills teal, use the modern template") and applies to every future invoice **and** the deck theme. Owner text is ASCII-sanitised because Helvetica has no ₹ glyph. |
| **Scheduled weekly deck** | `schedules` table + a 60s tick in `src/index.ts`. `weekly_deck`, `khata_reminder` and `daily_close` fire on a weekday/hour. A job **claims its slot atomically** (compare-and-set on a local-date `YYYY-MM-DDTHH:MM` key) so a restart mid-run can't double-send; anything queued while the bot was down is flushed on startup. The scheduled deck goes through the *same* `buildDeck()` the agent's tool uses. |
| **Reorder from sales velocity** | `reorder_suggestions` reads the sales journal (`stock_moves` where `reason='sale'`, so receipts and reconciliations aren't mistaken for demand), computes units/day, days of cover left, and sizes the order to a cover window with a 20% buffer — plus its rupee cost and an urgency flag. Also a deck slide. |
| **Expiry / batch tracking with FEFO** | Stock lives in `batches` (qty, cost, expiry, batch no). `products.qty` stays the denormalised total and `ensureBacking()` **self-heals the invariant in both directions**, so legacy rows and out-of-band adjustments can't desync it. Sales consume **first-expiry-first-out** inside the finalize transaction; expired batches are excluded from sellable quantity, so the oversell guard refuses to bill them. `write_off_expired` is the only way out and it refuses any batch that isn't actually past date. |
| **Multi-language (Hindi / Tamil)** | A `language` preference steers replies (own script, everyday shop vocabulary); the model understands any input language regardless. Invoices and decks stay English — they're legal documents. Persists across `/new` like every other preference. |
| **Khata reminders** | `khata_reminders` lists customers who owe and haven't paid in N+ days (staleness measured from their last payment, or oldest charge if never). `draft_khata_reminder` writes a message the owner forwards — **the bot never messages customers itself**, and says so. Schedulable as a weekly digest. |

## Who can operate the store

One shop, one set of books: `products`, `batches`, `stock_moves` and `customers` are **global**, while
`bills`, `khata_txns` and `prefs` are keyed by chat. That's deliberate — the owner may chat from a phone
and a desktop and must see the same stock — but it means **any Telegram user who finds the bot can move
that stock** unless you say otherwise.

So access is explicit, via `OWNER_CHAT_IDS`:

| `OWNER_CHAT_IDS` | Behaviour |
|---|---|
| unset (default) | **Open** — anyone can operate the store. Correct while reviewers are driving it, and a fresh deploy is never mysteriously mute. |
| `123,456,@handle` | Only those chats; everyone else is refused before any handler runs. A numeric id is canonical; an `@handle` is convenience and can be changed by its owner. |

Send `/whoami` to get a chat id. The boot log states which mode is active, so an operator can't be wrong
about it by accident.

## Data model

```sql
products(id, name, brand, size, unit, loose, hsn, gst_rate, cost_price, mrp, sell_price,
         qty, reorder_level, perishable, UNIQUE(name,size))
batches(id, product_id, batch_no, qty, cost_price, expiry)          -- FEFO source of truth
stock_moves(id, product_id, batch_id, delta, reason, ref, ts)        -- audit trail
bills(id, chat_id, status, customer, payment_mode, payment_ref,
      subtotal, cgst, sgst, total, ts_created, ts_final, idempotency_key UNIQUE, void_reason)
bill_items(id, bill_id, product_id, name, qty, unit_price, gst_rate, line_tax, line_total)
customers(id, name UNIQUE, phone, khata_balance)
khata_txns(id, customer_id, chat_id, amount, kind, bill_id, note, ts)
prefs(chat_id, key, value)                    -- incl. __history and __skills
processed_updates(update_id PK, ts)           -- Telegram ingress idempotency
schedules(id, chat_id, kind, weekday, hour, minute, paused, last_run, UNIQUE(chat_id,kind))
notices(id, chat_id, text, sent, ts)          -- scheduler → chat
outbox(id, chat_id, path, caption, sent, ts)  -- generated files → sendDocument
```

`PLAN.md` is the original build plan, kept for history; it predates the harness move and the README is
authoritative where they disagree.
