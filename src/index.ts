import "./db/index.js"; // runs migrations on import
import { buildBot, flushPending } from "./bot.js";
import { tick } from "./jobs.js";

const bot = buildBot();
console.log("Supermarket Ops Agent starting (long-poll)…");

// Scheduler: one tick a minute. Jobs claim their slot atomically, so a restart
// (or a slow job) can never double-send a deck or a reminder.
const TICK_MS = 60_000;
const timer = setInterval(async () => {
  try {
    const ran = await tick();
    if (ran.length) console.log("scheduler ran:", ran.map((r) => `${r.kind}(${r.summary})`).join(", "));
    await flushPending(bot);
  } catch (e) {
    console.error("scheduler tick failed:", e);
  }
}, TICK_MS);

bot.start({
  onStart: async (me) => {
    console.log(`Bot online as @${me.username}`);
    // Deliver anything the scheduler queued while the bot was down.
    await flushPending(bot).catch((e) => console.error("startup flush failed:", e));
  },
});

const shutdown = () => {
  clearInterval(timer);
  bot.stop();
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
