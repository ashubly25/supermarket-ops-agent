import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllowed, accessLabel } from "../src/lib/access.js";

// The store's catalogue, stock and customers are global, so "who may talk to the bot" is
// the only thing standing between a stranger and the owner's books.

test("no allowlist means open — a fresh deploy is never mysteriously mute", () => {
  const none = new Set<string>();
  assert.equal(isAllowed("249716597", none), true);
  assert.equal(isAllowed("999999999", none), true);
  assert.match(accessLabel(none), /OPEN/);
});

test("an allowlist admits only its members", () => {
  const ids = new Set(["249716597", "111"]);
  assert.equal(isAllowed("249716597", ids), true);
  assert.equal(isAllowed("111", ids), true);
  assert.equal(isAllowed("999999999", ids), false, "a stranger must not operate the store");
  assert.match(accessLabel(ids), /restricted to 2/);
});

test("numeric chat ids are compared as strings, not by identity", () => {
  const ids = new Set(["249716597"]);
  assert.equal(isAllowed(String(249716597), ids), true);
  // Telegram group ids are negative; they must not be coerced into a match.
  assert.equal(isAllowed("-249716597", ids), false);
});

test("whitespace and trailing commas in the env value don't lock the owner out", async () => {
  const prev = process.env.OWNER_CHAT_IDS;
  process.env.OWNER_CHAT_IDS = " 249716597 , 111 ,";
  const { ownerChatIds } = await import("../src/lib/access.js");
  const ids = ownerChatIds();
  assert.deepEqual([...ids].sort(), ["111", "249716597"]);
  assert.equal(isAllowed("249716597", ids), true);
  process.env.OWNER_CHAT_IDS = prev;
});
