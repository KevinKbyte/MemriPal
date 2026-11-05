// Covers: MEM-140
// Requirement: emojiFor keeps every MEM-100 keyword-table pick (landmark_emoji.test.mjs is unchanged); only when
// the table finds nothing does it search the emoji corpus by BM25 over the name, category and tag values, and
// only when that also finds nothing does it return the U+1F4CD pushpin.
// Contract (RED; GREEN extends static/landmark_emoji.js emojiFor): table (category > tags > name) first, then
// BM25 (static/emoji_bm25.js) over name + category + tag values, then EMOJI_DEFAULT. Never throws.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { emojiFor } from "./landmark_emoji.js";

const PIZZA = "\u{1F355}";
const PUSHPIN = "\u{1F4CD}";

// Covers: MEM-140
// Requirement: a table miss falls through to the corpus search, then to the pushpin.
describe("MEM-140 emojiFor BM25 fallback", () => {
  test("a name the table misses gets the corpus pick", () => {
    assert.equal(emojiFor({ name: "Pizza Regina" }), PIZZA);
  });

  test("category and tag values feed the corpus search", () => {
    assert.equal(emojiFor({ name: "Xyzzy", category: "pizza" }), PIZZA);
    assert.equal(emojiFor({ name: "Xyzzy", tags: { cuisine: "pizza" } }), PIZZA);
  });

  test("the table still wins over the corpus", () => {
    assert.equal(emojiFor({ name: "Pizza Regina", category: "cafe" }), "\u{2615}");
  });

  test("nonsense -> pushpin", () => {
    assert.equal(emojiFor({ name: "Zzqx Vlorp" }), PUSHPIN);
  });
});
