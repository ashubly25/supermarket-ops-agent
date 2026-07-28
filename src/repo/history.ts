import type { ModelMessage } from "ai";
import { getPref, setPref, deletePref } from "./prefs.js";

const HISTORY_KEY = "__history";
const MAX_MESSAGES = 40;

/**
 * The AI SDK is stateless, so the conversation lives here: one JSON blob per
 * chat in `prefs`, alongside (but namespaced away from) the owner's durable
 * preferences. `/new` clears this and nothing else.
 */
export function getHistory(chatId: string): ModelMessage[] {
  const raw = getPref(chatId, HISTORY_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ModelMessage[]) : [];
  } catch {
    return [];
  }
}

/**
 * Trim to the last MAX_MESSAGES, then keep dropping from the front until the
 * window starts on a user turn — a tool result whose tool call got trimmed away
 * is a hard API error.
 */
function trim(msgs: ModelMessage[]): ModelMessage[] {
  let out = msgs.slice(-MAX_MESSAGES);
  while (out.length > 0 && out[0].role !== "user") out = out.slice(1);
  return out;
}

export function setHistory(chatId: string, msgs: ModelMessage[]): void {
  setPref(chatId, HISTORY_KEY, JSON.stringify(trim(msgs)));
}

export function clearHistory(chatId: string): void {
  deletePref(chatId, HISTORY_KEY);
}
