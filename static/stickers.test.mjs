// Covers: MEM-117
// Requirement: static/stickers.js (no DOM, pure) turns a memory item into one merged emoji sticker.
// BASE_STICKERS is a frozen pool of >= 30 { emoji, name, words } with unique emoji and lower-case [a-z ] names and
// words, matching every tour keyword (sizzling, bacon, squeaking, tennis, ball, dripping, peanut, butter, belly,
// voucher, paper, crown). keywords(text) lower-cases, splits on non-letters, drops words under 3 letters and a STOP
// set (the, and, for, with, in, of, or), dedupes keeping the first, and returns at most 3. search(query, pool) is a
// whole-word match of any query keyword against a sticker's name words or words (a plural "s" tolerated), ranked
// by matched-keyword count then pool order; no keyword gives []. compose(text, rng, pool) picks
// matches[floor(rng() * len)].emoji per keyword, skipping repeats, so parts has 1..3 unique emoji, or
// [FALLBACK_EMOJI] (U+2728, written as a unicode escape) when nothing matched; desc is the keywords joined by a
// space, or the text when there are none; a fixed rng gives the same sticker. rollAll composes every item;
// rollOne returns a new array with only index i recomposed (other entries keep their object identity) and an
// out-of-range i gives an unchanged copy. Source is ASCII-only, with no DOM, network or HTML parsing.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

const mod = await import("./stickers.js").catch((err) => ({ __missing: String(err) }));

function need(name) {
  assert.ok(name in mod, `static/stickers.js must export ${name} (${mod.__missing ?? "not exported"})`);
  return mod[name];
}

const SPARKLES = String.fromCodePoint(0x2728);
const TOUR_KEYWORDS = ["sizzling", "bacon", "squeaking", "tennis", "ball", "dripping", "peanut", "butter", "belly",
  "voucher", "paper", "crown"];
const TOUR_ITEMS = ["sizzling bacon", "squeaking tennis ball", "dripping peanut butter",
  "belly-rub voucher, wax paw seal", "spare paper crown, in case of rain, or a coup"];

/** Deterministic seeded rng (mulberry32), values in [0, 1). */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Small pools whose ranking and picks are known by hand.
const RANK_POOL = [
  { emoji: "A", name: "red apple", words: ["fruit"] },
  { emoji: "B", name: "ball", words: ["toy", "red"] },
  { emoji: "C", name: "red ball", words: ["toy"] },
  { emoji: "D", name: "cat", words: [] },
];
const PICK_POOL = [
  { emoji: "R1", name: "red one", words: [] },
  { emoji: "R2", name: "red two", words: [] },
  { emoji: "BL", name: "blue", words: [] },
];
const emojis = (list) => list.map((s) => s.emoji);

describe("BASE_STICKERS pool shape (MEM-117)", () => {
  test("frozen array of >= 30 entries", () => {
    const pool = need("BASE_STICKERS");
    assert.ok(Array.isArray(pool), "BASE_STICKERS is an array");
    assert.ok(pool.length >= 30, `only ${pool.length} stickers`);
    assert.equal(Object.isFrozen(pool), true, "BASE_STICKERS is frozen");
  });

  test("every emoji is a non-empty string and unique", () => {
    const pool = need("BASE_STICKERS");
    for (const s of pool) assert.ok(typeof s.emoji === "string" && s.emoji.length > 0, `bad emoji in ${JSON.stringify(s)}`);
    const dupes = pool.map((s) => s.emoji).filter((e, i, all) => all.indexOf(e) !== i);
    assert.deepEqual(dupes, [], "duplicate emoji");
  });

  test("names are non-empty lower-case [a-z ]; words is an array of lower-case [a-z ] strings", () => {
    for (const s of need("BASE_STICKERS")) {
      assert.match(s.name, /^[a-z ]+$/, `name ${JSON.stringify(s.name)}`);
      assert.ok(s.name.trim().length > 0, "name is not blank");
      assert.ok(Array.isArray(s.words), `words of ${s.name} is an array`);
      for (const w of s.words) assert.match(w, /^[a-z ]+$/, `word ${JSON.stringify(w)} of ${s.name}`);
    }
  });

  test("every tour keyword finds at least one sticker", () => {
    const search = need("search");
    const missing = TOUR_KEYWORDS.filter((k) => search(k).length === 0);
    assert.deepEqual(missing, [], `tour keywords with no sticker: ${missing.join(" ")}`);
  });

  test("every tour item composes to a real sticker, not the fallback", () => {
    const compose = need("compose");
    for (const item of TOUR_ITEMS) {
      assert.notDeepEqual(compose(item, () => 0).parts, [SPARKLES], `${item} fell back to sparkles`);
    }
  });

  test('FALLBACK_EMOJI is sparkles (U+2728)', () => {
    assert.equal(need("FALLBACK_EMOJI"), SPARKLES);
  });
});

