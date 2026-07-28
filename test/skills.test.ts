import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.DB_PATH = join(tmpdir(), `skills-test-${process.pid}.db`);

const { SKILLS, skillIndex } = await import("../src/lib/skills.js");
const { inventoryTools } = await import("../src/tools/inventory.js");
const { makeBillingTools } = await import("../src/tools/billing.js");
const { makeKhataTools } = await import("../src/tools/khata.js");
const { analyticsTools } = await import("../src/tools/analytics.js");
const { makeDocumentTools } = await import("../src/tools/documents.js");
const { makePrefTools } = await import("../src/tools/prefs.js");
const { makeScheduleTools } = await import("../src/tools/schedules.js");

const ctx = { chatId: "skills-test" };
const GROUPS: Record<string, { name: string }[]> = {
  inventory: inventoryTools,
  billing: makeBillingTools(ctx),
  khata: makeKhataTools(ctx),
  analytics: analyticsTools,
  documents: makeDocumentTools(ctx),
  memory: makePrefTools(ctx),
  scheduling: makeScheduleTools(ctx),
};

test("every tool group has a skill, and every skill has a group", () => {
  const skillNames = SKILLS.map((s) => s.name).sort();
  assert.deepEqual(Object.keys(GROUPS).sort(), skillNames, "a group without a skill can never be unlocked");
});

// Tools are gated behind their skill, so an undocumented tool is unreachable in practice:
// the model reads the playbook and acts on what it says.
test("every tool is documented in the skill that unlocks it", () => {
  const undocumented: string[] = [];
  for (const [skill, tools] of Object.entries(GROUPS)) {
    const body = SKILLS.find((s) => s.name === skill)!.body;
    for (const t of tools) if (!body.includes(t.name)) undocumented.push(`${skill}/${t.name}`);
  }
  assert.deepEqual(undocumented, [], `tools missing from their SKILL.md: ${undocumented.join(", ")}`);
});

test("the documents skill specifies what each artifact must contain", () => {
  const body = SKILLS.find((s) => s.name === "documents")!.body;
  // The invoice is a legal document — these are the parts a GST invoice cannot omit.
  for (const required of ["GSTIN", "HSN", "CGST", "SGST", "words", "slab"])
    assert.ok(new RegExp(required, "i").test(body), `invoice spec must mention ${required}`);
  // The deck's required analysis, per the brief.
  for (const required of ["top selling", "stock health", "GST collected", "chart"])
    assert.ok(new RegExp(required, "i").test(body), `deck spec must mention ${required}`);
  assert.ok(/native PowerPoint chart|not images/i.test(body), "must state charts are real, not pictures");
});

test("the index advertises each skill's tools so a hidden schema is never mistaken for a missing capability", () => {
  const gated = Object.fromEntries(Object.entries(GROUPS).map(([s, t]) => [s, t.map((x) => x.name)]));
  const idx = skillIndex(gated);
  assert.ok(idx.includes("generate_invoice_pdf"), "the PDF tool must be advertised even while gated");
  assert.ok(idx.includes("generate_analysis_deck"), "the deck tool must be advertised even while gated");
  for (const s of SKILLS) assert.ok(idx.includes(s.name), `${s.name} missing from the index`);
});
