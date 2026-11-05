// Covers: MEM-144
// Requirement: landmarks the MEM-100 keyword table does not know still get a best-fit emoji, found by keyword
// search over a committed emoji corpus (works offline). The corpus is a plain data module with enough breadth
// to be useful (100+ entries), one row per emoji, every row searchable by its name and keywords, and a transit
// row a Boston rider would find by "station", "t", "subway" or "train".
// Contract (RED; GREEN adds static/emoji_corpus.js, a pure data module):
//   export const EMOJI_CORPUS: ReadonlyArray<{ emoji: string, name: string, keywords: string[] }>;
//   >= 100 entries; emoji non-empty and unique; name non-empty; keywords non-empty strings.
//   A station/train row (U+1F689, U+1F686 or U+1F687) whose lower-case alnum name + keyword tokens include
//   station, t, subway and train; a pizza row (U+1F355) with the token pizza.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

const mod = await import("./emoji_corpus.js").catch((err) => ({ __missing: String(err) }));

function corpus() {
  assert.ok(Array.isArray(mod.EMOJI_CORPUS), `static/emoji_corpus.js exports EMOJI_CORPUS (${mod.__missing ?? "not an array"})`);
  return mod.EMOJI_CORPUS;
}

const tokens = (row) => `${row.name} ${row.keywords.join(" ")}`.toLowerCase().match(/[a-z0-9]+/g) ?? [];
const STATION = ["\u{1F689}", "\u{1F686}", "\u{1F687}"];

// Covers: MEM-144
// Requirement: the corpus is well-formed, broad and unambiguous (one row per emoji).
describe("MEM-144 EMOJI_CORPUS shape", () => {
  test("has at least 100 well-formed rows", () => {
    const rows = corpus();
    assert.ok(rows.length >= 100, `got ${rows.length} rows`);
    for (const [i, row] of rows.entries()) {
      assert.ok(typeof row.emoji === "string" && row.emoji.length > 0, `row ${i} emoji`);
      assert.ok(typeof row.name === "string" && row.name.trim().length > 0, `row ${i} name`);
      assert.ok(Array.isArray(row.keywords), `row ${i} keywords is an array`);
      for (const k of row.keywords) assert.ok(typeof k === "string" && k.trim().length > 0, `row ${i} keyword ${JSON.stringify(k)}`);
    }
  });

  test("every emoji appears once", () => {
    const rows = corpus();
    const seen = new Set();
    for (const row of rows) {
      assert.ok(!seen.has(row.emoji), `duplicate emoji ${JSON.stringify(row.emoji)}`);
      seen.add(row.emoji);
    }
  });

  test("a station/train row carries station, t, subway and train", () => {
    const row = corpus().find((r) => STATION.includes(r.emoji) && ["station", "t", "subway", "train"].every((w) => tokens(r).includes(w)));
    assert.ok(row, "a U+1F689/U+1F686/U+1F687 row with tokens station, t, subway, train");
  });

  test("a pizza row carries pizza", () => {
    const row = corpus().find((r) => r.emoji === "\u{1F355}");
    assert.ok(row, "a U+1F355 row");
    assert.ok(tokens(row).includes("pizza"), "pizza token");
  });
});
