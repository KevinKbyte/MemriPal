// Covers: MEM-134
// Requirement: the station card shows the station's senses as emoji tags (ADR 0079) instead of the
// sound/smell/feel/mood quick-tap grids. show() renders ul#station-emojis with one li > button.emoji-chip per
// emoji; the starting list is the legacy taps migrated to emoji plus the Muse auto-fill, saved ONCE with
// edited false (station.taps stays unchanged), and a station the user already edited (emojisEdited true) keeps
// its stored list (no overwrite). #emoji-add opens #emoji-picker (input#emoji-search + #emoji-results holding
// button.emoji-pick); picking appends the emoji and saves with edited true; at MAX_EMOJIS (6) #emoji-add is
// disabled. Removing needs a confirm: clicking a chip arms it (aria-pressed "true") and shows #emoji-remove;
// only then does #emoji-remove remove it (saved edited true), and #emoji-undo restores the previous list.
// #station-tap-summary lists only the turn tap now.
// Contract (RED; GREEN implements in static/station_card.js + static/emoji_tags.js + route_store.js
// setStationEmojis): createStationCard({ doc, store, routeId, fetch }) -> { show(stationId) }.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import * as rs from "./route_store.js";
import { fakePage, findAll, settle } from "./fake_dom_test.mjs";
import { memoryAdapter, ENCODED, fetchSpy } from "./route_store_fakes_test.mjs";

const CARD_IDS = [
  "station-card", "station-name", "station-name-error", "station-profile", "station-taps", "tap-turn",
  "station-emojis", "emoji-add", "emoji-remove", "emoji-undo", "emoji-picker", "emoji-search", "emoji-results",
  "station-tap-summary",
  "station-save", "station-drop", "station-drop-confirm", "station-drop-cancel", "station-undo",
];
const START_HIDDEN = ["station-name-error", "station-drop-confirm", "station-drop-cancel", "station-undo",
  "emoji-remove", "emoji-undo", "emoji-picker", "station-tap-summary"];

const BIRD = "\u{1F426}";
const TAPS = { sound: "Birds", turn: "Left" };
const PROFILE = { visual: "a red door with brass studs", spatial: "left of the path", conceptual: "an entry" };
const MAX = 6;

const loadCard = async () => (await import("./station_card.js")).createStationCard;

const newPage = () => {
  const p = fakePage(CARD_IDS, { hidden: START_HIDDEN });
  p.els["station-name"].value = "";
  p.els["emoji-search"].value = "";
  return p;
};

/** A kv adapter that counts put calls (the store's persistence writes). */
function countingAdapter() {
  const base = memoryAdapter();
  const kv = { ...base, puts: 0 };
  kv.put = async (k, v) => {
    kv.puts += 1;
    return base.put(k, v);
  };
  return kv;
}

/** A route with one named station carrying TAPS. */
async function setup() {
  const kv = countingAdapter();
  const store = rs.createRouteStore(kv);
  const route = await store.createRoute({ name: "Walk", kind: "daily" });
  const st = await store.addStation(route.id, { photo: ENCODED.slice() });
  await store.nameStation(route.id, st.id, { name: "red door", profile: PROFILE });
  await store.setStationTaps(route.id, st.id, TAPS);
  return mount({ kv, route, selfId: st.id });
}

/** A fresh store + page + card over the same kv (as after a reload). */
async function mount({ kv, route, selfId }) {
  const store = rs.createRouteStore(kv);
  const p = newPage();
  const card = (await loadCard())({ doc: p.doc, store, routeId: route.id, fetch: fetchSpy([]).fn });
  return { kv, store, route, selfId, p, card };
}

/** Rewrites the stored station's raw record (a station saved by a user edit) and remounts. */
async function seedEdited(ctx, emojis) {
  for (const [key, v] of ctx.kv.map) {
    if (v?.type !== "route" || v.route?.id !== ctx.route.id) continue;
    const st = v.route.stations.find((s) => s.id === ctx.selfId);
    st.emojis = [...emojis];
    st.emojisEdited = true;
    ctx.kv.map.set(key, v);
  }
  return mount(ctx);
}

const stored = async (ctx) =>
  (await rs.createRouteStore(ctx.kv).getRoute(ctx.route.id)).stations.find((s) => s.id === ctx.selfId);
