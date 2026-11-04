// Covers: MEM-052
// Requirement: the sticker pool is searchable by description. createStickerPool(kv, opts).search(text) resolves the
// list() entries whose desc contains the trimmed text case-insensitively; blank or non-string text resolves [].
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { fakePage, jsonResponse, memoryAdapter, record, settle, find, findAll, visibleText } from "./fake_dom_test.mjs";
import { createPalaceStore } from "./palace_store.js";

const poolMod = await import("./sticker_pool.js").catch((err) => ({ __missing: String(err) }));
const genMod = await import("./sticker_gen.js").catch((err) => ({ __missing: String(err) }));
const boardMod = await import("./sticker_board.js").catch((err) => ({ __missing: String(err) }));
const encode = await import("./encode.js").catch((err) => ({ __missing: String(err) }));

function need(mod, file, name) {
  assert.ok(name in mod, `static/${file} must export ${name} (${mod.__missing ?? "not exported"})`);
  return mod[name];
}

const SCENE = "data:image/jpeg;base64,U0NFTkU";
const CROPPED = "data:image/jpeg;base64,Q1JPUA";
const BOX = { x1: 10, y1: 20, x2: 110, y2: 120 };

function memoryKv({ failPut = false } = {}) {
  const map = new Map();
  return {
    async get(key) { return map.has(key) ? structuredClone(map.get(key)) : undefined; },
    async put(key, value) {
      if (failPut) throw new Error("QuotaExceededError");
      map.set(key, structuredClone(value));
    },
    async delete(key) { map.delete(key); },
    async list() { return [...map.values()].map((v) => structuredClone(v)); },
  };
}

function makePool(kv = memoryKv()) {
  let n = 0;
  return need(poolMod, "sticker_pool.js", "createStickerPool")(kv, { now: () => "2026-11-04T10:00:00.000Z", newId: () => `id-${++n}` });
}

describe("sticker_pool search (MEM-052)", () => {
  test("finds a generated entry case-insensitively and with surrounding spaces; blank gives []", async () => {
    const pool = makePool();
    const e = await pool.add({ kind: "generated", desc: "Oat milk", image: "data:image/jpeg;base64,QUJD" });
    const search = need(pool, "sticker_pool.js (pool)", "search");
    assert.ok((await search("oat milk")).some((x) => x.id === e.id));
    assert.ok((await search("  MILK ")).some((x) => x.id === e.id));
    assert.deepEqual(await search(""), []);
    assert.deepEqual(await search("   "), []);
    assert.deepEqual(await search(null), []);
  });
});

const fakeCrop = () => {
  const calls = [];
  const crop = async (...args) => { calls.push(args); return CROPPED; };
  return { crop, calls };
};
const tier1 = { tier: 1, image: SCENE, width: 800, height: 600 };
const stepFor = (item, n = 1) => ({ item, locus: { n, label: "lamp", box: BOX }, entry: {} });
const generated = async (pool) => (await pool.list()).filter((e) => e.kind === "generated");

