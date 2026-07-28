import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllowed, accessLabel, ownerChatIds } from "../src/lib/access.js";

// The store's catalogue, stock and customers are global, so "who may talk to the bot" is
// the only thing standing between a stranger and the owner's books.

test("no allowlist means open — a fresh deploy is never mysteriously mute", () => {
  const none = new Set<string>();
  assert.equal(isAllowed("249716597", undefined, none), true);
  assert.equal(isAllowed("999999999", undefined, none), true);
  assert.match(accessLabel(none), /OPEN/);
});

test("an allowlist admits only its members", () => {
  const ids = new Set(["249716597", "111"]);
  assert.equal(isAllowed("249716597", undefined, ids), true);
  assert.equal(isAllowed("111", undefined, ids), true);
  assert.equal(isAllowed("999999999", undefined, ids), false, "a stranger must not operate the store");
  assert.match(accessLabel(ids), /restricted to 2/);
});

test("numeric chat ids are compared as strings, not by identity", () => {
  const ids = new Set(["249716597"]);
  assert.equal(isAllowed(String(249716597), undefined, ids), true);
  // Telegram group ids are negative; they must not be coerced into a match.
  assert.equal(isAllowed("-249716597", undefined, ids), false);
});

test("an @username entry matches that user's handle, case-insensitively", () => {
  const ids = new Set(["@darthvader2"]);
  assert.equal(isAllowed("249716597", "darthvader2", ids), true, "handle without @ from Telegram");
  assert.equal(isAllowed("249716597", "DarthVader2", ids), true, "Telegram handles are case-insensitive");
  assert.equal(isAllowed("999999999", "someoneelse", ids), false);
  // A user with no username set cannot match an @entry — this is why the numeric id is safer.
  assert.equal(isAllowed("249716597", undefined, ids), false);
});

test("id and handle entries coexist, so either form admits the owner", () => {
  const ids = new Set(["249716597", "@darthvader2"]);
  assert.equal(isAllowed("249716597", undefined, ids), true, "id matches even if the handle changed");
  assert.equal(isAllowed("555", "darthvader2", ids), true, "handle matches even from another chat");
});

test("whitespace and trailing commas in the env value don't lock the owner out", () => {
  const prev = process.env.OWNER_CHAT_IDS;
  process.env.OWNER_CHAT_IDS = " 249716597 , @darthvader2 ,";
  const ids = ownerChatIds();
  assert.deepEqual([...ids].sort(), ["249716597", "@darthvader2"]);
  assert.equal(isAllowed("249716597", undefined, ids), true);
  process.env.OWNER_CHAT_IDS = prev;
});
