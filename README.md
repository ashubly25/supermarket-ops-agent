# Supermarket Ops Agent

Run an Indian kirana / supermarket store end-to-end from a Telegram chat — receive stock, cut GST-correct bills, run khata (credit), close the day, and generate PDF invoices & PPTX analysis decks. The chat is the product; there is no web app or menu.

**Live bot:** [`@zwigato_store_bot`](https://t.me/zwigato_store_bot) &nbsp;·&nbsp; **Harness:** Vercel AI SDK + Anthropic (TypeScript) &nbsp;·&nbsp; **Store:** SQLite

> Message it on Telegram and drive the §3 scenarios yourself. Deployment notes: `DEPLOY.md`.

---

## Why the Vercel AI SDK (TS)

- `generateText({ tools, stopWhen: stepCountIs(16) })` **runs the agent loop for us** — observe → reason → call tool → feed result back → continue, chaining multiple tool calls in a single turn. There is **no intent router / regex**; the model orchestrates. (A keyword router would be an automatic fail per the brief.)
- Tools are plain functions defined with `tool()` and run **in-process** — same Node runtime as SQLite and the Telegram client — so every business rule (oversell, GST, idempotency) is enforced in code **where the data changes**, not hoped for in a prompt.
- **Zod** schemas type and validate every tool input; the model retries on mismatch.
- The SDK is provider-agnostic, so **which key is in `.env` decides the route**: `ANTHROPIC_API_KEY` talks to Anthropic directly, `AI_GATEWAY_API_KEY` hands the SDK a bare `"<provider>/<model>"` string and lets the **Vercel AI Gateway** route it. Swapping provider is an env-var change, not a code change. `runAgent` also takes a `model` override, which is how `test/agent.test.ts` drives the real loop offline against a mock model.
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

One chat = one stored message thread (`prefs.__history`, trimmed to the last 40 messages and stripped of image bytes). **Durable state is in SQLite tables, never in the thread**, so `/new` clears the chat but the store still knows stock, khata, bills and the owner's preferences. Chat-scoped tools (billing, documents, prefs) are built **per-run with `chatId` captured in a closure**, so the model never passes plumbing and concurrent chats can't cross-contaminate drafts.

## Skills & tools (the capability surface)

Skills are thin playbooks; tools are thin but **rule-strict** — a tool never trusts the model on stock/price/GST, it recomputes and guards. 8 skills, 34 store tools (+ `read_skill`) (the `vision` skill is a pure playbook — it composes inventory and document tools):

| Skill | Tools |
|-------|-------|
| **inventory** | `find_product` · `get_stock` · `low_stock` · `add_product` · `receive_stock` · `expiring_soon` · `write_off_expired` · `find_by_barcode` · `set_barcode` |
| **vision** | (photos) → `find_by_barcode` · `find_product` · `set_barcode` · `set_shop_logo` |
| **billing** | `start_bill` · `add_bill_item` · `set_bill_item` · `set_bill_meta` · `show_bill` · `finalize_bill` |
| **khata** | `khata_charge` · `khata_payment` · `khata_balance` · `khata_reminders` · `draft_khata_reminder` |
| **analytics** | `daily_close` · `sales_report` · `reorder_suggestions` |
| **documents** | `generate_invoice_pdf` · `generate_analysis_deck` · `set_shop_logo` · `preview_branding` |
| **scheduling** | `set_schedule` · `list_schedules` · `cancel_schedule` · `run_scheduled_job_now` |
| **memory** | `set_preference` · `get_preferences` · `forget_preference` |

The **system prompt stays thin** — persona, "always ground via tools / never invent", "ask when ambiguous", plus the owner's remembered preferences injected each turn. All hard rules live in the tools/repos.

## How each hard part is solved

| Hard part | Where & how |
|-----------|-------------|
| **Grounding** | Prices/GST/HSN/stock only ever come from `find_product`/`get_stock`. The model is told to never invent; tools are the sole source. |
| **Oversell guard** | Checked in `add_bill_item` (vs live stock **minus** quantity claimed by other open drafts) **and** re-checked inside the `finalize_bill` transaction. Refusals return `isError`. |
| **GST correctness** | Per-item slab from DB. Inclusive MRP → taxable reversed out, tax = gross − taxable, **CGST = SGST = tax/2** with odd paise absorbed so they always sum. Per-slab breakup on the running bill and the PDF; grand total rounded with a round-off line. |
| **Multi-turn bills** | Draft persisted in `bills`/`bill_items`; edits mutate the draft; **stock is decremented only on finalize**. |
| **Idempotency** | (a) `processed_updates(update_id)` drops Telegram redeliveries at ingress. (b) `bills.idempotency_key UNIQUE` (`finalize-bill-<id>`) → a retried finalize returns the same bill with **no double-decrement**. |
| **Concurrency** | `better-sqlite3` is synchronous; writes use `BEGIN IMMEDIATE` transactions. Add-time guard is cross-draft aware; finalize re-reads stock inside the txn → stock can never go negative even with two bills / a sale + stock-in in flight. WAL mode. |
| **Guardrails** | Below-cost sale refused in `add_item`/`add_product`; no delete-stock tool exists; `khata_payment` refuses an unknown customer or an over-payment. |
| **Real artifacts** | `pdfkit` renders a GST tax invoice (shop header + GSTIN, per-line HSN/CGST/SGST, per-slab summary, total in words). `pptxgenjs` builds a deck (up to 6 slides) with **real charts** (bar/doughnut/line), GST-slab table, stock-health table, velocity reorder plan, expiry watch and written insights. Delivered via a DB outbox → `sendDocument`. |
| **Memory across sessions** | `prefs` table keyed by chat; injected into the system prompt each turn. `/new` deletes only the message thread — preferences and all store data persist. |

## Stretch features

| Feature | How it works |
|---------|--------------|
| **Branded / templated invoices** | Shop logo, `brand_color`, `classic`/`modern` template and a custom footer are owner preferences, so branding is set conversationally ("put my logo on the bills" → send the photo → `set_shop_logo`) and applies to every future invoice **and** the deck theme. Owner text is ASCII-sanitised because Helvetica has no ₹ glyph. |
| **Scheduled weekly deck** | `schedules` table + a 60s tick in `src/index.ts`. `weekly_deck`, `khata_reminder` and `daily_close` fire on a weekday/hour. A job **claims its slot atomically** (compare-and-set on a `YYYY-MM-DDTHH:MM` key) so a restart mid-run can't double-send; anything queued while the bot was down is flushed on startup. The scheduled deck goes through the *same* `buildDeck()` the agent's tool uses. |
| **Reorder from sales velocity** | `reorder_suggestions` reads the sales journal (`stock_moves` where `reason='sale'`, so receipts and reconciliations aren't mistaken for demand), computes units/day, days of cover left, and sizes the order to a cover window with a 20% buffer — plus its rupee cost and an urgency flag. Also a deck slide. |
| **Expiry / batch tracking with FEFO** | Stock lives in `batches` (qty, cost, expiry, batch no). `products.qty` stays the denormalised total and `ensureBacking()` **self-heals the invariant in both directions**, so legacy rows and out-of-band adjustments can't desync it. Sales consume **first-expiry-first-out** inside the finalize transaction; expired batches are excluded from sellable quantity, so the oversell guard refuses to bill them. `write_off_expired` is the only way out and it refuses any batch that isn't actually past date. |
| **Multi-language (Hindi / Tamil)** | A `language` preference steers replies (own script, everyday shop vocabulary); the model understands any input language regardless. Invoices and decks stay English — they're legal documents. Persists across `/new` like every other preference. |
| **Barcode / product photo** | Telegram photos are downloaded and passed to the model as an **image content block** in the same agent loop — no OCR branch, no classifier. The model reads the EAN digits under the bars → `find_by_barcode`, or identifies the pack and confirms via `find_product`, then `set_barcode` links it for next time. 8 seeded SKUs carry real EANs. |
| **Khata reminders** | `khata_reminders` lists customers who owe and haven't paid in N+ days (staleness measured from their last payment, or oldest charge if never). `draft_khata_reminder` writes a message the owner forwards — **the bot never messages customers itself**, and says so. Schedulable as a weekly digest. |

## Run locally

```bash
cp .env.example .env      # TELEGRAM_BOT_TOKEN + ANTHROPIC_API_KEY (or AI_GATEWAY_API_KEY)
npm install
npm run seed              # load 18 real SKUs (idempotent)
npm run dev               # long-poll bot
npm test                  # 29 tests: GST, oversell, idempotency, concurrency, khata, memory,
                          #           FEFO, expiry write-off, velocity, scheduling, barcode
node --import tsx test/docs.smoke.ts   # renders a branded PDF + deck, runs the scheduler jobs
```

Deploy (Oracle Cloud Always Free, always-on, persistent SQLite): see **`DEPLOY.md`**.
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
[send a photo of a barcode]    ·    [send your logo] make this my logo
make my bills teal and use the modern template
अब से हिंदी में बात करो
```
