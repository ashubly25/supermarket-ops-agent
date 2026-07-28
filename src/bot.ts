import { Bot, InputFile } from "grammy";
import { requireEnv } from "./config.js";
import { runAgent, resetSession } from "./agent.js";
import { toPlainText } from "./lib/plain.js";
import { markProcessed, takeOutbox, markSent } from "./repo/updates.js";
import { takeNotices, markNoticeSent, chatsWithPending } from "./repo/schedules.js";

export function buildBot(): Bot {
  const token = requireEnv("TELEGRAM_BOT_TOKEN");
  const bot = new Bot(token);

  bot.command("start", (ctx) =>
    ctx.reply(
      "Namaste! I run your store from this chat. Try:\n" +
        "• 50 packets of Maggi came in, cost ₹12 MRP ₹14\n" +
        "• make a bill: 2kg sugar, 1 aashirvaad atta, 4 maggi, UPI\n" +
        "• how much sugar is left?\n" +
        "• what's running out?\n" +
        "• put ₹500 on Ramesh's credit\n" +
        "• today's sales / send me a PDF invoice / weekly analysis deck\n" +
        "• what's expiring? / what should I order? / who owes me?\n" +
        "• send me the deck every Monday 9am\n\n" +
        "/new starts a fresh conversation (your store data & preferences stay)."
    )
  );

  bot.command("new", (ctx) => {
    resetSession(String(ctx.chat.id));
    return ctx.reply("Fresh chat. Store data and your preferences are remembered.");
  });

  bot.on("message:text", async (ctx) => {
    const updateId = ctx.update.update_id;
    // Ingress idempotency: drop Telegram redeliveries.
    if (!markProcessed(updateId)) return;

    const chatId = String(ctx.chat.id);
    const text = ctx.message.text;
    if (text.startsWith("/")) return; // other slash commands handled above

    await handleTurn(bot, ctx, chatId, text);
  });

  bot.catch((err) => console.error("bot error:", err.error));
  return bot;
}

async function handleTurn(bot: Bot, ctx: any, chatId: string, text: string): Promise<void> {
  await ctx.replyWithChatAction("typing").catch(() => {});
  try {
    const { text: reply } = await runAgent(chatId, text);
    // Telegram gets no parse_mode, so markdown would render literally. Normalise at the exit.
    await ctx.reply(toPlainText(reply), { link_preview_options: { is_disabled: true } });
    await flushChat(bot, chatId);
  } catch (e) {
    console.error("agent error:", e);
    // A rate-limited turn is worth retrying verbatim; anything else isn't.
    const msg = String((e as Error)?.message ?? e);
    const rateLimited = /rate.?limit|429|quota/i.test(msg);
    await ctx.reply(
      rateLimited
        ? "⏳ The model is rate-limited right now. Send that again in a few seconds — nothing was saved."
        : "⚠️ Something went wrong handling that. Please try again."
    );
  }
}

/** Send anything queued for a chat: scheduler notices, then generated files. */
export async function flushChat(bot: Bot, chatId: string): Promise<void> {
  for (const n of takeNotices(chatId)) {
    try {
      await bot.api.sendMessage(chatId, n.text);
      markNoticeSent(n.id);
    } catch (e) {
      console.error("failed to send notice", n.id, e);
    }
  }
  for (const f of takeOutbox(chatId)) {
    try {
      await bot.api.sendDocument(chatId, new InputFile(f.path), { caption: f.caption });
      markSent(f.id);
    } catch (e) {
      console.error("failed to send document", f.path, e);
    }
  }
}

/** Push whatever the scheduler queued while nobody was chatting. */
export async function flushPending(bot: Bot): Promise<void> {
  for (const chatId of chatsWithPending()) await flushChat(bot, chatId);
}
