// Covers: MEM-140
// Requirement: when Spark (the LLM) is reachable it picks the landmark's emoji, but only a reply that is exactly
// one emoji is trusted; anything else (no Spark, a failure, a slow reply, text, two emoji, empty, non-string)
// falls back to the offline pick (keyword table, then BM25 corpus, then pushpin). Picking never rejects, and
// offline makes no network call.
// Contract (RED; GREEN adds static/landmark_emoji_spark.js):
//   export async function pickLandmarkEmoji(landmark, { spark, timeoutMs = 2500 } = {}) -> string
//     spark(landmark) reply used only if it is one pictographic grapheme (optional FE0F, ZWJ sequences ok,
//     <= 16 UTF-16 units); else emojiFor(landmark). Never rejects.
//   export function sparkEmojiClient(fetchFn) -> async (landmark) => string | null
//     POST "/landmark-emoji", JSON body {name, category, tags}; resolves body.emoji when it is a string, null on
//     a non-ok response, a non-string emoji, or a throw.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { emojiFor } from "./landmark_emoji.js";

const mod = await import("./landmark_emoji_spark.js").catch((err) => ({ __missing: String(err) }));

/** @param {string} name */
function fn(name) {
  assert.equal(typeof mod[name], "function", `static/landmark_emoji_spark.js exports ${name} (${mod.__missing ?? "not exported"})`);
  return mod[name];
}
const pick = (landmark, opts) => fn("pickLandmarkEmoji")(landmark, opts);

const MUSEUM = "\u{1F3DB}\u{FE0F}";
const COOK = "\u{1F468}\u{200D}\u{1F373}";
const CAFE_LANDMARK = { name: "Corner Cafe" };
const OFFLINE = emojiFor(CAFE_LANDMARK);

// Covers: MEM-140
// Requirement: a single-emoji Spark reply wins; everything else falls back to emojiFor, never a rejection.
describe("MEM-140 pickLandmarkEmoji", () => {
  test("one-emoji replies are used (FE0F and ZWJ sequences included)", async () => {
    for (const reply of [MUSEUM, "\u{1F3DB}", COOK]) {
      assert.equal(await pick(CAFE_LANDMARK, { spark: async () => reply }), reply, JSON.stringify(reply));
    }
  });

  test("spark receives the landmark", async () => {
    const seen = [];
    const lm = { name: "MIT Museum", category: "museum", tags: { tourism: "museum" } };
    await pick(lm, { spark: async (x) => { seen.push(x); return MUSEUM; } });
    assert.deepEqual(seen, [lm]);
  });

  test("junk replies fall back to emojiFor", async () => {
    const junk = ["museum", `${MUSEUM}${MUSEUM}`, "\u{1F3DB}\u{1F355}", "", "  ", "7", "A\u{1F3DB}", 42, null, undefined, { emoji: MUSEUM }];
    for (const reply of junk) {
      assert.equal(await pick(CAFE_LANDMARK, { spark: async () => reply }), OFFLINE, JSON.stringify(reply));
    }
  });

  test("a rejecting or throwing spark falls back", async () => {
    assert.equal(await pick(CAFE_LANDMARK, { spark: async () => { throw new Error("down"); } }), OFFLINE);
    assert.equal(await pick(CAFE_LANDMARK, { spark: () => { throw new Error("sync"); } }), OFFLINE);
  });

  test("a spark slower than timeoutMs falls back", async () => {
    assert.equal(await pick(CAFE_LANDMARK, { spark: () => new Promise(() => {}), timeoutMs: 5 }), OFFLINE);
  });

  test("offline: no spark -> emojiFor, and no network call", async () => {
    const realFetch = globalThis.fetch;
    let fetched = 0;
    globalThis.fetch = async () => { fetched += 1; throw new Error("no network"); };
    try {
      assert.equal(await pick(CAFE_LANDMARK), OFFLINE);
      assert.equal(await pick(CAFE_LANDMARK, {}), OFFLINE);
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.equal(fetched, 0);
  });

  test("malformed landmarks resolve to the pushpin, never reject", async () => {
    for (const lm of [null, undefined, 42, {}]) assert.equal(await pick(lm), "\u{1F4CD}", String(lm));
  });
});

// Covers: MEM-140
// Requirement: the browser Spark client posts the landmark to /landmark-emoji and returns the server's emoji or null.
describe("MEM-140 sparkEmojiClient", () => {
  const client = (fetchFn) => fn("sparkEmojiClient")(fetchFn);
  const reply = (ok, body) => async () => ({ ok, status: ok ? 200 : 500, json: async () => body });

  test("POSTs {name, category, tags} as JSON to /landmark-emoji and resolves body.emoji", async () => {
    const calls = [];
    const ask = client(async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ emoji: MUSEUM }) }; });
    const lm = { name: "MIT Museum", category: "museum", tags: { tourism: "museum" } };
    assert.equal(await ask(lm), MUSEUM);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "/landmark-emoji");
    assert.equal(calls[0].init.method, "POST");
    const ct = Object.entries(calls[0].init.headers ?? {}).find(([k]) => k.toLowerCase() === "content-type")?.[1];
    assert.match(String(ct), /application\/json/);
    assert.deepEqual(JSON.parse(calls[0].init.body), lm);
  });

  test("non-ok, null emoji, or a throwing fetch -> null", async () => {
    assert.equal(await client(reply(false, { emoji: MUSEUM }))(CAFE_LANDMARK), null);
    assert.equal(await client(reply(true, { emoji: null }))(CAFE_LANDMARK), null);
    assert.equal(await client(async () => { throw new Error("offline"); })(CAFE_LANDMARK), null);
  });
});
