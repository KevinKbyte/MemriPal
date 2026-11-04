// Covers: MEM-045, MEM-131
// Requirement: on the photo, a placed sticker can be dragged to another spot (MEM-131). Each .sticker face carries
// data-n (its locus). While dragging, the face follows the pointer as a percentage of the photo (client coords
// mapped through the .sticker-layer rect). The drop snaps to the boxed locus under or nearest the drop point
// (unboxed loci are never targets): onto an occupied locus the two stickers swap, onto an empty boxed locus the
// sticker moves; either shows the toast `Moved "<desc>" to <label>.` and #sticker-undo restores both spots. A drop
// on the sticker's own locus changes nothing and shows no toast. A tap or click never changes the pool. Touch works
// the same as mouse. CSS lets the face take pointer events and suppresses touch scrolling on it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { fakePage, findAll, settle, visibleText } from "./fake_dom_test.mjs";
import { BASE_STICKERS } from "./stickers.js";

const board = await import("./sticker_board.js").catch((err) => ({ __missing: String(err) }));
const poolMod = await import("./sticker_pool.js").catch((err) => ({ __missing: String(err) }));

function boardApi(name) {
  assert.ok(name in board, `static/sticker_board.js must export ${name} (${board.__missing ?? "not exported"})`);
  return board[name];
}
function poolApi(name) {
  assert.ok(name in poolMod, `static/sticker_pool.js must export ${name} (${poolMod.__missing ?? "not exported"})`);
  return poolMod[name];
}

const IDS = [
  "sticker-panel", "sticker-locus", "sticker-file", "sticker-desc", "sticker-add", "sticker-error",
  "sticker-placed", "sticker-toast", "sticker-toast-text", "sticker-undo", "scene-wrap", "scene",
];
const HIDDEN = ["sticker-panel", "sticker-error", "sticker-toast"];

const JPEG = "data:image/jpeg;base64,QUJD";
const EMOJI_ID = `emoji:${BASE_STICKERS[0].name}`;
// 200x100 photo shown in a 400x200 layer at (10, 20): client = (10 + 2x, 20 + 2y).
// Locus 1 centre (50, 25) -> client (110, 70); locus 2 centre (150, 75) -> client (310, 170); locus 3 no box;
// locus 4 "fountain" is boxed and empty.
const VIEW = {
  placeKey: "demo",
  width: 200,
  height: 100,
  loci: [
    { n: 1, label: "kendall sign", box: { x1: 0, y1: 0, x2: 100, y2: 50 } },
    { n: 2, label: "red line door", box: { x1: 100, y1: 50, x2: 200, y2: 100 } },
    { n: 3, label: "bench" },
    { n: 4, label: "fountain", box: { x1: 0, y1: 50, x2: 100, y2: 100 } },
  ],
};
const RECT = { left: 10, top: 20, width: 400, height: 200, right: 410, bottom: 220, x: 10, y: 20 };

function memoryKv() {
  const map = new Map();
  return {
    async get(key) {
      return map.has(key) ? structuredClone(map.get(key)) : undefined;
    },
    async put(key, value) {
      map.set(key, structuredClone(value));
    },
    async delete(key) {
      map.delete(key);
    },
    async list() {
      return [...map.values()].map((v) => structuredClone(v));
    },
  };
}

const hasClass = (node, c) => Boolean(node && typeof node === "object") && (
  node.classList.contains(c) || String(node.className ?? "").split(/\s+/).includes(c) ||
  String(node.attrs?.class ?? "").split(/\s+/).includes(c));
const layers = (p) => p.els["scene-wrap"].children.filter((c) => hasClass(c, "sticker-layer"));
const photoStickers = (p) => layers(p).flatMap((l) => findAll(l, (x) => hasClass(x, "sticker")));
const face = (p, n) => photoStickers(p).find((s) => String(s.dataset.n) === String(n)) ?? null;

async function setup() {
  const p = fakePage(IDS, { hidden: HIDDEN });
  p.els["scene-wrap"].append(p.els.scene);
  // The layer covers the photo; #scene-wrap and #scene share its rect so either mapping source agrees.
  p.layout.rectOf = (el) =>
    hasClass(el, "sticker-layer") || el === p.els["scene-wrap"] || el === p.els.scene ? RECT : {};
  let n = 0;
  const pool = poolApi("createStickerPool")(memoryKv(), {
    now: () => "2026-11-04T10:00:00.000Z",
    newId: () => `id-${++n}`,
  });
  const b = boardApi("createStickerBoard")({ doc: p.doc, pool, makeImage: async () => JPEG });
  const up = await pool.add({ kind: "upload", desc: "umbrella at kendall", image: JPEG });
  await pool.place("demo", 1, up.id);
  await pool.place("demo", 2, EMOJI_ID);
  await pool.place("demo", 3, EMOJI_ID);
  await b.show(structuredClone(VIEW));
  await settle();
  return { p, pool, b, up };
}

