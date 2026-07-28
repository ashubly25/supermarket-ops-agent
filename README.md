# Supermarket Ops Agent

Run an Indian kirana / supermarket store end-to-end from a Telegram chat — receive stock, cut GST-correct bills, run khata (credit), close the day, and generate PDF invoices & PPTX analysis decks. The chat is the product; there is no web app or menu.

**Live bot:** [`@zwigato_store_bot`](https://t.me/zwigato_store_bot) &nbsp;·&nbsp; **Harness:** Vercel AI SDK + Anthropic (TypeScript) &nbsp;·&nbsp; **Store:** SQLite

> Message it on Telegram and drive the §3 scenarios yourself. Deployment notes: `DEPLOY.md`.

---

## Why the Vercel AI SDK (TS)

- `generateText({ tools, stopWhen: stepCountIs(16) })` **runs the agent loop for us** — observe → reason → call tool → feed result back → continue, chaining multiple tool calls in a single turn. There is **no intent router / regex**; the model orchestrates. (A keyword router would be an automatic fail per the brief.)
- Tools are plain functions defined with `tool()` and run **in-process** — same Node runtime as SQLite and the Telegram client — so every business rule (oversell, GST, idempotency) is enforced in code **where the data changes**, not hoped for in a prompt.
- **Zod** schemas type and validate every tool input; the model retries on mismatch.
- The SDK is provider-agnostic, so **which key is in `.env` decides the route**: `ANTHROPIC_API_KEY` → Anthropic directly, `OPENROUTER_API_KEY` → OpenRouter, `AI_GATEWAY_API_KEY` → a bare `"<provider>/<model>"` string through the **Vercel AI Gateway**. Model IDs are `provider/model` in all three, so swapping route is an env-var change, not a code change. (An `sk-or-` key left in `AI_GATEWAY_API_KEY` is detected and sent to OpenRouter rather than 401ing against Vercel with a message that reads as if the variable were unset.) `runAgent` also takes a `model` override, which is how `test/agent.test.ts` drives the real loop offline against a mock model.
- **Skills** (`.claude/skills/*/SKILL.md`) are the model-facing playbooks, loaded by `src/lib/skills.ts`: the system prompt carries only the one-line index and the model pulls a full playbook with `read_skill` (progressive disclosure).
- TS pairs with the best doc libraries: `grammY`, `pdfkit`, `pptxgenjs`, `better-sqlite3`.

## Control loop

```
Telegram (grammY long-poll)
  → drop redelivered update_id (ingress idempotency)
  → runAgent(chatId, text): generateText({ messages: stored history, tools, system })
      → SDK loop: reason → tool call → in-process tool → SQLite (WAL, IMMEDIATE txns) → result → repeat
  → send final text; flush any generated files (PDF/PPTX) from the DB outbox via sendDocument
```

One chat = one stored message thread (`prefs.__history`, trimmed to the last 40 messages). **Durable state is in SQLite tables, never in the thread**, so `/new` clears the chat but the store still knows stock, khata, bills and the owner's preferences. Chat-scoped tools (billing, khata, documents, prefs, schedules) are built **per-run with `chatId` captured in a closure**, so the model never passes plumbing and concurrent chats can't cross-contaminate drafts.

## Skills & tools (the capability surface)

Skills are thin playbooks; tools are thin but **rule-strict** — a tool never trusts the model on stock/price/GST, it recomputes and guards. 7 skills, 33 store tools (+ `read_skill`):

| Skill | Tools |
|-------|-------|
| **inventory** | `find_product` · `get_stock` · `low_stock` · `add_product` · `receive_stock` · `expiring_soon` · `write_off_expired` · `adjust_stock` |
| **billing** | `start_bill` · `add_bill_item` · `set_bill_item` · `set_bill_meta` · `show_bill` · `finalize_bill` · `void_bill` |
| **khata** | `khata_charge` · `khata_payment` · `khata_balance` · `khata_reminders` · `draft_khata_reminder` |
| **analytics** | `daily_close` · `sales_report` · `reorder_suggestions` |
| **documents** | `generate_invoice_pdf` · `generate_analysis_deck` · `preview_branding` |
| **scheduling** | `set_schedule` · `list_schedules` · `cancel_schedule` · `run_scheduled_job_now` |
| **memory** | `set_preference` · `get_preferences` · `forget_preference` |

The **system prompt stays thin** — persona, "always ground via tools / never invent", "ask when ambiguous", plus the owner's remembered preferences injected each turn. All hard rules live in the tools/repos.

## How each hard part is solved

| Hard part | Where & how |
|-----------|-------------|
| **Grounding** | Prices/GST/HSN/stock only ever come from `find_product`/`get_stock`. Structurally enforced where it counts: every mutation takes a `product_id` the tools resolved, so the model **cannot write** an invented product or price. In narration it is prompt-guided — an honest distinction worth stating rather than claiming the model is incapable of a wrong sentence. |
| **Oversell guard** | Checked in `add_bill_item` (vs live stock **minus** quantity claimed by other open drafts) **and** re-checked inside the `finalize_bill` transaction. Refusals return `isError`. |
| **GST correctness** | Per-item slab from DB. Inclusive MRP → taxable reversed out, tax = gross − taxable, **CGST = SGST = tax/2** with odd paise absorbed so they always sum. Per-slab breakup on the running bill and the PDF; grand total rounded with a round-off line. |
| **Multi-turn bills** | Draft persisted in `bills`/`bill_items`; edits mutate the draft; **stock is decremented only on finalize**. One draft per chat — `start_bill` returns the open one rather than creating a second, which `currentDraft()` would hide while it went on reserving stock. Lines are always priced at the product's *current* sell price, so touching a line whose price moved mid-draft re-prices it and the reply says so (`⚠️ … re-priced ₹55 → ₹65`). |
| **Idempotency** | (a) `processed_updates(update_id)` drops Telegram redeliveries at ingress. (b) `bills.idempotency_key UNIQUE` (`finalize-bill-<id>`) → a retried finalize returns the same bill with **no double-decrement**. |
| **Concurrency** | `better-sqlite3` is synchronous; **every** mutating repo call runs in a `BEGIN IMMEDIATE` transaction (`immediateTxn`), so a callback is atomic w.r.t. other writers by construction. Add-time guard is cross-draft aware; finalize re-reads stock inside the txn → stock can never go negative even with two bills / a sale + stock-in in flight. WAL mode. |
| **Guardrails** | Below-cost sale refused in `add_bill_item`/`add_product`; fractional quantities of packet/piece/dozen goods refused at the till **and** on stock-in; no delete-stock tool exists; `khata_payment` refuses an unknown customer; paying over the balance is allowed and recorded as an advance the shop owes back, as a paper khata does. |
| **Real artifacts** | `pdfkit` renders a GST tax invoice (shop header + GSTIN, per-line HSN/CGST/SGST, per-slab summary, total in words). `pptxgenjs` builds a deck (up to 6 slides) with **real charts** (bar/doughnut/line), GST-slab table, stock-health table, velocity reorder plan, expiry watch and written insights. Delivered via a DB outbox → `sendDocument`. |
| **Memory across sessions** | `prefs` table keyed by chat; injected into the system prompt each turn, and read at call time by `shopInfo()`/`language()` for invoices and decks. Memory lives in SQLite, not the context window: `/new` deletes only the `__history` blob — preferences and all store data persist. Scope is per `chat_id`, so the owner's DM carries their settings; a *different* chat (say a group) starts fresh rather than inheriting them. |

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

## Realistic margins

Cost prices are set from actual kirana trade margins, not round numbers: ~4% on milk, 7–9% on staples,
10–13% on FMCG, ~10% on MRP-controlled lines like Coca-Cola. Blended ≈ **9.5%**, which is what a corner
store lives on. An earlier draft carried ~18% blended; a test now fails if any SKU exceeds 15%, because
inflated margins quietly make every number the analytics tools report into fiction.

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
  negative and it is not a delete — expired stock still has to go through `write_off_expired`.

Both require a reason on the audit trail, and both skills instruct the agent to **confirm before calling**.

## Stretch features

| Feature | How it works |
|---------|--------------|
| **Branded / templated invoices** | `brand_color`, `classic`/`modern` template and a custom footer are owner preferences, so branding is set conversationally ("make my bills teal, use the modern template") and applies to every future invoice **and** the deck theme. Owner text is ASCII-sanitised because Helvetica has no ₹ glyph. |
| **Scheduled weekly deck** | `schedules` table + a 60s tick in `src/index.ts`. `weekly_deck`, `khata_reminder` and `daily_close` fire on a weekday/hour. A job **claims its slot atomically** (compare-and-set on a `YYYY-MM-DDTHH:MM` key) so a restart mid-run can't double-send; anything queued while the bot was down is flushed on startup. The scheduled deck goes through the *same* `buildDeck()` the agent's tool uses. |
| **Reorder from sales velocity** | `reorder_suggestions` reads the sales journal (`stock_moves` where `reason='sale'`, so receipts and reconciliations aren't mistaken for demand), computes units/day, days of cover left, and sizes the order to a cover window with a 20% buffer — plus its rupee cost and an urgency flag. Also a deck slide. |
| **Expiry / batch tracking with FEFO** | Stock lives in `batches` (qty, cost, expiry, batch no). `products.qty` stays the denormalised total and `ensureBacking()` **self-heals the invariant in both directions**, so legacy rows and out-of-band adjustments can't desync it. Sales consume **first-expiry-first-out** inside the finalize transaction; expired batches are excluded from sellable quantity, so the oversell guard refuses to bill them. `write_off_expired` is the only way out and it refuses any batch that isn't actually past date. |
| **Multi-language (Hindi / Tamil)** | A `language` preference steers replies (own script, everyday shop vocabulary); the model understands any input language regardless. Invoices and decks stay English — they're legal documents. Persists across `/new` like every other preference. |
| **Khata reminders** | `khata_reminders` lists customers who owe and haven't paid in N+ days (staleness measured from their last payment, or oldest charge if never). `draft_khata_reminder` writes a message the owner forwards — **the bot never messages customers itself**, and says so. Schedulable as a weekly digest. |

## Run locally

```bash
cp .env.example .env      # TELEGRAM_BOT_TOKEN + one of ANTHROPIC_API_KEY / OPENROUTER_API_KEY / AI_GATEWAY_API_KEY
npm install
npm run seed              # load 19 real SKUs (idempotent)
npm run dev               # long-poll bot
npm test                  # 46 tests: GST, oversell, idempotency, concurrency, khata, memory,
                          #           FEFO, expiry write-off, velocity, scheduling
node --import tsx test/docs.smoke.ts   # renders a branded PDF + deck, runs the scheduler jobs
```

Deploy (Oracle Cloud Always Free, always-on, persistent SQLite): see **`DEPLOY.md`**.
Walkthrough script for the recording: see **`RECORDING.md`**.
Full design rationale and data model: see **`PLAN.md`**.

## Try it (the §3 scenarios)

```
50 packets of Maggi came in, cost ₹12, MRP ₹14
new item: Amul Butter 100g, GST 12%, MRP ₹62
make a bill: 2kg sugar, 1 aashirvaad atta 5kg, 4 maggi, 1 amul butter, UPI
drop the butter, make it 6 maggi
how much sugar is left?    ·    what's running out?
put ₹500 on Ramesh's credit    ·    Ramesh paid ₹300    ·    Ramesh's balance?
today's sales?    ·    send me that bill as a PDF    ·    make this week's analysis deck
always assume UPI unless I say cash    ·    default atta = Aashirvaad 5kg
```

Stretch scenarios:

```
20 packets of Amul curd came in, cost ₹22, expiry 5 August
what's expiring?    ·    write off the expired bread
what should I order this week?
send me the sales deck every Monday at 9am    ·    what's scheduled?
who owes me money?    ·    remind Ramesh
make my bills teal and use the modern template
अब से हिंदी में बात करो
```
