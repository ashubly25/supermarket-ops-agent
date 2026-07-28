/**
 * Local smoke REPL — drive the agent WITHOUT Telegram.
 * Needs AI_GATEWAY_API_KEY set. Usage:
 *   npm run smoke                       # interactive REPL
 *   npm run smoke -- "how much sugar is left?"   # one-shot
 * Uses a fixed chat id "local-smoke" so a session/preferences persist between runs.
 */
import "./db/index.js";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { runAgent, resetSession } from "./agent.js";
import { takeOutbox, markSent } from "./repo/updates.js";
import { requireEnv } from "./config.js";

const CHAT = "local-smoke";
requireEnv("AI_GATEWAY_API_KEY");

async function turn(msg: string) {
  if (msg.trim() === "/new") {
    resetSession(CHAT);
    console.log("↻ session reset (store data & prefs kept)\n");
    return;
  }
  const { text } = await runAgent(CHAT, msg);
  console.log("\n🛒 " + text + "\n");
  for (const f of takeOutbox(CHAT)) {
    console.log(`📎 generated: ${f.path} (${f.caption})`);
    markSent(f.id);
  }
}

const oneShot = process.argv.slice(2).join(" ").trim();
if (oneShot) {
  await turn(oneShot);
  process.exit(0);
}

const rl = createInterface({ input: stdin, output: stdout });
console.log('Local agent REPL. Type a message, "/new" to reset session, Ctrl-C to quit.\n');
for (;;) {
  const msg = (await rl.question("you › ")).trim();
  if (!msg) continue;
  try {
    await turn(msg);
  } catch (e) {
    console.error("error:", (e as Error).message, "\n");
  }
}
