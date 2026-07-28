import { tool } from "../lib/tool.js";
import { z } from "zod";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { extname, join } from "node:path";
import * as bills from "../repo/bills.js";
import { getPref, setPref } from "../repo/prefs.js";
import { queueFile } from "../repo/updates.js";
import { generateInvoicePdf } from "../docs/invoice.js";
import { shopInfo } from "../lib/shop.js";
import { buildDeck } from "../jobs.js";
import { ARTIFACTS_DIR } from "../config.js";

export interface Ctx {
  chatId: string;
}

function ok(text: string, data?: unknown) {
  return {
    content: [{ type: "text" as const, text }],
    ...(data !== undefined ? { structuredContent: data as Record<string, unknown> } : {}),
  };
}
function err(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

export function makeDocumentTools(ctx: Ctx) {
  const invoicePdf = tool(
    "generate_invoice_pdf",
    "Generate a clean, GST-correct PDF tax invoice for a FINALIZED bill and send it to the owner. Uses the shop's name/GSTIN/address from preferences. Provide the bill id (from the finalized bill).",
    { bill_id: z.number().int().describe("The bill's id (must be finalized)") },
    async ({ bill_id }) => {
      const bill = bills.getBill(bill_id);
      if (!bill) return err(`Bill #${bill_id} not found.`);
      // Bills belong to the chat that cut them — never render another shop's invoice.
      if (bill.chat_id !== ctx.chatId) return err(`Bill #${bill_id} does not belong to this shop.`);
      if (bill.status !== "final") return err(`Bill #${bill_id} is a ${bill.status}; finalize it before making an invoice.`);
      const items = bills.getItems(bill_id);
      try {
        const path = await generateInvoicePdf(bill, items, shopInfo(ctx.chatId), ctx.chatId);
        queueFile(ctx.chatId, path, `Invoice INV-${String(bill_id).padStart(5, "0")}`);
        return ok(`Invoice PDF for bill #${bill_id} generated and is being sent to you.`, { path });
      } catch (e) {
        return err(`Failed to make PDF: ${(e as Error).message}`);
      }
    }
  );

  const analysisDeck = tool(
    "generate_analysis_deck",
    "Generate a PowerPoint (PPTX) sales-analysis deck for a date range — with real charts (top items, payment mix, daily trend), GST breakup, stock health and insights — and send it to the owner. Compute from/to from today's date (e.g. 'this week').",
    {
      from: z.string().describe("Start date YYYY-MM-DD"),
      to: z.string().describe("End date YYYY-MM-DD (inclusive)"),
    },
    async ({ from, to }) => {
      try {
        const { path, report, extras } = await buildDeck(ctx.chatId, from, to);
        return ok(
          `Analysis deck for ${from} → ${to} generated and is being sent to you. ` +
            `(${report.bill_count} bills, sales ₹${report.gross_sales}; ${extras.reorder.length} reorder suggestions, ${extras.expiring.length} batches on the expiry watch.)`,
          { path }
        );
      } catch (e) {
        return err(`Failed to make deck: ${(e as Error).message}`);
      }
    }
  );

  const setLogo = tool(
    "set_shop_logo",
    "Use the photo the owner just sent as the shop logo on invoices and decks. Call this only right after the owner sends an image and says it's their logo/sign board.",
    {},
    async () => {
      const src = getPref(ctx.chatId, "__last_photo");
      if (!src || !existsSync(src)) return err("I don't have a recent photo from you. Send the logo image first, then ask again.");
      const dir = join(ARTIFACTS_DIR, ctx.chatId);
      mkdirSync(dir, { recursive: true });
      const dest = join(dir, `logo${extname(src) || ".jpg"}`);
      copyFileSync(src, dest);
      setPref(ctx.chatId, "shop_logo", dest);
      return ok("Logo saved — it'll appear on your invoices and analysis decks from now on.", { logo: dest });
    }
  );

  const previewBranding = tool(
    "preview_branding",
    "Show the shop's current invoice branding (name, GSTIN, colour, template, logo, footer) so the owner can confirm or change it.",
    {},
    async () => {
      const s = shopInfo(ctx.chatId);
      return ok(
        `Invoice branding:\n• Shop: ${s.name}\n• GSTIN: ${s.gstin}\n• Address: ${s.address}\n• Phone: ${s.phone}\n` +
          `• Template: ${s.template}\n• Brand colour: #${s.brand_color}\n• Logo: ${s.logo_path ? "set" : "not set"}\n• Footer: ${s.footer ?? "(default)"}`,
        { shop: s }
      );
    }
  );

  return [invoicePdf, analysisDeck, setLogo, previewBranding];
}
