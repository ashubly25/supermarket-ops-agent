import { tool } from "../lib/tool.js";
import { z } from "zod";
import { getPrefs, setPref, deletePref } from "../repo/prefs.js";

export interface Ctx {
  chatId: string;
}

function ok(text: string, data?: unknown) {
  return {
    content: [{ type: "text" as const, text }],
    ...(data !== undefined ? { structuredContent: data as Record<string, unknown> } : {}),
  };
}

// Curated keys the owner can set, with friendly aliases the model should map to.
const KNOWN = [
  "default_payment", // cash|upi|card
  "default_atta", // preferred brand/size when owner says just "atta"
  "shop_name",
  "gstin",
  "shop_address",
  "shop_phone",
  "shop_state",
  "language", // english | hindi | tamil | hinglish — language for replies
  "brand_color", // hex like #1F6FEB — invoice/deck accent
  "invoice_template", // classic | modern
  "invoice_footer", // extra line at the bottom of every invoice
  "khata_reminder_days", // how stale a khata must be before it's flagged
] as const;

export function makePrefTools(ctx: Ctx) {
  const setPreference = tool(
    "set_preference",
    `Remember a standing owner preference across chats (persists beyond /new). Use for "always assume UPI unless I say cash" (default_payment=upi), "default atta = Aashirvaad 5kg" (default_atta), shop identity on invoices (shop_name, gstin, shop_address, shop_phone, shop_state), invoice branding (brand_color, invoice_template, invoice_footer), or "reply in Hindi" (language=hindi). Known keys: ${KNOWN.join(", ")}.`,
    {
      key: z.string().describe(`Preference key. One of: ${KNOWN.join(", ")}`),
      value: z.string().describe("Preference value to remember"),
    },
    async ({ key, value }) => {
      const k = key.trim().toLowerCase().replace(/\s+/g, "_");
      setPref(ctx.chatId, k, value);
      return ok(`Got it — I'll remember ${k} = "${value}" from now on.`, { key: k, value });
    }
  );

  const getPreferences = tool(
    "get_preferences",
    "List the owner's currently remembered preferences (payment default, preferred brands, shop identity).",
    {},
    async () => {
      const p = Object.fromEntries(Object.entries(getPrefs(ctx.chatId)).filter(([k]) => !k.startsWith("__")));
      if (Object.keys(p).length === 0) return ok("No preferences set yet.", { prefs: {} });
      return ok(Object.entries(p).map(([k, v]) => `- ${k}: ${v}`).join("\n"), { prefs: p });
    }
  );

  const forgetPreference = tool(
    "forget_preference",
    "Forget a previously set preference.",
    { key: z.string() },
    async ({ key }) => {
      const k = key.trim().toLowerCase().replace(/\s+/g, "_");
      deletePref(ctx.chatId, k);
      return ok(`Forgotten ${k}.`, { key: k });
    }
  );

  return [setPreference, getPreferences, forgetPreference];
}
