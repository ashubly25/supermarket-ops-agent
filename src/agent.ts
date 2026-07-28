import { generateText, stepCountIs, type LanguageModel, type ModelMessage } from "ai";
import { MODEL } from "./config.js";
import { getPrefs } from "./repo/prefs.js";
import { getHistory, setHistory, clearHistory } from "./repo/history.js";
import { toolset } from "./lib/tool.js";
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
 * Build the store's tool surface for ONE chat. Chat-scoped tools (billing, khata,
 * documents, prefs, schedules) capture
 * chatId in a closure, so the model never has to pass plumbing like chat_id — and
 * concurrent chats can't cross-contaminate their draft bills.
 */
function buildTools(chatId: string) {
  return toolset([
    ...inventoryTools,
    ...makeBillingTools({ chatId }),
    ...makeKhataTools({ chatId }),
    ...analyticsTools,
    ...makeDocumentTools({ chatId }),
    ...makePrefTools({ chatId }),
    ...makeScheduleTools({ chatId }),
    readSkillTool,
  ]);
}

function systemPrompt(chatId: string): string {
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

OUTPUT FORMAT (you are writing into a Telegram chat, which renders NO markdown)
- Write plain text. No **bold**, no *italics*, no backticks, no # headings — the asterisks show up literally on the owner's phone.
- NEVER use a markdown table. Pipes and |---|---| rows render as raw garbage. For a list of items, one short line each:
  Britannia Bread 400g — 20 pkt, expires 30 Jul (2d), ₹800
- Emphasis comes from CAPS or an emoji, sparingly. Keep replies phone-sized: a shopkeeper reads these one-handed.

LANGUAGE
- Reply in: ${language(chatId)}. If that is hindi or tamil, write in that language's own script (Devanagari / தமிழ்) using everyday shop vocabulary; keep numbers, ₹ amounts, GST%, product brand names and tool arguments as-is. Invoices and decks stay in English (legal documents).
- The owner may write in any language; understand it regardless.

SKILLS (playbooks — call read_skill with the name before doing that kind of work; they hold the detail this prompt omits):
${skillIndex()}

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
  const result = await withRateLimitRetry(
    () =>
      generateText({
        model,
        system: systemPrompt(chatId),
        messages,
        tools: buildTools(chatId),
        stopWhen: stepCountIs(16),
        onStepFinish: (step) => {
          if (step.toolCalls.length > 0) toolRan = true;
        },
      }),
    () => !toolRan
  );

  setHistory(chatId, [...messages, ...result.response.messages]);
  return { text: result.text.trim() || "(no response)", steps: result.steps.length };
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