// Covers: MEM-117
// Requirement: keywords(text) gives up to 3 lower-case, deduped, non-stop words of 3+ letters, in order.
describe("keywords(text) (MEM-117)", () => {
  test('"sizzling bacon" -> ["sizzling", "bacon"]', () => {
    assert.deepEqual(need("keywords")("sizzling bacon"), ["sizzling", "bacon"]);
  });

  test("empty, blank and missing text give []", () => {
    const keywords = need("keywords");
    for (const t of ["", "   ", null, undefined]) assert.deepEqual(keywords(t), [], `keywords(${JSON.stringify(t)})`);
  });

  test("lower-cases, drops stop words and words under 3 letters, dedupes keeping the first", () => {
    const keywords = need("keywords");
    assert.deepEqual(keywords("The Cat and the HAT"), ["cat", "hat"]);
    assert.deepEqual(keywords("bacon Bacon BACON"), ["bacon"]);
    assert.deepEqual(keywords("a ox cat"), ["cat"]);
    assert.deepEqual(keywords("the and for with in of or"), []);
  });

  test("splits on any non-letter (hyphen, comma, digit, punctuation)", () => {
    const keywords = need("keywords");
    assert.deepEqual(keywords("peanut-butter, jelly!"), ["peanut", "butter", "jelly"]);
    assert.deepEqual(keywords("4 tennis balls"), ["tennis", "balls"]);
  });

  test("returns at most 3 keywords, the first 3 in order", () => {
    assert.deepEqual(need("keywords")("alpha bravo charlie delta echo"), ["alpha", "bravo", "charlie"]);
  });

  test("pure: a new array every call, input unchanged", () => {
    const keywords = need("keywords");
    const a = keywords("sizzling bacon");
    a.push("mutated");
    assert.deepEqual(keywords("sizzling bacon"), ["sizzling", "bacon"]);
  });
});

// Covers: MEM-117
// Requirement: search finds stickers by whole-word keyword (plural tolerated), best match first.
describe("search(query, pool) (MEM-117)", () => {
  test("ranks by matched-keyword count desc, then pool order, and returns the pool's sticker objects", () => {
    const res = need("search")("red ball", RANK_POOL);
    assert.deepEqual(emojis(res), ["B", "C", "A"]);
    assert.equal(res[0], RANK_POOL[1], "returns the pool entry itself");
  });

  test('plural "s" is tolerated: "balls" matches name word "ball"', () => {
    assert.deepEqual(emojis(need("search")("balls", RANK_POOL)), ["B", "C"]);
  });

  test("whole-word only: 'all' does not match 'ball', 'app' does not match 'apple'", () => {
    const search = need("search");
    assert.deepEqual(search("all", RANK_POOL), []);
    assert.deepEqual(search("app", RANK_POOL), []);
  });

  test("matches the words list as well as the name", () => {
    assert.deepEqual(emojis(need("search")("fruit", RANK_POOL)), ["A"]);
  });

  test("empty query, stop-word-only query and no-match query give []", () => {
    const search = need("search");
    for (const q of ["", "   ", "the of and", "zebra"]) assert.deepEqual(search(q, RANK_POOL), [], `search(${JSON.stringify(q)})`);
  });

  test("only the first 3 keywords of the query count", () => {
    assert.deepEqual(need("search")("zzz yyy xxx red", RANK_POOL), []);
  });

  test("default pool is BASE_STICKERS: 'balls' finds a sticker there", () => {
    const res = need("search")("balls");
    assert.ok(res.length >= 1, "no sticker for 'balls'");
    for (const s of res) assert.ok(need("BASE_STICKERS").includes(s), "result comes from BASE_STICKERS");
  });
});

