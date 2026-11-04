// Covers: MEM-134
// Requirement: emoji tags replace the sense quick-taps (ADR 0072). static/emoji_data.js holds a frozen EMOJI
// list (>= 120 { e, name, keywords }, lower-case words) that includes every glyph TAP_EMOJI maps to, with
// "bird" -> U+1F426. static/emoji_tags.js: MAX_EMOJIS = 6; searchEmoji(query, list = EMOJI, limit = 48) ranks
// exact name, then name prefix, then any name word / keyword prefix (stable list order within a rank), treats
// a non-string query as "" and never throws; TAP_EMOJI maps every legacy sound/smell/feel/mood tap label
// (lower-case) except smell "None"; migrateTaps(taps) maps sound, smell, feel, mood in that order,
// case-insensitive, unknown/None/turn skipped, deduped, null -> []; museEmojis(station) is never [] (the
// landmark glyph first, then EMOJI matched as whole words in order of first appearance, capped at 6,
// [EMOJI_DEFAULT] when nothing matches); startingEmojis keeps a user-edited list, else normalizes
// migrateTaps + museEmojis; normalizeEmojis keeps trimmed non-empty strings <= 16 UTF-16 units, deduped,
// capped at 6, non-array -> []. All source stays ASCII (emoji as \u{...} escapes).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { TAP_GROUPS } from "./station_card.js";
import { EMOJI_DEFAULT, emojiFor } from "./landmark_emoji.js";

const missing = (name) => (err) => ({ __missing: `${name}: ${String(err)}` });
const data = await import("./emoji_data.js").catch(missing("emoji_data.js"));
const tags = await import("./emoji_tags.js").catch(missing("emoji_tags.js"));

const BIRD = "\u{1F426}";
const COFFEE = "\u{2615}";
const CALM = "\u{1F60C}";
const SENSE_GROUPS = ["sound", "smell", "feel", "mood"];
const words = (entry) => [...entry.name.split(/\s+/), ...entry.keywords];
const unique = (list) => [...new Set(list)];
const EMOJI = () => {
  assert.ok(Array.isArray(data.EMOJI), `EMOJI exported from emoji_data.js (${data.__missing ?? "not an array"})`);
  return data.EMOJI;
};
const fn = (name) => {
  assert.equal(typeof tags[name], "function", `${name} exported from emoji_tags.js (${tags.__missing ?? "missing"})`);
  return tags[name];
};
const TREE_GLYPHS = () => EMOJI().filter((x) => words(x).some((w) => /^trees?$/.test(w))).map((x) => x.e);

// Covers: MEM-134
// Requirement: the emoji list is large enough to browse, well-formed, and covers every migrated tap glyph.
describe("emoji_data: EMOJI list (MEM-134)", () => {
  test("EMOJI is a frozen array of >= 120 well-formed { e, name, keywords } entries", () => {
    const list = EMOJI();
    assert.ok(Object.isFrozen(list), "EMOJI is frozen");
    assert.ok(list.length >= 120, `>= 120 entries, got ${list.length}`);
    for (const x of list) {
      assert.ok(typeof x.e === "string" && x.e.trim() !== "" && x.e.length <= 16, `glyph ${x.e} is 1..16 units`);
      assert.ok(typeof x.name === "string" && x.name !== "" && x.name === x.name.toLowerCase(), `name "${x.name}" lower-case`);
      assert.ok(Array.isArray(x.keywords), `${x.name} has a keywords array`);
      for (const k of x.keywords) assert.ok(typeof k === "string" && k === k.toLowerCase(), `${x.name} keyword "${k}" lower-case`);
    }
  });

  test('the entry named "bird" is U+1F426', () => {
    const bird = EMOJI().find((x) => x.name === "bird");
    assert.ok(bird, 'an entry named "bird"');
    assert.equal(bird.e, BIRD);
  });

  test("every glyph TAP_EMOJI maps to is an EMOJI entry", () => {
    assert.ok(tags.TAP_EMOJI && typeof tags.TAP_EMOJI === "object", `TAP_EMOJI exported (${tags.__missing ?? "missing"})`);
    const glyphs = new Set(EMOJI().map((x) => x.e));
    const absent = Object.entries(tags.TAP_EMOJI).filter(([, e]) => !glyphs.has(e)).map(([k]) => k);
    assert.deepEqual(absent, [], `TAP_EMOJI glyphs missing from EMOJI: ${absent.join(", ")}`);
  });

  test("emoji_data.js and emoji_tags.js are ASCII-only source", () => {
    for (const f of ["./emoji_data.js", "./emoji_tags.js"]) {
      const src = readFileSync(new URL(f, import.meta.url), "utf8");
      const bad = [...src].filter((c) => c.charCodeAt(0) > 0x7f);
      assert.deepEqual(bad, [], `${f} has non-ASCII characters`);
    }
  });
});