/** n -> stickerId for the demo place. */
async function spots(pool) {
  return Object.fromEntries((await pool.placements("demo")).map((x) => [x.n, x.stickerId]));
}

const ptr = (x, y, pointerType) => ({ pointerId: 7, clientX: x, clientY: y, button: 0, pointerType });

/** Press the face at `from`, move through to `to`, release there, then let async pool work finish. */
async function drag(p, el, from, to, pointerType = "mouse") {
  assert.ok(el, "face to drag exists");
  p.fire(el, "pointerdown", ptr(from[0], from[1], pointerType));
  p.fire(el, "pointermove", ptr((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, pointerType));
  p.fire(el, "pointermove", ptr(to[0], to[1], pointerType));
  p.fire(el, "pointerup", ptr(to[0], to[1], pointerType));
  await settle();
}

const near = (styleValue, want, label) => {
  assert.match(String(styleValue), /%$/, `${label} is a percentage`);
  assert.ok(Math.abs(parseFloat(styleValue) - want) < 0.01, `${label}: ${styleValue} ~ ${want}%`);
};

// Covers: MEM-131
// Requirement: faces carry their locus number and follow the pointer during a drag, in percent of the photo.
describe("sticker_board drag follows the pointer (MEM-131)", () => {
  test("each boxed placement's .sticker face carries data-n", async () => {
    const { p } = await setup();
    assert.deepEqual(photoStickers(p).map((s) => String(s.dataset.n)).sort(), ["1", "2"]);
  });

  test("moving locus 1's face to client (210, 120) puts it at 50% / 50%", async () => {
    const { p } = await setup();
    const el = face(p, 1);
    assert.ok(el, "locus 1 face");
    p.fire(el, "pointerdown", ptr(110, 70, "mouse"));
    p.fire(el, "pointermove", ptr(210, 120, "mouse"));
    await settle();
    near(el.style.left, 50, "left");
    near(el.style.top, 50, "top");
  });
});

// Covers: MEM-131
// Requirement: a drop swaps with an occupied locus or moves to an empty boxed one, toasts, and Undo restores.
describe("sticker_board drop swaps or moves, with Undo (MEM-131)", () => {
  test("dropping locus 1 at (310, 170) swaps it with locus 2 and toasts the move", async () => {
    const { p, pool, up } = await setup();
    await drag(p, face(p, 1), [110, 70], [310, 170]);
    assert.deepEqual(await spots(pool), { 1: EMOJI_ID, 2: up.id, 3: EMOJI_ID });
    assert.equal(p.els["sticker-toast"].hidden, false, "toast shown");
    assert.equal(visibleText(p.els["sticker-toast-text"]).trim(), 'Moved "umbrella at kendall" to red line door.');
    assert.ok(findAll(face(p, 2), (x) => x.tagName === "IMG").length === 1, "the upload now shows on locus 2");
  });

  test("#sticker-undo after a swap restores both spots", async () => {
    const { p, pool, up } = await setup();
    await drag(p, face(p, 1), [110, 70], [310, 170]);
    p.fire(p.els["sticker-undo"], "click");
    await settle();
    assert.deepEqual(await spots(pool), { 1: up.id, 2: EMOJI_ID, 3: EMOJI_ID });
    assert.equal(p.els["sticker-toast"].hidden, true, "toast hidden after undo");
    assert.ok(findAll(face(p, 1), (x) => x.tagName === "IMG").length === 1, "the upload is back on locus 1");
  });

  test("dropping on the empty boxed locus 4 moves the placement there; Undo puts it back", async () => {
    const { p, pool, up } = await setup();
    await drag(p, face(p, 1), [110, 70], [110, 170]);
    assert.deepEqual(await spots(pool), { 2: EMOJI_ID, 3: EMOJI_ID, 4: up.id });
    assert.equal(visibleText(p.els["sticker-toast-text"]).trim(), 'Moved "umbrella at kendall" to fountain.');
    assert.ok(face(p, 4), "a face renders on locus 4");
    assert.equal(face(p, 1), null, "locus 1 is empty");
    p.fire(p.els["sticker-undo"], "click");
    await settle();
    assert.deepEqual(await spots(pool), { 1: up.id, 2: EMOJI_ID, 3: EMOJI_ID });
  });

  test("a touch drag swaps the same as a mouse drag", async () => {
    const { p, pool, up } = await setup();
    await drag(p, face(p, 1), [110, 70], [310, 170], "touch");
    assert.deepEqual(await spots(pool), { 1: EMOJI_ID, 2: up.id, 3: EMOJI_ID });
  });
});

// Covers: MEM-131
// Requirement: the drop snaps to the nearest boxed locus; its own locus is a no-op; unboxed loci are never targets.
describe("sticker_board drop snapping (MEM-131)", () => {
  test("a drop on the sticker's own locus leaves the pool untouched, shows no toast and re-centres the face", async () => {
    const { p, pool, up } = await setup();
    await drag(p, face(p, 1), [110, 70], [90, 60]);
    assert.deepEqual(await spots(pool), { 1: up.id, 2: EMOJI_ID, 3: EMOJI_ID });
    assert.equal(p.els["sticker-toast"].hidden, true, "no toast");
    near(face(p, 1).style.left, 25, "left");
    near(face(p, 1).style.top, 25, "top");
  });

  test("a drop outside every box at (390, 40) snaps to the nearest, locus 2", async () => {
    const { p, pool, up } = await setup();
    await drag(p, face(p, 1), [110, 70], [390, 40]);
    assert.deepEqual(await spots(pool), { 1: EMOJI_ID, 2: up.id, 3: EMOJI_ID });
  });

  test("the unboxed locus 3 is never a drop target", async () => {
    for (const to of [[10, 20], [410, 220], [210, 120], [600, 400], [-200, -100]]) {
      const { p, pool } = await setup();
      await drag(p, face(p, 2), [310, 170], to);
      const after = await spots(pool);
      assert.equal(after[3], EMOJI_ID, `locus 3 untouched after a drop at (${to})`);
      assert.doesNotMatch(visibleText(p.els["sticker-toast-text"]), /bench/, `no move to bench at (${to})`);
    }
  });
});

// Covers: MEM-131
// Requirement: a tap or click on a placed sticker never changes the pool (no regenerate, no move).
describe("sticker_board tap never changes the pool (MEM-131)", () => {
  test("pointerdown + pointerup + click on a face leaves placements and the stored sticker unchanged", async () => {
    const { p, pool, up } = await setup();
    const before = await pool.get(up.id);
    const el = face(p, 1);
    assert.ok(el, "locus 1 face");
    p.fire(el, "pointerdown", ptr(110, 70, "mouse"));
    p.fire(el, "pointerup", ptr(110, 70, "mouse"));
    p.fire(el, "click", { clientX: 110, clientY: 70, button: 0 });
    await settle();
    assert.deepEqual(await spots(pool), { 1: up.id, 2: EMOJI_ID, 3: EMOJI_ID });
    assert.deepEqual(await pool.get(up.id), before, "the sticker is not regenerated");
    assert.equal(p.els["sticker-toast"].hidden, true, "no toast");
  });
});

// Covers: MEM-131
// Requirement: style.css lets a placed photo sticker take pointer events (its layer stays pointer-events: none) and
// turns off touch panning on it so a finger drag moves the sticker, not the page.
describe("sticker_board drag CSS (MEM-131)", () => {
  const css = readFileSync(new URL("./style.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((m) => ({ sel: m[1].trim(), body: m[2] }))
    .filter((r) => r.sel.split(",").some((s) => /(^|[\s>+~])\.sticker$/.test(s.trim())));

  test("some rule for .sticker sets pointer-events: auto and none sets pointer-events: none", () => {
    assert.ok(rules.length > 0, "style.css has a .sticker rule");
    assert.ok(rules.some((r) => /pointer-events\s*:\s*auto/.test(r.body)), "pointer-events: auto on .sticker");
    assert.ok(!rules.some((r) => /pointer-events\s*:\s*none/.test(r.body)), "no pointer-events: none on .sticker");
  });

  test("some rule for .sticker sets touch-action: none", () => {
    assert.ok(rules.some((r) => /touch-action\s*:\s*none/.test(r.body)), "touch-action: none on .sticker");
  });
});
