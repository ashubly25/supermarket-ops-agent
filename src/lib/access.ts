/**
 * Who may operate the store.
 *
 * The catalogue, stock, batches and customers are deliberately GLOBAL — one shop, one
 * set of books, however many devices the owner chats from. The flip side is that any
 * Telegram user who finds the bot can move that stock: bill it, receive it, charge a
 * khata. There is no per-chat sandbox to fall back on.
 *
 * So access is an explicit choice:
 *   OWNER_CHAT_IDS unset      → open. Anyone can drive it. Correct while reviewers are
 *                               being handed the handle, and the default so a fresh
 *                               deploy is never mysteriously mute.
 *   OWNER_CHAT_IDS="123,456"  → only those chats. Everyone else is told, politely, that
 *                               this shop's books aren't theirs.
 *
 * Send /whoami (or read the logs) to find your chat id.
 */
const parse = (raw: string | undefined): Set<string> =>
  new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );

export function ownerChatIds(): Set<string> {
  return parse(process.env.OWNER_CHAT_IDS);
}

/** True when this chat may operate the store. Open when no allowlist is configured. */
export function isAllowed(chatId: string, ids: Set<string> = ownerChatIds()): boolean {
  return ids.size === 0 || ids.has(String(chatId));
}

/** One line at boot so an operator can see which mode they are in. */
export function accessLabel(ids: Set<string> = ownerChatIds()): string {
  return ids.size === 0
    ? "access: OPEN (anyone who finds the bot can operate this store — set OWNER_CHAT_IDS to restrict)"
    : `access: restricted to ${ids.size} chat id(s)`;
}