// Covers: MEM-134
// Requirement: searching the picker ranks the best match first and is case-insensitive (CRITERIA 1).
describe("searchEmoji (MEM-134, CRITERIA 1)", () => {
  test('"bird" ranks U+1F426 first; "" returns the first 48; "BIRD" and "  bird " equal "bird"', () => {
    const search = fn("searchEmoji");
    assert.equal(search("bird")[0]?.e, BIRD);
    assert.equal(search("").length, 48);
    assert.deepEqual(search("").map((x) => x.e), EMOJI().slice(0, 48).map((x) => x.e));
    assert.deepEqual(search("BIRD"), search("bird"));
    assert.deepEqual(search("  bird "), search("bird"));
  });

  test("limit caps the result; the default list is EMOJI", () => {
    const search = fn("searchEmoji");
    assert.equal(search("", EMOJI(), 5).length, 5);
    assert.deepEqual(search("bird", EMOJI()), search("bird"));
  });

  test("rank: exact name, then name prefix, then word/keyword prefix; stable list order within a rank", () => {
    const search = fn("searchEmoji");
    const list = [
      { e: "A", name: "blackbird", keywords: [] },
      { e: "G", name: "birdbath", keywords: [] },
      { e: "B", name: "big bird", keywords: [] },
      { e: "C", name: "birdhouse", keywords: [] },
      { e: "D", name: "bird", keywords: [] },
      { e: "E", name: "tree", keywords: ["birdsong"] },
      { e: "F", name: "dog", keywords: ["pet"] },
    ];
    assert.deepEqual(search("bird", list).map((x) => x.e), ["D", "G", "C", "B", "E"]);
    assert.deepEqual(search("pe", list).map((x) => x.e), ["F"]);
    assert.deepEqual(search("zzz", list), []);
  });

  test("a non-string query is treated as empty and never throws", () => {
    const search = fn("searchEmoji");
    const first = search("").map((x) => x.e);
    for (const q of [null, undefined, 42, {}, [], true]) {
      assert.deepEqual(search(q).map((x) => x.e), first, `query ${String(q)}`);
    }
  });
});

// Covers: MEM-134
// Requirement: every legacy sense tap has an emoji, so migrating old stations loses nothing.
describe("TAP_EMOJI (MEM-134)", () => {
  const REQUIRED = {
    traffic: "\u{1F697}", birds: BIRD, water: "\u{1F4A7}", voices: "\u{1F5E3}\u{FE0F}", quiet: "\u{1F92B}",
    music: "\u{1F3B5}", coffee: COFFEE, rain: "\u{1F327}\u{FE0F}", calm: CALM,
  };

  test("the required tap labels map to their pinned glyphs", () => {
    for (const [label, e] of Object.entries(REQUIRED)) assert.equal(tags.TAP_EMOJI?.[label], e, `TAP_EMOJI.${label}`);
  });

  test('every sound/smell/feel/mood label except smell "None" maps to a non-empty glyph', () => {
    const unmapped = [];
    for (const g of SENSE_GROUPS) {
      for (const label of TAP_GROUPS[g]) {
        if (g === "smell" && label === "None") continue;
        const e = tags.TAP_EMOJI?.[label.toLowerCase()];
        if (typeof e !== "string" || e.trim() === "") unmapped.push(`${g}:${label}`);
      }
    }
    assert.deepEqual(unmapped, []);
  });
});

