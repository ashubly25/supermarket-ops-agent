# Supermarket Ops Agent

Run an Indian kirana / supermarket store end-to-end from a Telegram chat — receive stock, cut GST-correct bills, run khata (credit), close the day, and generate PDF invoices & PPTX analysis decks. The chat is the product; there is no web app or menu.

**Live bot:** [`@zwigato_store_bot`](https://t.me/zwigato_store_bot) — message it and drive the §3 scenarios yourself.
**Harness:** Vercel AI SDK (TypeScript) · **Store:** SQLite · **Deploy:** Oracle Always Free, long-poll.

## Why the Vercel AI SDK

`generateText({ tools, stopWhen })` **is** the control loop — observe → reason → call tool → feed the result back → continue, chaining several tool calls per turn. There is no intent router and no regex dispatch; the model orchestrates. Tools are plain functions running **in-process** with SQLite and the Telegram client, so every business rule is enforced in code where the data changes rather than hoped for in a prompt. Zod types every input. The model id is a `provider/model` string, so switching between Anthropic direct, OpenRouter and the Vercel AI Gateway is an env-var change.

## Control loop

```
Telegram (grammY long-poll)
  → drop redelivered update_id (ingress idempotency)
  → runAgent(chatId, text): generateText({ system, stored history, tools })
      → reason → tool call → in-process tool → SQLite (WAL, BEGIN IMMEDIATE) → result → repeat
  → reply as plain text; flush generated PDF/PPTX from the DB outbox via sendDocument
```

One chat = one stored thread (`prefs.__history`, last 40 messages). **Durable state lives in SQLite tables, never in the thread**, so `/new` clears the conversation while stock, khata, bills and preferences survive. Chat-scoped tools capture `chatId` in a closure, so the model never passes plumbing and two chats cannot cross-contaminate drafts.

## Skills & tools

Skills are the model-facing playbooks (`.claude/skills/*/SKILL.md`); tools are thin but **rule-strict** — a tool never trusts the model on stock, price or GST, it recomputes and guards. **7 skills, 33 store tools + `read_skill`.**

| Skill | Tools |
|-------|-------|
| **inventory** | `find_product` · `get_stock` · `low_stock` · `add_product` · `receive_stock` · `expiring_soon` · `write_off_expired` · `adjust_stock` |
| **billing** | `start_bill` · `add_bill_item` · `set_bill_item` · `set_bill_meta` · `show_bill` · `finalize_bill` · `void_bill` |
| **khata** | `khata_charge` · `khata_payment` · `khata_balance` · `khata_reminders` · `draft_khata_reminder` |
| **analytics** | `daily_close` · `sales_report` · `reorder_suggestions` |
| **documents** | `generate_invoice_pdf` · `generate_analysis_deck` · `preview_branding` |
| **scheduling** | `set_schedule` · `list_schedules` · `cancel_schedule` · `run_scheduled_job_now` |
| **memory** | `set_preference` · `get_preferences` · `forget_preference` |

**Skills grant capability, they don't just advise.** A turn starts with `find_product`, `get_stock`, `low_stock` and `read_skill`; reading a skill returns its playbook *and* unlocks its tools for the conversation. Sending all 34 schemas on every step cost ~4,900 tokens a call — more than the conversation — so gating them cut tool tokens 77% and total input 43% on the same 8-turn script. The system prompt stays thin: persona, grounding, output format, and the owner's remembered preferences.

## How each hard part is solved

| Hard part | Where & how |
|-----------|-------------|
| **Grounding** | Every mutation takes a `product_id` the tools resolved, so the model **cannot write** an invented product or price. Narration is prompt-guided — an honest distinction. |
| **Oversell guard** | `add_bill_item` checks live stock **minus** quantity claimed by other open drafts; `finalize_bill` re-checks inside the transaction. Refusals return `isError`. |
| **GST correctness** | Per-item slab from the DB. Inclusive price → taxable reversed out, tax = gross − taxable, **CGST = SGST = tax/2** with odd paise absorbed so the halves always sum. Per-slab breakup on the bill and the invoice; grand total rounded with a round-off line. |
| **Multi-turn bills** | Draft persisted in `bills`/`bill_items`; edits mutate the draft; **stock decrements only on finalize**. A payment mode named while items are still being listed is recorded, not permission to close — the next message is usually a correction. |
| **Idempotency** | `processed_updates(update_id)` drops Telegram redeliveries at ingress; `bills.idempotency_key UNIQUE` makes a retried finalize return the same bill with no double-decrement. |
| **Concurrency** | Every mutating repo call runs in a `BEGIN IMMEDIATE` transaction, so it is atomic w.r.t. other writers by construction. Proven with two OS processes racing: 33 bills sold of 100 units, ledger balanced, zero negative rows. |
| **Guardrails** | Below-cost refused at `add_product`, `add_bill_item`, re-price and finalize; fractional packets refused at the till and on stock-in; no delete-stock tool exists; `khata_payment` refuses an unknown customer; `void_bill` reverses rather than deletes. |
| **Real artifacts** | `pdfkit` renders a GST tax invoice (GSTIN header, per-line HSN/CGST/SGST, per-slab summary, total in words). `pptxgenjs` builds up to 6 slides with **native PowerPoint charts** (bar/doughnut/line), GST-slab table, stock health, velocity reorder plan and FEFO expiry watch. Delivered via a DB outbox → `sendDocument`. |
| **Memory across sessions** | `prefs` keyed by chat, injected into the system prompt each turn and read at call time for invoice branding. `/new` deletes only the `__history` blob; preferences and store data persist — verified across a process restart. |

Stretch shipped: branded invoices · scheduled weekly deck · velocity reorder · FEFO expiry/batches · Hindi/Tamil · khata reminders.

## Run it

```bash
cp .env.example .env   # TELEGRAM_BOT_TOKEN + one of ANTHROPIC_API_KEY / OPENROUTER_API_KEY / AI_GATEWAY_API_KEY
npm install && npm run seed && npm run dev
npm test               # 63 tests: GST, oversell, idempotency, concurrency, khata, memory, FEFO, velocity, scheduling
```

```
50 packets of Maggi came in, cost ₹12, MRP ₹14
make a bill: 2kg sugar, 1 aashirvaad atta 5kg, 4 maggi, 1 amul butter, UPI
drop the butter, make it 6 maggi        ·   how much sugar is left?
put ₹500 on Ramesh's credit             ·   Ramesh paid ₹300
today's sales?  ·  send me that bill as a PDF  ·  make this week's analysis deck
always assume UPI unless I say cash     ·   then /new — it still applies
```

**More:** design decisions and domain research in [`DESIGN.md`](DESIGN.md) · deployment in [`DEPLOY.md`](DEPLOY.md) 

> One deliberate divergence: the 12% GST slab was abolished on 22 Sep 2025, so the brief's `GST 12%` example is corrected to 5% and the agent says why. Reasoning in [`DESIGN.md`](DESIGN.md).
