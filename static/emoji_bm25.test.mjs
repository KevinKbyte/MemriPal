// Covers: MEM-144
// Requirement: a landmark name the keyword table misses is matched to the emoji corpus by Okapi BM25 keyword
// search, so "Flour Bakery + Cafe" gets a bakery/cafe glyph and "Kendall Square T station" a train, offline and
// deterministically; a query with no matching word gets no pick (the caller falls back to the pushpin), and a
// bad query never throws.
// Contract (RED; GREEN adds static/emoji_bm25.js, pure):
//   export function createEmojiIndex(corpus) -> { search(query, k = 5) -> Array<{ emoji, score }> }
//     Document = tokens of name + keywords; tokens = lower-case [a-z0-9]+ runs. Okapi BM25, k1 = 1.2, b = 0.75,
//     idf = ln(1 + (N - n + 0.5) / (n + 0.5)) (always > 0). Only rows with score > 0; score desc, ties in corpus
//     order; at most k. Non-string, empty or token-free query -> []. Never throws.
//   export function bestEmoji(query) -> string | null: the top hit over EMOJI_CORPUS, or null.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

const mod = await import("./emoji_bm25.js").catch((err) => ({ __missing: String(err) }));

/** @param {string} name */
function fn(name) {
  assert.equal(typeof mod[name], "function", `static/emoji_bm25.js exports ${name} (${mod.__missing ?? "not exported"})`);
  return mod[name];
}
const index = (corpus) => fn("createEmojiIndex")(corpus);
const best = (q) => fn("bestEmoji")(q);

const STATION = ["\u{1F689}", "\u{1F686}", "\u{1F687}"];
const BAKERY_CAFE = ["\u{2615}", "\u{1F950}", "\u{1F35E}", "\u{1F370}", "\u{1F9C1}"];

// Covers: MEM-144
// Requirement: BM25 scoring and ordering follow the stated formula and parameters.
describe("MEM-144 createEmojiIndex search", () => {
  test("score matches Okapi BM25 with k1 1.2, b 0.75 over name + keywords", () => {
    const idx = index([
      { emoji: "A", name: "Red apple", keywords: ["fruit"] },
      { emoji: "B", name: "green", keywords: ["fruit", "leaf", "plant"] },
    ]);
    const hits = idx.search("APPLE");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].emoji, "A");
    const idf = Math.log(1 + (2 - 1 + 0.5) / (1 + 0.5));
    const want = idf * (1 * 2.2) / (1 + 1.2 * (1 - 0.75 + 0.75 * (3 / 3.5)));
    assert.ok(Math.abs(hits[0].score - want) < 1e-9, `score ${hits[0].score} want ${want}`);
  });

  test("a rare term outweighs a common term (IDF); a term in every row still scores > 0", () => {
    const idx = index([
      { emoji: "A", name: "alpha", keywords: ["common", "rare"] },
      { emoji: "B", name: "beta", keywords: ["common", "other"] },
      { emoji: "C", name: "gamma", keywords: ["common", "other"] },
    ]);
    const scoreOfA = (q) => idx.search(q).find((h) => h.emoji === "A")?.score;
    assert.ok(scoreOfA("rare") > scoreOfA("common"), "rare beats common for the same row");
    assert.equal(idx.search("common rare")[0].emoji, "A");
    const all = idx.search("common");
    assert.equal(all.length, 3);
    for (const h of all) assert.ok(Number.isFinite(h.score) && h.score > 0, `finite positive score ${h.score}`);
  });

  test("score descending, ties in corpus order, at most k (default 5)", () => {
    const rows = ["1", "2", "3", "4", "5", "6", "7"].map((emoji) => ({ emoji, name: "cat", keywords: [] }));
    rows.push({ emoji: "short", name: "cat", keywords: [] });
    rows.unshift({ emoji: "long", name: "cat dog bird fish", keywords: ["cow", "pig"] });
    const idx = index(rows);
    assert.deepEqual(idx.search("cat").map((h) => h.emoji), ["1", "2", "3", "4", "5"]);
    assert.deepEqual(idx.search("cat", 1).map((h) => h.emoji), ["1"]);
    const many = idx.search("cat", 20);
    assert.equal(many.length, 9);
    assert.equal(many.at(-1).emoji, "long", "the longer document scores lowest");
    for (let i = 1; i < many.length; i++) assert.ok(many[i - 1].score >= many[i].score, "score desc");
  });

  test("bad, empty and token-free queries return [] without throwing", () => {
    const idx = index([{ emoji: "A", name: "alpha", keywords: [] }]);
    for (const q of ["", "   ", "+++", "zzqx", null, undefined, 42, {}, ["alpha"]]) {
      let got;
      assert.doesNotThrow(() => { got = idx.search(q); }, `search(${String(q)}) throws`);
      assert.deepEqual(got, [], `search(${JSON.stringify(q)})`);
    }
  });
});

// Covers: MEM-144
// Requirement: bestEmoji picks from the shipped corpus for real Kendall landmark names, or null when nothing matches.
describe("MEM-144 bestEmoji over EMOJI_CORPUS", () => {
  test("Kendall Square T station -> a station/train emoji", () => {
    assert.ok(STATION.includes(best("Kendall Square T station")), best("Kendall Square T station"));
  });

  test("station, t, subway and train each reach a station/train emoji", () => {
    for (const q of ["station", "t", "subway", "train"]) assert.ok(STATION.includes(best(q)), `${q} -> ${best(q)}`);
  });

  test("Flour Bakery + Cafe -> a bakery or cafe emoji", () => {
    assert.ok(BAKERY_CAFE.includes(best("Flour Bakery + Cafe")), best("Flour Bakery + Cafe"));
  });

  test("empty, nonsense and non-string queries -> null", () => {
    for (const q of ["", "zzqx", null, 42]) assert.equal(best(q), null, JSON.stringify(q));
  });
});
