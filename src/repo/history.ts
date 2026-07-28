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

/**
 * Drop `read_skill` calls and their payloads before persisting.
 *
 * A skill body is 2–4k characters. Left in the thread it is re-sent on every later turn of
 * the conversation, so a single "read billing" keeps costing tokens for the rest of the day —
 * and it is the one message we can always reproduce, because the model can just read the
 * skill again. Both halves go: an orphaned tool call, or a result with no call, is a hard API
 * error, so the call parts and their results are removed together.
 */
function stripSkillReads(msgs: ModelMessage[]): ModelMessage[] {
  const skillCallIds = new Set<string>();
  for (const m of msgs) {
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content as any[]) {
      if (part?.type === "tool-call" && part.toolName === "read_skill") skillCallIds.add(part.toolCallId);
    }
  }
  if (skillCallIds.size === 0) return msgs;

  const out: ModelMessage[] = [];
  for (const m of msgs) {
    if (!Array.isArray(m.content)) {
      out.push(m);
      continue;
    }
    const kept = (m.content as any[]).filter(
      (p) => !((p?.type === "tool-call" || p?.type === "tool-result") && skillCallIds.has(p.toolCallId))
    );
    if (kept.length > 0) out.push({ ...m, content: kept } as ModelMessage);
  }
  return out;
}

export function setHistory(chatId: string, msgs: ModelMessage[]): void {
  setPref(chatId, HISTORY_KEY, JSON.stringify(trim(stripSkillReads(msgs))));
}

export function clearHistory(chatId: string): void {
  deletePref(chatId, HISTORY_KEY);
}
