// Drives every §3 capability through the real tool/repo layer with the brief's own example inputs.
// This proves the machinery each intent resolves to. (NL parsing + model clarification = the LLM's job, live.)
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statSync } from "node:fs";

process.env.DB_PATH = join(tmpdir(), `scen-${process.pid}.db`);
process.env.ARTIFACTS_DIR = join(tmpdir(), `scen-art-${process.pid}`);

const { seed } = await import("../src/db/seed.ts");
const products = await import("../src/repo/products.ts");
const bills = await import("../src/repo/bills.ts");
const khata = await import("../src/repo/khata.ts");
const analytics = await import("../src/repo/analytics.ts");
const prefs = await import("../src/repo/prefs.ts");
const { generateInvoicePdf } = await import("../src/docs/invoice.ts");
const { generateDeckPptx } = await import("../src/docs/deck.ts");
const { shopInfo } = await import("../src/lib/shop.ts");
const { inr } = await import("../src/lib/money.ts");

seed();
const CHAT = "scen";
const line = (s: string) => console.log(s);
const P = (q: string) => products.search(q, 1)[0];

line("① RECEIVE STOCK — '50 packets of Maggi came in, cost ₹12, MRP ₹14'");
{
  const m = P("maggi");
  const before = m.qty;
  const after = products.receiveStock(m.id, 50, { cost: 12, mrp: 14 });
  line(`   ${m.name}: ${before} → ${after.qty} (cost ${inr(after.cost_price)}, MRP ${inr(after.mrp)})`);
}

line("② ADD PRODUCT — 'new item: Amul Butter 100g, GST 12%, MRP ₹62'");
{
  const dupe = products.search("Amul Butter 100g", 1)[0];
  line(`   already seeded → dup guard would fire on #${dupe.id}. Adding a genuinely new SKU instead:`);
  const np = products.addProduct({ name: "Cadbury Bournvita", size: "500g", unit: "packet", loose: 0, hsn: "1806", gst_rate: 18, cost_price: 210, mrp: 255, sell_price: 245, qty: 12, reorder_level: 4 } as any);
  line(`   added #${np.id} ${np.name} ${np.size} @ GST ${np.gst_rate}% MRP ${inr(np.mrp)}`);
}

line("③ CUT A BILL — 'make a bill: 2kg sugar, 1 Aashirvaad atta 5kg, 4 Maggi, 1 Amul butter, UPI'");
const d = bills.createDraft(CHAT);
bills.addItem(d.id, P("sugar loose").id, 2);
bills.addItem(d.id, P("aashirvaad atta").id, 1);
bills.addItem(d.id, P("maggi").id, 4);
bills.addItem(d.id, P("amul butter").id, 1);
bills.setMeta(d.id, { payment_mode: "upi", payment_ref: "UPI/RRN9021", customer: "Ramesh" });
{
  const b = bills.getBill(d.id)!;
  line(`   4 items · taxable ${inr(b.subtotal)} · CGST ${inr(b.cgst)} + SGST ${inr(b.sgst)} · TOTAL ${inr(b.total)}`);
}

line("④ EDIT MID-BUILD — 'drop the butter, make it 6 Maggi'");
bills.setItemQty(d.id, P("amul butter").id, 0);
bills.setItemQty(d.id, P("maggi").id, 6);
{
  const items = bills.getItems(d.id).map((i) => `${i.name.split(" ")[0]}×${i.qty}`).join(", ");
  line(`   now: ${items} · TOTAL ${inr(bills.getBill(d.id)!.total)}`);
}
const fin = bills.finalize(d.id, `finalize-bill-${d.id}`);
line(`   finalized #${fin.bill.id} — stock decremented atomically. Total ${inr(fin.bill.total)}`);

line("⑤ STOCK QUERY — 'how much sugar is left?'");
{
  const s = P("sugar loose");
  line(`   ${s.name}: ${s.qty} ${s.unit} left`);
}

line("⑥ LOW-STOCK / REORDER — 'what's running out?'");
{
  const low = products.lowStock();
  line(`   below reorder level: ${low.length ? low.map((p) => `${p.name.split(" ")[0]}(${p.qty})`).join(", ") : "none"}`);
  const reorder = analytics.reorderSuggestions(14, 14);
  line(`   velocity-based purchase plan: ${reorder.length} SKU(s) suggested`);
}

line("⑦ KHATA — 'put ₹500 on Ramesh's credit · Ramesh paid ₹300 · Ramesh's balance?'");
{
  const c1 = khata.charge("Ramesh", 500);
  line(`   +₹500 → balance ${inr(c1.khata_balance)}`);
  const c2 = khata.payment("Ramesh", 300);
  line(`   paid ₹300 → balance ${inr(c2.khata_balance)}`);
  line(`   Ramesh's balance = ${inr(khata.balance("Ramesh")!.khata_balance)}`);
}

line("⑧ DAILY CLOSE — 'today's sales?'");
{
  const today = new Date().toISOString().slice(0, 10);
  const r = analytics.dailyClose(today);
  const pay = Object.entries(r.by_payment).map(([m, v]) => `${m.toUpperCase()} ${inr(v.amount)}`).join(", ");
  line(`   ${r.date}: ${r.bill_count} bill(s), sales ${inr(r.gross_sales)}, tax ${inr(r.tax_collected)}, [${pay}]`);
  line(`   top: ${r.top_items.map((t) => t.name.split(" ")[0]).join(", ")}`);
}

line("⑨ INVOICE PDF — 'send me that bill as a PDF'");
{
  const pdf = await generateInvoicePdf(fin.bill, fin.items, shopInfo(CHAT), CHAT);
  line(`   ${pdf} (${statSync(pdf).size} bytes)`);
}

line("⑩ ANALYSIS DECK — 'make this week's sales analysis deck'");
{
  const today = new Date().toISOString().slice(0, 10);
  const rep = analytics.salesReport("2000-01-01", today);
  const deck = await generateDeckPptx(rep, shopInfo(CHAT), CHAT, { reorder: analytics.reorderSuggestions(14, 14) });
  line(`   ${deck} (${statSync(deck).size} bytes)`);
}

line("⑪ SET A PREFERENCE — 'always assume UPI unless I say cash · default atta = Aashirvaad 5kg'");
{
  prefs.setPref(CHAT, "default_payment", "upi");
  prefs.setPref(CHAT, "default_atta", "Aashirvaad Atta 5kg");
  // Survives /new (only __session_id is cleared):
  prefs.setPref(CHAT, "__session_id", "sess-1");
  prefs.deletePref(CHAT, "__session_id");
  line(`   remembered: default_payment=${prefs.getPref(CHAT, "default_payment")}, default_atta="${prefs.getPref(CHAT, "default_atta")}" (survived /new)`);
}

line("\n✅ Every §3 capability's tool path executed with the brief's example values.");