// Covers: MEM-052
// Requirement: stickMemorized(pool, placeKey, steps, scenes, {crop}) sticks each memorized item on its locus and never
// rejects: a tier-1 scene is cropped around the locus box into a generated sticker (reused when the pool already
// holds one with that desc); any failure falls back to the first matching emoji sticker, or skips the item when
// none matches; blank items and already-placed loci are left alone; descs are cut to 60 characters.
describe("stickMemorized (MEM-052)", () => {
  const run = () => need(genMod, "sticker_gen.js", "stickMemorized");

  test("tier 1 scene: crops, adds one generated entry, places it at the locus", async () => {
    const pool = makePool();
    const { crop, calls } = fakeCrop();
    const out = await run()(pool, "demo", [stepFor("milk", 2)], [tier1], { crop });
    assert.deepEqual(calls, [[SCENE, BOX, 800, 600]]);
    const gen = await generated(pool);
    assert.equal(gen.length, 1);
    assert.equal(gen[0].image, CROPPED);
    assert.equal(gen[0].desc, "milk");
    assert.deepEqual((await pool.placements("demo")).map((x) => [x.n, x.stickerId]), [[2, gen[0].id]]);
    assert.equal(out.length, 1);
    assert.equal(out[0].n, 2);
    assert.equal(out[0].kind, "generated");
    assert.ok((await pool.search("milk")).some((e) => e.image === CROPPED));
  });

  test("tier 3 network: emoji fallback, no generated entry, resolves", async () => {
    const pool = makePool();
    const { crop } = fakeCrop();
    const out = await run()(pool, "demo", [stepFor("bread")], [{ tier: 3, reason: "network" }], { crop });
    assert.deepEqual((await pool.placements("demo")).map((x) => x.stickerId), ["emoji:bread"]);
    assert.equal(out[0].kind, "emoji");
    assert.equal((await generated(pool)).length, 0);
  });

  test("scene null: emoji fallback", async () => {
    const pool = makePool();
    await run()(pool, "demo", [stepFor("bread")], [null], { crop: fakeCrop().crop });
    assert.deepEqual((await pool.placements("demo")).map((x) => x.stickerId), ["emoji:bread"]);
  });

  test("crop rejects: emoji fallback, resolves", async () => {
    const pool = makePool();
    const crop = async () => { throw new Error("canvas failed"); };
    const out = await run()(pool, "demo", [stepFor("bread")], [tier1], { crop });
    assert.deepEqual((await pool.placements("demo")).map((x) => x.stickerId), ["emoji:bread"]);
    assert.equal(out[0].kind, "emoji");
  });

  test("no emoji match and no scene: skipped, resolves []", async () => {
    const pool = makePool();
    const out = await run()(pool, "demo", [stepFor("zzqx")], [{ tier: 3, reason: "network" }], { crop: fakeCrop().crop });
    assert.deepEqual(out, []);
    assert.deepEqual(await pool.placements("demo"), []);
  });

  test("blank item is skipped", async () => {
    const pool = makePool();
    const out = await run()(pool, "demo", [stepFor("   ")], [tier1], { crop: fakeCrop().crop });
    assert.deepEqual(out, []);
    assert.deepEqual(await pool.placements("demo"), []);
  });

  test("an existing placement at that locus is kept", async () => {
    const pool = makePool();
    await pool.place("demo", 1, "emoji:bread");
    const { crop, calls } = fakeCrop();
    await run()(pool, "demo", [stepFor("milk", 1)], [tier1], { crop });
    assert.deepEqual((await pool.placements("demo")).map((x) => [x.n, x.stickerId]), [[1, "emoji:bread"]]);
    assert.equal((await generated(pool)).length, 0);
    assert.equal(calls.length, 0);
  });

  test("running twice adds only one generated entry (reuse by desc)", async () => {
    const pool = makePool();
    const { crop, calls } = fakeCrop();
    await run()(pool, "demo", [stepFor("milk", 1)], [tier1], { crop });
    await run()(pool, "other", [stepFor("milk", 1)], [tier1], { crop });
    const gen = await generated(pool);
    assert.equal(gen.length, 1);
    assert.equal(calls.length, 1, "crop not called for the reused desc");
    assert.deepEqual((await pool.placements("other")).map((x) => x.stickerId), [gen[0].id]);
  });

  test("an 80-char item gives a 60-char desc", async () => {
    const pool = makePool();
    await run()(pool, "demo", [stepFor("m".repeat(80))], [tier1], { crop: fakeCrop().crop });
    const gen = await generated(pool);
    assert.equal(gen[0].desc.length, 60);
  });

  test("a kv whose put always throws does not reject", async () => {
    const pool = makePool(memoryKv({ failPut: true }));
    await assert.doesNotReject(run()(pool, "demo", [stepFor("milk"), stepFor("bread", 2)], [tier1, tier1], { crop: fakeCrop().crop }));
  });
});

const IDS = [
  "sticker-panel", "sticker-locus", "sticker-file", "sticker-desc", "sticker-add", "sticker-error",
  "sticker-placed", "sticker-toast", "sticker-toast-text", "sticker-undo", "scene-wrap", "scene",
];
const hasClass = (node, c) => Boolean(node && typeof node === "object") && (
  node.classList.contains(c) || String(node.className ?? "").split(/\s+/).includes(c));

// Covers: MEM-052
// Requirement: board.stickMemorized(steps, scenes) resolves [] and changes nothing before show; after show it
// sticks the generated pictures, so the photo's .sticker-layer shows an img (alt = item, src = cropped URL) and the
// placed list names the item as "AI-generated".
describe("sticker_board stickMemorized (MEM-052)", () => {
  function setup() {
    const p = fakePage(IDS, { hidden: ["sticker-panel", "sticker-error", "sticker-toast"] });
    p.els["scene-wrap"].append(p.els.scene);
    const pool = makePool();
    const { crop } = fakeCrop();
    const b = need(boardMod, "sticker_board.js", "createStickerBoard")({ doc: p.doc, pool, makeImage: async () => CROPPED, crop });
    return { p, pool, b };
  }
  const steps = [{ item: "milk", locus: { n: 1, label: "lamp", box: { x1: 0, y1: 0, x2: 100, y2: 50 } }, entry: {} }];

  test("before show: resolves [] and the pool is unchanged", async () => {
    const { b, pool } = setup();
    const before = await pool.list();
    assert.deepEqual(await need(b, "sticker_board.js (board)", "stickMemorized")(steps, [tier1]), []);
    assert.deepEqual(await pool.list(), before);
  });

  test("after show: places a generated sticker on the photo and lists it as AI-generated", async () => {
    const { p, b } = setup();
    await b.show({ placeKey: "demo", width: 800, height: 600, loci: [{ n: 1, label: "lamp", box: { x1: 0, y1: 0, x2: 100, y2: 50 } }] });
    await settle();
    const out = await need(b, "sticker_board.js (board)", "stickMemorized")(steps, [tier1]);
    await settle();
    assert.equal(out.length, 1);
    const layer = p.els["scene-wrap"].children.find((c) => hasClass(c, "sticker-layer"));
    const stickers = findAll(layer, (x) => hasClass(x, "sticker"));
    assert.equal(stickers.length, 1);
    const img = find(stickers[0], (x) => x.tagName === "IMG");
    assert.ok(img, "sticker has an img");
    assert.equal(img.src, CROPPED);
    assert.equal(img.alt ?? img.getAttribute("alt"), "milk");
    const li = findAll(p.els["sticker-placed"], (x) => x.tagName === "LI")[0];
    assert.match(li.textContent, /milk/);
    assert.match(li.textContent, /AI-generated/);
  });
});