// Covers: MEM-117
// Requirement: compose merges 1..3 unique emoji per item, repeatable for a fixed rng, sparkles when nothing matches.
describe("compose(text, rng, pool) (MEM-117)", () => {
  test("returns { text, keywords, parts, desc } with parts in keyword order", () => {
    const res = need("compose")("Red blue", () => 0, PICK_POOL);
    assert.deepEqual(res, { text: "Red blue", keywords: ["red", "blue"], parts: ["R1", "BL"], desc: "red blue" });
  });

  test("picks matches[floor(rng() * length)]: rng 0 -> first match, rng 0.99 -> last", () => {
    const compose = need("compose");
    assert.deepEqual(compose("red", () => 0, PICK_POOL).parts, ["R1"]);
    assert.deepEqual(compose("red", () => 0.99, PICK_POOL).parts, ["R2"]);
  });

  test("default rng is Math.random, read at call time", (t) => {
    const compose = need("compose");
    let v = 0;
    t.mock.method(Math, "random", () => v);
    assert.deepEqual(compose("red blue", undefined, PICK_POOL).parts, ["R1", "BL"]);
    v = 0.99;
    assert.deepEqual(compose("red blue", undefined, PICK_POOL).parts, ["R2", "BL"]);
  });

  test("an emoji already in parts is not added twice", () => {
    const pool = [{ emoji: "X", name: "red blue", words: [] }];
    assert.deepEqual(need("compose")("red blue", () => 0, pool).parts, ["X"]);
  });

  test("no keyword matched -> parts [FALLBACK_EMOJI], desc = keywords joined", () => {
    const res = need("compose")("zzzz qqqq", () => 0, PICK_POOL);
    assert.deepEqual(res.parts, [SPARKLES]);
    assert.deepEqual(res.keywords, ["zzzz", "qqqq"]);
    assert.equal(res.desc, "zzzz qqqq");
  });

  test("no keywords at all -> parts [FALLBACK_EMOJI], desc = text", () => {
    const compose = need("compose");
    assert.deepEqual(compose("", () => 0, PICK_POOL), { text: "", keywords: [], parts: [SPARKLES], desc: "" });
    assert.deepEqual(compose("of", () => 0, PICK_POOL), { text: "of", keywords: [], parts: [SPARKLES], desc: "of" });
  });

  test("one keyword matched among unmatched ones -> no fallback added", () => {
    assert.deepEqual(need("compose")("red zzzz", () => 0, PICK_POOL).parts, ["R1"]);
  });

  test("deterministic for a given seeded rng", () => {
    const compose = need("compose");
    for (const item of TOUR_ITEMS) assert.deepEqual(compose(item, seeded(42)), compose(item, seeded(42)), item);
  });

  test("property: any text over BASE_STICKERS gives 1..3 unique parts from the pool, fallback only when nothing matched", () => {
    const [compose, search, keywords, pool] = [need("compose"), need("search"), need("keywords"), need("BASE_STICKERS")];
    const known = new Set(pool.map((s) => s.emoji));
    const junk = ["zzzz", "qqqq", "the", "of", "xylo", "and"];
    const gen = seeded(7);
    const pick = (list) => list[Math.floor(gen() * list.length)];
    for (let n = 0; n < 200; n++) {
      const words = Array.from({ length: 1 + Math.floor(gen() * 5) },
        () => (gen() < 0.6 ? pick(pick(pool).name.split(" ")) : pick(junk)));
      const text = words.join(gen() < 0.5 ? " " : ", ");
      const { parts } = compose(text, seeded(n));
      assert.ok(parts.length >= 1 && parts.length <= 3, `${text}: ${parts.length} parts`);
      assert.equal(new Set(parts).size, parts.length, `${text}: repeated part`);
      const matched = keywords(text).some((k) => search(k).length > 0);
      if (matched) {
        for (const p of parts) assert.ok(known.has(p), `${text}: part ${p} not in BASE_STICKERS`);
      } else {
        assert.deepEqual(parts, [SPARKLES], `${text}: no match must give the fallback`);
      }
    }
  });
});

