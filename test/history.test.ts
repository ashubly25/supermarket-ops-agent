import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.DB_PATH = join(tmpdir(), `history-test-${process.pid}.db`);

const { setHistory, getHistory } = await import("../src/repo/history.js");
import type { ModelMessage } from "ai";

const CHAT = "hist";
const SKILL_BODY = "x".repeat(3000); // a realistic SKILL.md payload

test("read_skill exchanges are not persisted, but the rest of the turn is", () => {
  const msgs: ModelMessage[] = [
    { role: "user", content: "make a bill: 4 maggi" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Let me check the playbook." },
        { type: "tool-call", toolCallId: "c1", toolName: "read_skill", input: { name: "billing" } },
      ],
    } as any,
    {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "c1", toolName: "read_skill", output: SKILL_BODY }],
    } as any,
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "c2", toolName: "add_bill_item", input: { qty: 4 } }],
    } as any,
    {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "c2", toolName: "add_bill_item", output: "added" }],
    } as any,
    { role: "assistant", content: [{ type: "text", text: "Bill #1 draft: 4 Maggi ₹56." }] } as any,
  ];

  setHistory(CHAT, msgs);
  const stored = getHistory(CHAT);
  const json = JSON.stringify(stored);

  assert.ok(!json.includes(SKILL_BODY), "the skill body must not be carried in history");
  assert.ok(!json.includes("read_skill"), "neither the call nor its result should survive");

  // The real work of the turn is still there.
  assert.ok(json.includes("add_bill_item"));
  assert.ok(json.includes("Bill #1 draft: 4 Maggi ₹56."));
  assert.ok(json.includes("Let me check the playbook."), "sibling text parts must survive");

  // No orphans: every tool-result has its tool-call and vice versa — an orphan is a hard API error.
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const m of stored) {
    if (!Array.isArray(m.content)) continue;
    for (const p of m.content as any[]) {
      if (p.type === "tool-call") calls.add(p.toolCallId);
      if (p.type === "tool-result") results.add(p.toolCallId);
    }
  }
  assert.deepEqual([...calls].sort(), [...results].sort(), "calls and results must pair exactly");
});

test("an assistant message that was only a skill read disappears entirely", () => {
  setHistory(CHAT, [
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "s1", toolName: "read_skill", input: {} }] } as any,
    { role: "tool", content: [{ type: "tool-result", toolCallId: "s1", toolName: "read_skill", output: SKILL_BODY }] } as any,
    { role: "assistant", content: [{ type: "text", text: "Namaste!" }] } as any,
  ]);
  const stored = getHistory(CHAT);
  assert.equal(stored.length, 2, "only the user turn and the reply remain");
  assert.equal(stored[0].role, "user");
});

test("the window still starts on a user turn after stripping", () => {
  setHistory(CHAT, [
    { role: "assistant", content: [{ type: "text", text: "orphan" }] } as any,
    { role: "user", content: "real start" },
    { role: "assistant", content: [{ type: "text", text: "ok" }] } as any,
  ]);
  assert.equal(getHistory(CHAT)[0].role, "user");
});