const ITEMS = ["milk", "eggs", "bread"];
const LOCI = ["lamp", "door", "clock"].map((label, i) => ({ n: i + 1, label, box: { x1: 10 + i * 200, y1: 10, x2: 150 + i * 200, y2: 200 } }));
const DIDS = [
  "route-review", "route", "route-edit", "route-live", "route-toast", "route-toast-text", "route-undo", "generate", "auto", "walk", "walk-prev", "walk-next", "walk-step",
  "scenes", "scene-overlay", "assoc-status", "associations", "upload-status", "scene", "loci", "status",
];

function demoSetup(stickers) {
  const p = fakePage(DIDS, { hidden: ["route-review", "route-toast", "walk", "scene-overlay"] });
  const fetch = async (url, init = {}) => {
    const u = String(url);
    const body = init.body && typeof init.body === "string" ? JSON.parse(init.body) : null;
    if (u === "/demo/photo.jpg") return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1]), { headers: { "content-type": "image/jpeg" } });
    if (u === "/loci") return jsonResponse({ image: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==", width: 800, height: 600, loci: LOCI });
    if (u === "/demo/notes.txt") return new Response("Buy milk. Then eggs. Then bread.", { headers: { "content-type": "text/plain" } });
    if (u === "/split") return jsonResponse({ points: ITEMS.map((label) => ({ label, source_quote: `Buy ${label}` })) });
    if (u === "/associate") return jsonResponse({ record: record(body.item, body.locus), status: "valid", sig: `sig_${body.item}` });
    if (u === "/scenes") return jsonResponse({ tier: 1, image: `${SCENE}${body.record.item}`, width: 800, height: 600 });
    return jsonResponse({ error: "not_found" }, 404);
  };
  return { p, deps: { doc: p.doc, fetch, store: createPalaceStore(memoryAdapter()), loadImage: async (src) => ({ src }), stickers } };
}

// Covers: MEM-052
// Requirement: after the demo palace is built, runDemoPalace hands the steps (item + locus) and the scene results to
// deps.stickers.stickMemorized exactly once, and a failing stickMemorized never breaks the demo walk.
describe("runDemoPalace sticks memorized items (MEM-052)", () => {
  const runDemo = (deps) => {
    assert.ok("runDemoPalace" in encode, `static/encode.js must export runDemoPalace (${encode.__missing ?? "not exported"})`);
    return encode.runDemoPalace({ auto: true }, deps);
  };

  test("calls stickMemorized once with 3 steps (milk, eggs, bread) and 3 tier-1 scenes", async () => {
    const calls = [];
    const { p, deps } = demoSetup({ show() {}, stickMemorized(steps, scenes) { calls.push({ steps, scenes }); } });
    await runDemo(deps);
    await settle();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].steps.map((s) => s.item), ITEMS);
    assert.equal(calls[0].scenes.length, 3);
    assert.ok(calls[0].scenes.every((s) => s && s.tier === 1));
    assert.match(visibleText(p.els["walk-step"]), /\b1 of 3\b/);
  });

  for (const [label, fn] of [
    ["rejects", () => Promise.reject(new Error("boom"))],
    ["throws", () => { throw new Error("boom"); }],
  ]) {
    test(`stickMemorized that ${label} does not break the demo`, async () => {
      let called = 0;
      const { p, deps } = demoSetup({ show() {}, stickMemorized() { called += 1; return fn(); } });
      await assert.doesNotReject(runDemo(deps));
      await settle();
      assert.equal(called, 1, "stickMemorized was reached");
      assert.match(visibleText(p.els["walk-step"]), /\b1 of 3\b/);
    });
  }
});