// Covers: MEM-117
// Requirement: Roll all re-composes every item; rolling one item leaves every other sticker untouched.
describe("rollAll and rollOne (MEM-117)", () => {
  const items = ["red", "blue", "red blue"];

  test("rollAll returns one compose result per item, same length, in order", () => {
    const [rollAll, compose] = [need("rollAll"), need("compose")];
    const res = rollAll(items, () => 0, PICK_POOL);
    assert.equal(res.length, items.length);
    assert.deepEqual(res, items.map((t) => compose(t, () => 0, PICK_POOL)));
    assert.deepEqual(rollAll([], () => 0, PICK_POOL), []);
  });

  test("rollOne returns a new array: index i recomposed, every other entry the same object", () => {
    const [rollAll, rollOne, compose] = [need("rollAll"), need("rollOne"), need("compose")];
    const before = rollAll(items, () => 0, PICK_POOL);
    const snapshot = [...before];
    const after = rollOne(before, 0, () => 0.99, PICK_POOL);
    assert.notEqual(after, before, "a new array");
    assert.equal(after.length, before.length);
    assert.deepEqual(after[0], compose("red", () => 0.99, PICK_POOL));
    assert.deepEqual(after[0].parts, ["R2"]);
    assert.equal(after[1], before[1], "entry 1 keeps its reference");
    assert.equal(after[2], before[2], "entry 2 keeps its reference");
    snapshot.forEach((s, k) => assert.equal(before[k], s, `input entry ${k} untouched`));
    assert.deepEqual(before[0].parts, ["R1"], "input sticker 0 not mutated");
  });

  test("rollOne with an out-of-range index returns an unchanged copy", () => {
    const [rollAll, rollOne] = [need("rollAll"), need("rollOne")];
    const before = rollAll(items, () => 0, PICK_POOL);
    for (const i of [-1, items.length, 99]) {
      const after = rollOne(before, i, () => 0.99, PICK_POOL);
      assert.notEqual(after, before, `index ${i}: a new array`);
      assert.equal(after.length, before.length);
      before.forEach((s, k) => assert.equal(after[k], s, `index ${i}: entry ${k} same reference`));
    }
  });
});

// Covers: MEM-117
// Requirement: stickers.js is offline, DOM-free, ASCII-only source.
describe("stickers.js source rules (MEM-117)", () => {
  test("ASCII-only, no DOM, no HTML parsing, no network, no non-relative import; sparkles as a unicode escape", () => {
    const url = new URL("./stickers.js", import.meta.url);
    assert.ok(existsSync(url), "static/stickers.js exists");
    const bytes = readFileSync(url);
    const high = [...bytes].findIndex((b) => b > 0x7f);
    assert.equal(high, -1, `non-ASCII byte at offset ${high}`);
    const src = bytes.toString("utf8");
    assert.doesNotMatch(src, /\b(innerHTML|outerHTML|insertAdjacentHTML)\b/);
    assert.doesNotMatch(src, /\bdocument\.|\bwindow\.|\blocalStorage\b/);
    assert.doesNotMatch(src, /\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource/);
    for (const [, spec] of src.matchAll(/\bimport\b[^"']*["']([^"']+)["']/g)) {
      assert.match(spec, /^\.\//, `import "${spec}" is not a relative ./ module`);
    }
    assert.match(src, /\\u2728|\\u\{2728\}|fromCodePoint\(\s*0x2728\s*\)/i, "FALLBACK_EMOJI not written as a unicode escape");
  });
});

