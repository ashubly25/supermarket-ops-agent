import { generateText, stepCountIs, hasToolCall, type LanguageModel, type ModelMessage } from "ai";
import { MODEL } from "./config.js";
import { getPrefs } from "./repo/prefs.js";
import { getHistory, setHistory, clearHistory } from "./repo/history.js";
import { toolset, type StoreTool } from "./lib/tool.js";
import { skillIndex, readSkillTool } from "./lib/skills.js";
import { inventoryTools } from "./tools/inventory.js";
import { makeBillingTools } from "./tools/billing.js";
import { makeKhataTools } from "./tools/khata.js";
import { analyticsTools } from "./tools/analytics.js";
import { makeDocumentTools } from "./tools/documents.js";
import { makePrefTools } from "./tools/prefs.js";
import { makeScheduleTools } from "./tools/schedules.js";
import { language } from "./lib/shop.js";

/**
 * The store's tools, grouped by the skill that documents them. Chat-scoped groups capture
 * chatId in a closure, so the model never passes plumbing like chat_id — and concurrent
 * chats can't cross-contaminate their draft bills.
 */
function toolGroups(chatId: string): Record<string, StoreTool[]> {
  return {
    inventory: inventoryTools,
    billing: makeBillingTools({ chatId }),
    khata: makeKhataTools({ chatId }),
    analytics: analyticsTools,
    documents: makeDocumentTools({ chatId }),
    memory: makePrefTools({ chatId }),
    scheduling: makeScheduleTools({ chatId }),
  };
}

/**
 * Names that stay available on every turn, so the commonest question ("how much sugar is
 * left?") costs one round trip and no skill read. Everything else is gated.
 */
const ALWAYS_ON = new Set(["find_product", "get_stock", "low_stock"]);

/** How many skill-unlock passes one owner message may take before we answer with what we have. */
const SKILLS_PER_TURN = 4;

/**
 * Progressive disclosure of TOOLS, not just of playbooks. Sending all 34 schemas cost
 * ~4,900 tokens on every single step — far more than the conversation itself — and the
 * model only ever needs one or two domains per turn. So a turn starts with the core plus
 * read_skill, and reading a skill unlocks that skill's tools for the rest of the turn.
 * The skills stop being advisory and start being the thing that grants capability.
 */
function buildTools(chatId: string, unlocked: ReadonlySet<string>) {
  const groups = toolGroups(chatId);
  const core = Object.values(groups)
    .flat()
    .filter((t) => ALWAYS_ON.has(t.name));
  const opened = [...unlocked].flatMap((skill) => groups[skill] ?? []);
  return toolset([...core, ...opened, readSkillTool]);
}

function systemPrompt(chatId: string): string {
  const gated = Object.fromEntries(
    Object.entries(toolGroups(chatId)).map(([skill, tools]) => [skill, tools.map((t) => t.name).filter((n) => !ALWAYS_ON.has(n))])
  );
  const prefs = getPrefs(chatId);
  const prefLines =
    Object.keys(prefs).filter((k) => !k.startsWith("__")).length > 0
      ? Object.entries(prefs)
          .filter(([k]) => !k.startsWith("__"))
          .map(([k, v]) => `- ${k}: ${v}`)
          .join("\n")
      : "- (none set yet)";

  const today = new Date().toISOString().slice(0, 10);

  return `You are the assistant that runs a small Indian kirana / supermarket store from Telegram.
The owner types in terse, plain English (sometimes Hinglish). You keep the store's books correct.
Today is ${today}.

WHERE THE RULES LIVE
The domain rules are in the skills, not here — they change with the business, and a tool that
enforces them is the source of truth. Before acting on a bill, stock, credit, a document or a
schedule, read_skill that domain FIRST, then follow it. Two that decide whether a turn is right
or wrong, so they are worth naming up front:
- A bill is a DRAFT until the owner closes it. A payment mode named while items are still being
  listed ("2kg sugar, 4 maggi, UPI") is recorded, not permission to finalize — the next message is
  very often a correction, and after finalizing that costs a void of a completed sale. See the billing skill.
- Receive stock immediately; never hold a delivery hostage to an expiry date. Only short-shelf-life
  goods (milk, curd, paneer, bread, eggs) are worth one question. See the inventory skill.

CORE RULES
- GROUNDING: Prices, GST rates, HSN codes and stock levels come ONLY from tools. Never invent a product, price, or stock number. If unsure, call find_product.
- Resolve every product via find_product before acting. If the query is ambiguous (multiple candidates, e.g. "atta" → Aashirvaad 5kg vs loose wheat atta), ASK the owner which one — do not guess.
- The tools enforce the hard rules (oversell guard, GST maths, below-cost refusal, idempotency). If a tool returns an error, relay it plainly and suggest the fix. Do not try to override a guard.
- Money is in ₹ (INR). Be terse and shopkeeper-friendly. Confirm actions with the key numbers.
- Only ask a clarifying question when genuinely ambiguous; otherwise act.
- NEVER report an action you did not perform with a tool. If the tool you need isn't in front of you,
  read_skill its domain and then call it. Saying a PDF, deck, bill or schedule is "on its way" without
  the tool call having succeeded is the worst thing you can do — the owner believes their books moved
  when nothing happened.

OUTPUT FORMAT (you are writing into a Telegram chat, which renders NO markdown)
- Write plain text. No **bold**, no *italics*, no backticks, no # headings — the asterisks show up literally on the owner's phone.
- NEVER use a markdown table. Pipes and |---|---| rows render as raw garbage. For a list of items, one short line each:
  Britannia Bread 400g — 20 pkt, expires 30 Jul (2d), ₹800
- Emphasis comes from CAPS or an emoji, sparingly. Keep replies phone-sized: a shopkeeper reads these one-handed.

LANGUAGE
- Reply in: ${language(chatId)}. If that is hindi or tamil, write in that language's own script (Devanagari / தமிழ்) using everyday shop vocabulary; keep numbers, ₹ amounts, GST%, product brand names and tool arguments as-is. Invoices and decks stay in English (legal documents).
- The owner may write in any language; understand it regardless.

SKILLS — each is a playbook AND the key to its tools. You start with only find_product, get_stock and
low_stock; read_skill(name) returns the playbook and unlocks that skill's tools for this turn. So to bill,
read billing first; to receive stock, read inventory; and so on. One read per domain you actually need:
${skillIndex(gated)}

OWNER PREFERENCES (remembered across chats — apply them unless the owner overrides in-message):
${prefLines}`;
}