const hasClass = (n, c) => String(n.className ?? "").split(/\s+/).includes(c) || Boolean(n.classList?.contains(c));
const chips = (ctx) => findAll(ctx.p.els["station-emojis"], (n) => n.tagName === "BUTTON" && hasClass(n, "emoji-chip"));
const chipTexts = (ctx) => chips(ctx).map((n) => n.textContent);
const picks = (ctx) => findAll(ctx.p.els["emoji-results"], (n) => n.tagName === "BUTTON" && hasClass(n, "emoji-pick"));
const click = async (ctx, node) => {
  ctx.p.fire(node, "click");
  await settle();
};
const show = async (ctx) => {
  await ctx.card.show(ctx.selfId);
  await settle();
};
/** Opens the picker and picks the first result not already a chip. */
async function addOne(ctx) {
  await click(ctx, ctx.p.els["emoji-add"]);
  const have = chipTexts(ctx);
  const pick = picks(ctx).find((b) => !have.includes(b.textContent));
  assert.ok(pick, "the picker offers an emoji not yet on the card");
  await click(ctx, pick);
  return pick.textContent;
}

// Covers: MEM-134
// Requirement: show() renders the starting emojis as chips and saves the auto list once (edited false);
// station.taps stays unchanged; the summary lists only the turn tap.
describe("station card emoji tags: starting list (MEM-134)", () => {
  test("show() renders li > button.emoji-chip per emoji, migrated tap first", async () => {
    const ctx = await setup();
    await show(ctx);
    const list = chipTexts(ctx);
    assert.ok(list.length >= 1 && list.length <= MAX, `1..${MAX} chips, got ${list.length}`);
    assert.equal(list[0], BIRD, "the Birds sound tap migrates to the first chip");
    for (const c of chips(ctx)) assert.equal(c.parent?.tagName, "LI", "each chip sits in an li");
  });

  test("the auto list is persisted exactly once with emojisEdited false", async () => {
    const ctx = await setup();
    const before = ctx.kv.puts;
    await show(ctx);
    assert.equal(ctx.kv.puts - before, 1, "one put for the auto emojis");
    const st = await stored(ctx);
    assert.deepEqual(st.emojis, chipTexts(ctx), "stored emojis are the rendered chips");
    assert.equal(st.emojisEdited, false);

    const again = await mount(ctx);
    const mid = ctx.kv.puts;
    await show(again);
    assert.equal(ctx.kv.puts - mid, 0, "a second show() saves nothing (already stored)");
    assert.deepEqual(chipTexts(again), st.emojis);
  });

  test("station.taps is unchanged by show()", async () => {
    const ctx = await setup();
    await show(ctx);
    assert.deepEqual((await stored(ctx)).taps, TAPS);
  });

  test("#station-tap-summary lists only the turn tap", async () => {
    const ctx = await setup();
    await show(ctx);
    const lines = findAll(ctx.p.els["station-tap-summary"], (n) => n.tagName === "LI").map((n) => n.textContent);
    assert.deepEqual(lines, ["Next turn: Left"]);
  });

  test("an emojisEdited station keeps its stored list (no overwrite, no save)", async () => {
    const edited = await seedEdited(await setup(), ["\u{1F680}"]);
    const before = edited.kv.puts;
    await show(edited);
    assert.deepEqual(chipTexts(edited), ["\u{1F680}"], "user list rendered as stored");
    const st = await stored(edited);
    assert.deepEqual(st.emojis, ["\u{1F680}"]);
    assert.equal(st.emojisEdited, true);
    assert.equal(edited.kv.puts - before, 0, "nothing re-saved");
  });
});

