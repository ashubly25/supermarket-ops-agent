import { query, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { MODEL, PROJECT_CWD } from "./config.js";
import { getPrefs, getPref, setPref, deletePref } from "./repo/prefs.js";
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

const SESSION_KEY = "__session_id";

/**
 * Build the store's tool surface for ONE chat. Chat-scoped tools (billing) capture
 * chatId in a closure, so the model never has to pass plumbing like chat_id — and
 * concurrent chats can't cross-contaminate their draft bills.
 */
function buildTools(chatId: string) {
  const tools = [
    ...inventoryTools,
    ...makeBillingTools({ chatId }),
    ...makeKhataTools({ chatId }),
    ...analyticsTools,
    ...makeDocumentTools({ chatId }),
    ...makePrefTools({ chatId }),
    ...makeScheduleTools({ chatId }),
  ];
  const server = createSdkMcpServer({ name: "store", version: "1.0.0", tools });
  const allowed = tools.map((t) => `mcp__store__${t.name}`);
  return { server, allowed };
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
- On receive_stock for a perishable (milk, curd, bread, eggs, paneer), ask for the expiry date if the owner didn't say one.
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

OWNER PREFERENCES (remembered across chats — apply them unless the owner overrides in-message):
${prefLines}`;
}

export interface AgentResult {
  text: string;
  sessionId?: string;
}

const MEDIA: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

/** Single-message streaming input, so a photo can ride along with the text. */
async function* imagePrompt(text: string, imagePath: string, sessionId: string) {
  const media = MEDIA[extname(imagePath).toLowerCase()] ?? "image/jpeg";
  yield {
    type: "user" as const,
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      role: "user" as const,
      content: [
        { type: "image" as const, source: { type: "base64" as const, media_type: media as any, data: readFileSync(imagePath).toString("base64") } },
        { type: "text" as const, text: text || "(photo, no caption)" },
      ],
    },
  };
}

/**
 * Run one owner message through the agent. Resumes the chat's prior session so
 * multi-turn bills keep context. Returns the final assistant text.
 * `imagePath` attaches a photo (barcode / product pack / shop logo) to the turn.
 */
export async function runAgent(chatId: string, message: string, imagePath?: string): Promise<AgentResult> {
  const resume = getPref(chatId, SESSION_KEY);
  let sessionId: string | undefined = resume;
  let finalText = "";

  const { server, allowed } = buildTools(chatId);

  const stream = query({
    prompt: imagePath ? imagePrompt(message, imagePath, resume ?? "") : message,
    options: {
      model: MODEL,
      systemPrompt: systemPrompt(chatId),
      mcpServers: { store: server },
      allowedTools: allowed,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true, // trusted server context, no interactive prompts
      maxTurns: 16,
      cwd: PROJECT_CWD,
      // Load the store's Skills (playbooks) from .claude/skills/.
      settingSources: ["project"],
      ...(resume ? { resume } : {}),
    },
  });

  for await (const msg of stream as AsyncIterable<any>) {
    if (msg.session_id) sessionId = msg.session_id;
    if (msg.type === "result" && msg.subtype === "success") {
      finalText = msg.result ?? finalText;
    }
  }

  if (sessionId && sessionId !== resume) setPref(chatId, SESSION_KEY, sessionId);
  return { text: finalText || "(no response)", sessionId };
}

/** /new — forget the conversation session for this chat. Durable store data is untouched. */
export function resetSession(chatId: string): void {
  deletePref(chatId, SESSION_KEY);
}