export interface AgentResult {
  text: string;
  steps: number;
}

/**
 * Run one owner message through the agent. Replays the chat's stored history so
 * multi-turn bills keep context, then persists the turn. Returns the final text.
 */
export async function runAgent(
  chatId: string,
  message: string,
  model: LanguageModel = MODEL // a bare "provider/model" string routes via the AI Gateway; overridable so tests can drive the loop offline
): Promise<AgentResult> {
  const history = getHistory(chatId);
  const messages: ModelMessage[] = [...history, { role: "user", content: message }];

  // A gateway 429 on the *first* model call is worth retrying — nothing has happened yet.
  // Once a tool has run, the turn has side effects (stock received, khata charged) that a
  // replay would repeat, so we surface the error instead and let the owner resend.
  let toolRan = false;
  const unlocked = new Set<string>();
  const convo: ModelMessage[] = [...messages];
  let steps = 0;
  let text = "";

  // Each pass runs until the model either finishes or reads a skill. Reading a skill
  // unlocks its tools, so we start the next pass with a wider surface and the same
  // conversation. Bounded so a model that only ever reads skills still terminates.
  for (let pass = 0; pass < SKILLS_PER_TURN; pass++) {
    const result = await withRateLimitRetry(
      () =>
        generateText({
          model,
          system: systemPrompt(chatId),
          messages: convo,
          tools: buildTools(chatId, unlocked),
          // hasToolCall ends the pass right after read_skill's result lands, so the model
          // never has to reason on with tools it can't see yet.
          stopWhen: [stepCountIs(16), hasToolCall("read_skill")],
          onStepFinish: (step) => {
            if (step.toolCalls.length > 0) toolRan = true;
          },
        }),
      () => !toolRan
    );

    convo.push(...result.response.messages);
    steps += result.steps.length;
    text = result.text.trim() || text;

    const read = result.steps
      .flatMap((s) => s.toolCalls)
      .filter((c) => c.toolName === "read_skill")
      // One call may name several skills ("billing, documents") — unlock all of them.
      .flatMap((c) => String((c.input as { name?: string })?.name ?? "").split(","))
      .map((n) => n.trim().toLowerCase())
      .filter((n) => n && !unlocked.has(n));

    if (read.length === 0) break; // nothing new opened: this pass was the answer
    for (const n of read) unlocked.add(n);
  }

  setHistory(chatId, convo);
  return { text: text || "(no response)", steps };
}

const isRateLimit = (e: unknown): boolean =>
  /rate.?limit|429|quota|overloaded/i.test(String((e as Error)?.message ?? e) + String((e as any)?.name ?? ""));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Retry a rate-limited model call with exponential backoff, but only while `safe()`
 * says a replay has no side effects to repeat.
 */
async function withRateLimitRetry<T>(fn: () => Promise<T>, safe: () => boolean, attempts = 3): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts - 1 || !isRateLimit(e) || !safe()) throw e;
      const wait = 1500 * 2 ** i;
      console.warn(`model rate-limited, retrying in ${wait}ms (attempt ${i + 2}/${attempts})`);
      await sleep(wait);
    }
  }
}

/** /new — forget the conversation for this chat. Durable store data is untouched. */
export function resetSession(chatId: string): void {
  clearHistory(chatId);
}
