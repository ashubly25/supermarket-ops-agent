import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(tmpdir(), `store-test-${process.pid}-agent.db`);

const { MockLanguageModelV3 } = await import("ai/test");
const { seed } = await import("../src/db/seed.ts");
const { runAgent, resetSession } = await import("../src/agent.ts");
const history = await import("../src/repo/history.ts");
const prefs = await import("../src/repo/prefs.ts");

seed();

const CHAT = "agent-test";

/** Two-step model: call find_product on the first step, then answer. */
function scriptedModel(seen: { toolResult?: string }) {
  let step = 0;
  return new MockLanguageModelV3({
    doGenerate: async (opts: any) => {
      step++;
      if (step === 1) {
        return {
          finishReason: "tool-calls" as const,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          content: [
            {
              type: "tool-call" as const,
              toolCallId: "c1",
              toolName: "find_product",
              input: JSON.stringify({ query: "sugar" }),
            },
          ],
          warnings: [],
        };
      }
      // Capture what the tool handed back to the model.
      const last = opts.prompt.at(-1);
      const part = Array.isArray(last?.content) ? last.content[0] : undefined;
      seen.toolResult = JSON.stringify(part?.output ?? part);
      return {
        finishReason: "stop" as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        content: [{ type: "text" as const, text: "Sugar is in stock." }],
        warnings: [],
      };
    },
  });
}

test("agent loop: tool call executes against the DB and the text comes back", async () => {
  const seen: { toolResult?: string } = {};
  const { text, steps } = await runAgent(CHAT, "how much sugar?", scriptedModel(seen) as any);
  assert.equal(text, "Sugar is in stock.");
  assert.equal(steps, 2, "one tool step + one answer step");
  assert.match(seen.toolResult ?? "", /sugar/i, "find_product result must reach the model");
  assert.match(seen.toolResult ?? "", /GST/, "tool text carries real catalogue data, not a stub");
});

test("history persists across turns and /new clears only it", async () => {
  prefs.setPref(CHAT, "default_payment", "upi");
  assert.ok(history.getHistory(CHAT).length > 0, "prior turn was stored");

  const seen: { toolResult?: string } = {};
  await runAgent(CHAT, "and rice?", scriptedModel(seen) as any);
  assert.ok(history.getHistory(CHAT).length >= 4, "second turn appends to the same thread");

  resetSession(CHAT);
  assert.equal(history.getHistory(CHAT).length, 0, "session cleared");
  assert.equal(prefs.getPref(CHAT, "default_payment"), "upi", "durable pref must remain");
});