// Covers: MEM-134
// Requirement: #emoji-add opens the search picker; picking a result appends and saves it (edited true); the
// search input re-renders results; at MAX_EMOJIS #emoji-add is disabled.
describe("station card emoji tags: add via the picker (MEM-134)", () => {
  test("#emoji-add shows #emoji-picker with button.emoji-pick results", async () => {
    const ctx = await setup();
    await show(ctx);
    assert.equal(ctx.p.els["emoji-picker"].hidden, true, "picker starts hidden");
    await click(ctx, ctx.p.els["emoji-add"]);
    assert.equal(ctx.p.els["emoji-picker"].hidden, false, "picker shown");
    assert.ok(picks(ctx).length > 0, "results rendered");
  });

  test("typing in #emoji-search re-renders the results ('bird' first)", async () => {
    const ctx = await setup();
    await show(ctx);
    await click(ctx, ctx.p.els["emoji-add"]);
    ctx.p.els["emoji-search"].value = "bird";
    ctx.p.fire(ctx.p.els["emoji-search"], "input");
    await settle();
    const first = picks(ctx)[0];
    assert.equal(first?.textContent, BIRD);
    assert.equal(first.getAttribute("aria-label"), "bird");
  });

  test("picking a result appends it and persists with emojisEdited true", async () => {
    const ctx = await setup();
    await show(ctx);
    const prior = chipTexts(ctx);
    const added = await addOne(ctx);
    assert.deepEqual(chipTexts(ctx), [...prior, added], "chip appended");
    const st = await stored(ctx);
    assert.deepEqual(st.emojis, [...prior, added]);
    assert.equal(st.emojisEdited, true);
  });

  test(`reaching ${MAX} emojis disables #emoji-add`, async () => {
    const five = ["\u{1F680}", "\u{1F681}", "\u{1F682}", "\u{1F683}", "\u{1F684}"];
    const ctx = await seedEdited(await setup(), five);
    await show(ctx);
    assert.equal(ctx.p.els["emoji-add"].disabled, false, "5 emojis: + still enabled");
    await addOne(ctx);
    assert.equal((await stored(ctx)).emojis.length, MAX);
    assert.equal(ctx.p.els["emoji-add"].disabled, true, `${MAX} emojis: + disabled`);
  });

  test(`a station shown with ${MAX} emojis starts with #emoji-add disabled`, async () => {
    const six = ["\u{1F680}", "\u{1F681}", "\u{1F682}", "\u{1F683}", "\u{1F684}", "\u{1F685}"];
    const ctx = await seedEdited(await setup(), six);
    await show(ctx);
    assert.equal(ctx.p.els["emoji-add"].disabled, true);
  });
});

// Covers: MEM-134
// Requirement: removing an emoji needs a click to arm the chip plus a confirm on #emoji-remove, and
// #emoji-undo restores the previous list (every delete has a confirm and an Undo).
describe("station card emoji tags: remove arm / confirm / Undo (MEM-134)", () => {
  test("#emoji-remove does nothing until a chip is armed; armed chip shows aria-pressed and Remove", async () => {
    const ctx = await setup();
    await show(ctx);
    const before = (await stored(ctx)).emojis;
    assert.equal(ctx.p.els["emoji-remove"].hidden, true, "Remove starts hidden");
    await click(ctx, ctx.p.els["emoji-remove"]);
    assert.deepEqual((await stored(ctx)).emojis, before, "unarmed Remove removes nothing");

    await click(ctx, chips(ctx)[0]);
    assert.equal(chips(ctx)[0].getAttribute("aria-pressed"), "true", "first chip armed");
    assert.equal(ctx.p.els["emoji-remove"].hidden, false, "Remove shown once armed");
    assert.equal(ctx.p.els["emoji-remove"].textContent.trim(), `Remove ${before[0]}`);
    assert.deepEqual((await stored(ctx)).emojis, before, "arming removes nothing");
  });

  test("armed + #emoji-remove removes it (edited true); #emoji-undo restores the list", async () => {
    const ctx = await setup();
    await show(ctx);
    const before = (await stored(ctx)).emojis;
    await click(ctx, chips(ctx)[0]);
    await click(ctx, ctx.p.els["emoji-remove"]);
    let st = await stored(ctx);
    assert.deepEqual(st.emojis, before.slice(1), "armed emoji removed");
    assert.equal(st.emojisEdited, true);
    assert.deepEqual(chipTexts(ctx), before.slice(1), "chip gone");
    assert.equal(ctx.p.els["emoji-remove"].hidden, true, "Remove hidden again");
    assert.equal(ctx.p.els["emoji-undo"].hidden, false, "Undo shown");

    await click(ctx, ctx.p.els["emoji-undo"]);
    st = await stored(ctx);
    assert.deepEqual(st.emojis, before, "Undo restores the previous list");
    assert.equal(st.emojisEdited, true);
    assert.deepEqual(chipTexts(ctx), before);
    assert.equal(ctx.p.els["emoji-undo"].hidden, true, "Undo hidden again");
  });
});
