import { tool } from "../lib/tool.js";
import { z } from "zod";
import { join } from "node:path";
import * as bills from "../repo/bills.js";
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
    "Generate a clean, GST-correct PDF tax invoice for a FINALIZED bill and send it to the owner. Uses the shop's name/GSTIN/address from preferences. Omit bill_id for 'that bill' / 'the last bill' — it defaults to the most recent finalized bill in this chat.",
    {
      bill_id: z
        .number()
        .int()
        .optional()
        .describe("The bill's id (must be finalized). Defaults to the last finalized bill in this chat."),
    },
    async ({ bill_id: requested }) => {
      const bill_id = requested ?? bills.lastFinalized(ctx.chatId)?.id;
      if (!bill_id) return err("No finalized bill in this chat yet — finalize one first.");
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

  const previewBranding = tool(
    "preview_branding",
    "Show the shop's current invoice branding (name, GSTIN, colour, template, footer) so the owner can confirm or change it.",
    {},
    async () => {
      const s = shopInfo(ctx.chatId);
      return ok(
        `Invoice branding:\n• Shop: ${s.name}\n• GSTIN: ${s.gstin}\n• Address: ${s.address}\n• Phone: ${s.phone}\n` +
          `• Template: ${s.template}\n• Brand colour: #${s.brand_color}\n• Footer: ${s.footer ?? "(default)"}`,
        { shop: s }
      );
    }
  );

  return [invoicePdf, analysisDeck, previewBranding];
}
