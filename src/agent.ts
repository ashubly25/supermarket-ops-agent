import { generateText, stepCountIs, type LanguageModel, type ModelMessage } from "ai";
import { MODEL } from "./config.js";
import { getPrefs } from "./repo/prefs.js";
import { getHistory, setHistory, clearHistory } from "./repo/history.js";
import { toolset } from "./lib/tool.js";
import { skillIndex, readSkillTool } from "./lib/skills.js";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { inventoryTools } from "./tools/inventory.js";
import { makeBillingTools } from "./tools/billing.js";
import { makeKhataTools } from "./tools/khata.js";
import { analyticsTools } from "./tools/analytics.js";
import { makeDocumentTools } from "./tools/documents.js";
import { makePrefTools } from "./tools/prefs.js";
import { makeScheduleTools } from "./tools/schedules.js";
import { language } from "./lib/shop.js";

/**
 * Build the store's tool surface for ONE chat. Chat-scoped tools (billing) capture
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

BILLING FLOW
- Build a bill over one or more messages: find_product for each item → add_bill_item. The bill stays a draft; stock is NOT touched until finalize.
- Edits ("drop the butter", "make it 6 Maggi") → set_bill_item. Show the running total after changes.
- Capture payment (cash/upi/card/credit) via set_bill_meta, then finalize_bill. Apply the owner's default payment preference if set and none is stated.

STOCK, EXPIRY & FEFO
- Stock is held in batches. Sales consume First-Expiry-First-Out automatically at finalize — you never pick batches by hand.
- Expired stock is NOT sellable: the tools exclude it. If a sale is refused because of it, tell the owner to write it off (write_off_expired) — and confirm before writing anything off.
- Receive stock immediately; do not hold it up for an expiry date. Only for SHORT-shelf-life goods (milk, curd, paneer, bread, eggs) ask for the date — and only if the owner didn't state one. For everything else record it without an expiry and move on (mention they can add one later).
- For purchase planning prefer reorder_suggestions (sales velocity) over low_stock (static level).

PHOTOS
- When a message includes an image, follow the vision skill (barcode / product pack / shop logo). Never bill from a photo without confirming the matched SKU.

CORE RULES
- GROUNDING: Prices, GST rates, HSN codes and stock levels come ONLY from tools. Never invent a product, price, or stock number. If unsure, call find_product.
- Resolve every product via find_product before acting. If the query is ambiguous (multiple candidates, e.g. "atta" → Aashirvaad 5kg vs loose wheat atta), ASK the owner which one — do not guess.
- The tools enforce the hard rules (oversell guard, GST maths, below-cost refusal, idempotency). If a tool returns an error, relay it plainly and suggest the fix. Do not try to override a guard.
- Money is in ₹ (INR). Be terse and shopkeeper-friendly. Confirm actions with the key numbers.
- Only ask a clarifying question when genuinely ambiguous; otherwise act.

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

const MEDIA: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

/** The owner's turn — a photo (barcode / product pack / shop logo) rides along with the text. */
function userMessage(text: string, imagePath?: string): ModelMessage {
  if (!imagePath) return { role: "user", content: text };
  return {
    role: "user",
    content: [
      { type: "image", image: readFileSync(imagePath), mediaType: MEDIA[extname(imagePath).toLowerCase()] ?? "image/jpeg" },
      { type: "text", text: text || "(photo, no caption)" },
    ],
  };
}

/**
 * Run one owner message through the agent. Replays the chat's stored history so
 * multi-turn bills keep context, then persists the turn. Returns the final text.
 */
export async function runAgent(
  chatId: string,
  message: string,
  imagePath?: string,
  model: LanguageModel = MODEL // a bare "provider/model" string routes via the AI Gateway; overridable so tests can drive the loop offline
): Promise<AgentResult> {
  const history = getHistory(chatId);
  const messages: ModelMessage[] = [...history, userMessage(message, imagePath)];

  const result = await generateText({
    model,
    system: systemPrompt(chatId),
    messages,
    tools: buildTools(chatId),
    stopWhen: stepCountIs(16),
  });

  setHistory(chatId, [...messages, ...result.response.messages]);
  return { text: result.text.trim() || "(no response)", steps: result.steps.length };
}

/** /new — forget the conversation for this chat. Durable store data is untouched. */
export function resetSession(chatId: string): void {
  clearHistory(chatId);
}