// Covers: MEM-134
// Requirement: a station's old taps become emojis in sound, smell, feel, mood order (CRITERIA 4).
describe("migrateTaps (MEM-134, CRITERIA 4)", () => {
  test("Birds/Coffee/Warm/Calm/Left -> starts bird, coffee; contains calm; no turn glyph", () => {
    const migrate = fn("migrateTaps");
    const out = migrate({ sound: "Birds", smell: "Coffee", feel: "Warm", mood: "Calm", turn: "Left" });
    assert.deepEqual(out.slice(0, 2), [BIRD, COFFEE]);
    assert.ok(out.includes(CALM), "calm glyph");
    const T = tags.TAP_EMOJI;
    assert.deepEqual(out, unique([T.birds, T.coffee, T.warm, T.calm]), "exactly the 4 sense glyphs, in order");
  });

  test("null, undefined and {} -> []", () => {
    const migrate = fn("migrateTaps");
    for (const v of [null, undefined, {}]) assert.deepEqual(migrate(v), [], `migrateTaps(${JSON.stringify(v)})`);
  });

  test('case-insensitive; unknown labels, non-strings, smell "None" and turn are skipped', () => {
    const migrate = fn("migrateTaps");
    assert.deepEqual(migrate({ sound: "BIRDS" }), [BIRD]);
    assert.deepEqual(migrate({ sound: "birds" }), [BIRD]);
    assert.deepEqual(migrate({ sound: "Banjo", smell: "None", feel: 5, turn: "Left" }), []);
    for (const turn of TAP_GROUPS.turn) assert.deepEqual(migrate({ turn }), [], `turn ${turn} skipped`);
  });

  test("every sound x smell x feel x mood combination maps in group order, deduped", () => {
    const migrate = fn("migrateTaps");
    const T = tags.TAP_EMOJI;
    const glyph = (label) => T[label.toLowerCase()];
    for (const sound of TAP_GROUPS.sound) for (const smell of TAP_GROUPS.smell) {
      for (const feel of TAP_GROUPS.feel) for (const mood of TAP_GROUPS.mood) {
        const want = unique([sound, smell, feel, mood].filter((l) => l !== "None").map(glyph));
        assert.deepEqual(migrate({ sound, smell, feel, mood }), want, `${sound}/${smell}/${feel}/${mood}`);
      }
    }
  });
});

// Covers: MEM-134
// Requirement: Muse fills a station's emojis from its generated context and never leaves it empty (CRITERIA 2).
describe("museEmojis (MEM-134, CRITERIA 2)", () => {
  const station = (visual, extra = {}) => ({
    name: "red door", profile: { visual, spatial: "left of the path", conceptual: "an entry" }, ...extra,
  });

  test('a profile mentioning "coffee" and "trees" includes U+2615 and a tree glyph', () => {
    const muse = fn("museEmojis");
    const out = muse(station("a coffee cart under tall trees"));
    assert.ok(out.includes(COFFEE), `coffee glyph in ${out.join(" ")}`);
    const trees = TREE_GLYPHS();
    assert.ok(trees.length > 0, "EMOJI has a tree entry");
    assert.ok(out.some((e) => trees.includes(e)), `a tree glyph in ${out.join(" ")}`);
  });

  test("nothing matched -> [EMOJI_DEFAULT]; never [] (null, {}, empty profile, no whole-word match)", () => {
    const muse = fn("museEmojis");
    for (const st of [null, undefined, {}, { name: "", profile: {} }, { name: "qwxz", profile: { visual: "zzbirdzz zzcoffeezz" } }]) {
      assert.deepEqual(muse(st), [EMOJI_DEFAULT], `museEmojis(${JSON.stringify(st)})`);
    }
  });

  test("the landmark glyph comes first when emojiFor finds one", () => {
    const muse = fn("museEmojis");
    const st = { name: "city museum", category: "museum", profile: { visual: "a bird on the roof" } };
    const landmark = emojiFor({ name: st.name, category: st.category });
    assert.notEqual(landmark, EMOJI_DEFAULT, "fixture: emojiFor finds the museum");
    const out = muse(st);
    assert.equal(out[0], landmark);
    assert.ok(out.includes(BIRD), "then the profile's bird");
  });

  test("matches in order of first appearance; a plural and a capitalized word match", () => {
    const muse = fn("museEmojis");
    const out = muse(station("coffee and a bird"));
    assert.ok(out.includes(COFFEE) && out.includes(BIRD), `both glyphs in ${out.join(" ")}`);
    assert.ok(out.indexOf(COFFEE) < out.indexOf(BIRD), "coffee (first in the text) before bird");
    assert.ok(muse(station("Birds sing here")).includes(BIRD), '"Birds" matches bird');
  });

  test("deduped and capped at MAX_EMOJIS (6)", () => {
    const muse = fn("museEmojis");
    const seen = new Set();
    const names = [];
    for (const x of EMOJI()) {
      if (seen.has(x.e)) continue;
      seen.add(x.e);
      names.push(x.name);
      if (names.length === 10) break;
    }
    const out = muse(station(`${names.join(" , ")} , ${names.join(" , ")}`));
    assert.equal(tags.MAX_EMOJIS, 6);
    assert.equal(out.length, 6, `capped: ${out.join(" ")}`);
    assert.equal(new Set(out).size, out.length, "deduped");
  });
});

