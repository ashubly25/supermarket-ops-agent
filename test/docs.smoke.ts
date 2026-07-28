// Standalone artifact smoke: builds a finalized bill + a week of sales, then renders
// a BRANDED PDF invoice and the PPTX deck (incl. reorder + expiry slides), and finally
// runs the scheduler end-to-end so the auto-sent weekly deck is exercised too.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statSync, writeFileSync, mkdirSync } from "node:fs";

process.env.DB_PATH = join(tmpdir(), `store-docs-${process.pid}.db`);
process.env.ARTIFACTS_DIR = join(tmpdir(), `artifacts-${process.pid}`);

const { seed } = await import("../src/db/seed.ts");
const products = await import("../src/repo/products.ts");
const bills = await import("../src/repo/bills.ts");
const analytics = await import("../src/repo/analytics.ts");
const batches = await import("../src/repo/batches.ts");
const prefs = await import("../src/repo/prefs.ts");
const schedules = await import("../src/repo/schedules.ts");
const updates = await import("../src/repo/updates.ts");
const { generateInvoicePdf } = await import("../src/docs/invoice.ts");
const { generateDeckPptx } = await import("../src/docs/deck.ts");
const { shopInfo } = await import("../src/lib/shop.ts");
const { runJob, khataDigest } = await import("../src/jobs.ts");

seed();
const CHAT = "docs-chat";

// A 1x1 PNG stands in for the owner's logo.
const logoDir = join(process.env.ARTIFACTS_DIR!, CHAT);
mkdirSync(logoDir, { recursive: true });
const logo = join(logoDir, "logo.png");
writeFileSync(logo, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));

// Branding lives in prefs, exactly as the agent's set_preference tool would write it.
for (const [k, v] of Object.entries({
  shop_name: "Sharma General Store",
  gstin: "29ABCDE1234F1Z5",
  shop_address: "12 MG Road, Bengaluru, KA - 560001",
  shop_phone: "+91-98800-11223",
  shop_state: "Karnataka (29)",
  brand_color: "#0F766E",
  invoice_template: "modern",
  invoice_footer: "Home delivery on orders above ₹500 · UPI: sharma@okaxis",
  shop_logo: logo,
})) prefs.setPref(CHAT, k, v);

const shop = shopInfo(CHAT);
console.log("Branding:", shop.name, shop.template, "#" + shop.brand_color, "logo:", !!shop.logo_path);

// Build a mixed bill: loose sugar (5%), atta (5%), maggi (18%), butter (12%).
const d = bills.createDraft(CHAT);
bills.addItem(d.id, products.search("sugar loose", 1)[0].id, 2);
bills.addItem(d.id, products.search("aashirvaad atta", 1)[0].id, 1);
bills.addItem(d.id, products.search("maggi", 1)[0].id, 4);
bills.addItem(d.id, products.search("amul butter", 1)[0].id, 1);
bills.setMeta(d.id, { payment_mode: "upi", payment_ref: "UPI/4432", customer: "Ramesh" });
const { bill, items } = bills.finalize(d.id, `finalize-bill-${d.id}`);
console.log("Finalized bill total:", bill.total, "items:", items.length);

const pdf = await generateInvoicePdf(bill, items, shop, CHAT);
console.log("PDF:", pdf, statSync(pdf).size, "bytes");

const today = new Date().toISOString().slice(0, 10);
const report = analytics.salesReport("2000-01-01", today);
const extras = { reorder: analytics.reorderSuggestions(14, 14), expiring: batches.expiringSoon(30) };
const pptx = await generateDeckPptx(report, shop, CHAT, extras);
console.log("PPTX:", pptx, statSync(pptx).size, "bytes");
console.log("Report:", JSON.stringify({ bills: report.bill_count, sales: report.gross_sales, gst: report.tax_collected, slabs: report.by_slab.length, top: report.top_items.length }));
console.log("Deck extras:", JSON.stringify({ reorder: extras.reorder.length, expiring: extras.expiring.length }));

// Scheduler path: the weekly deck job must queue both a file and a notice.
const job = await runJob({ id: -1, chat_id: CHAT, kind: "weekly_deck", weekday: 1, hour: 9, minute: 0, enabled: 1, last_run: null });
const queuedFiles = updates.takeOutbox(CHAT);
const queuedNotices = schedules.takeNotices(CHAT);
console.log("Scheduled job:", job.summary, "| queued files:", queuedFiles.length, "| notices:", queuedNotices.length);
console.log("Notice:", queuedNotices[queuedNotices.length - 1]?.text.split("\n")[0]);

const khataJob = await runJob({ id: -2, chat_id: CHAT, kind: "khata_reminder", weekday: null, hour: 9, minute: 0, enabled: 1, last_run: null });
console.log("Khata digest:", khataJob.summary, "|", khataDigest(CHAT).text.split("\n")[0]);