// Covers: MEM-134
// Requirement: a user-edited emoji list wins over any regeneration (CRITERIA 3).
describe("startingEmojis (MEM-134, CRITERIA 3)", () => {
  const ROCKET = "\u{1F680}";
  const base = { name: "red door", taps: { sound: "Birds" }, profile: { visual: "coffee under trees" } };

  test("emojisEdited true keeps the stored list (a copy), even an empty one", () => {
    const start = fn("startingEmojis");
    const st = { ...base, emojis: [ROCKET], emojisEdited: true };
    const out = start(st);
    assert.deepEqual(out, [ROCKET]);
    out.push("x");
    assert.deepEqual(st.emojis, [ROCKET], "the stored list is not aliased");
    assert.deepEqual(start({ ...base, emojis: [], emojisEdited: true }), []);
  });

  test("not edited -> normalizeEmojis([...migrateTaps(taps), ...museEmojis(station)])", () => {
    const start = fn("startingEmojis");
    const want = (st) => fn("normalizeEmojis")([...fn("migrateTaps")(st.taps), ...fn("museEmojis")(st)]);
    for (const st of [
      base,
      { ...base, emojis: [ROCKET], emojisEdited: false },
      { ...base, emojis: [ROCKET] },
      { ...base, emojis: [ROCKET], emojisEdited: "true" },
      { ...base, emojis: "rocket", emojisEdited: true },
      { name: "plain", profile: {} },
    ]) {
      assert.deepEqual(start(st), want(st), JSON.stringify(st));
    }
    assert.deepEqual(start(base).slice(0, 1), [BIRD], "migrated taps come first");
  });
});

// Covers: MEM-134
// Requirement: a stored emoji list is always 0..6 unique non-empty short strings.
describe("normalizeEmojis (MEM-134)", () => {
  test("trims, drops empties / non-strings / > 16 units, dedupes, caps at 6", () => {
    const norm = fn("normalizeEmojis");
    const x16 = "x".repeat(16);
    const input = [` ${BIRD} `, BIRD, "", "   ", 7, null, "y".repeat(17), x16, "a", "b", "c", "d", "e"];
    const copy = structuredClone(input);
    assert.deepEqual(norm(input), [BIRD, x16, "a", "b", "c", "d"]);
    assert.deepEqual(input, copy, "input not mutated");
  });

  test("non-array -> []", () => {
    const norm = fn("normalizeEmojis");
    for (const v of [null, undefined, "\u{1F426}", {}, 3]) assert.deepEqual(norm(v), [], `normalizeEmojis(${String(v)})`);
  });
});
