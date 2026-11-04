// Covers: MEM-045
// Requirement: static/sticker_board.js lets the user stick their own picture on a locus of the demo landmark photo.
// createStickerBoard({doc, pool, makeImage, undo}).show({placeKey, width, height, loci}) unhides #sticker-panel,
// fills the #sticker-locus select (value String(n), text "<n>. <label>"), and renders the place's stored
// placements: one #sticker-placed li per placement (text includes the sticker desc) and ONE .sticker-layer in
// #scene-wrap (never duplicated) with one .sticker per placement whose locus has a box, at the box centre as
// percentages of the photo (upload = img src data URL + alt desc; emoji = span with the glyph). #sticker-add
// validates with uploadError (error shown, makeImage not called, pool unchanged), then makeImage(file) (a
// rejection shows a "couldn't read that picture" error), then adds + places + re-renders, clears the inputs and
// hides the error. Peel off needs a confirm (cancel keeps it); a confirmed peel removes it and shows a toast whose
// Undo restores it. Text is set with textContent only: a hostile desc is never parsed as HTML.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

import { fakePage, find, findAll, settle, visibleText } from "./fake_dom_test.mjs";
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
const MADE = "data:image/jpeg;base64,TUFERQ==";
const EMOJI = BASE_STICKERS[0];
const EMOJI_ID = `emoji:${EMOJI.name}`;
const EMOJI_DESC = [EMOJI.name, ...EMOJI.words].join(" ");
// 200x100 photo: locus 1 centre (50, 25) -> 25% / 25%; locus 2 centre (150, 75) -> 75% / 75%; locus 3 no box.
const VIEW = {
  placeKey: "demo",
  width: 200,
  height: 100,
  loci: [
    { n: 1, label: "kendall sign", box: { x1: 0, y1: 0, x2: 100, y2: 50 } },
    { n: 2, label: "red line door", box: { x1: 100, y1: 50, x2: 200, y2: 100 } },
    { n: 3, label: "bench" },
  ],
};

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

function setup({ makeImage } = {}) {
  const p = fakePage(IDS, { hidden: HIDDEN });
  // index.html: the scene canvas lives inside #scene-wrap.
  p.els["scene-wrap"].append(p.els.scene);
  let n = 0;
  const kv = memoryKv();
  const pool = poolApi("createStickerPool")(kv, { now: () => "2026-11-04T10:00:00.000Z", newId: () => `id-${++n}` });
  const imageCalls = [];
  const wrapped = async (file) => {
    imageCalls.push(file);
    return makeImage ? makeImage(file) : MADE;
  };
  const b = boardApi("createStickerBoard")({ doc: p.doc, pool, makeImage: wrapped });
  return { p, kv, pool, b, imageCalls };
}

const hasClass = (node, c) => Boolean(node && typeof node === "object") && (
  node.classList.contains(c) || String(node.className ?? "").split(/\s+/).includes(c) ||
  String(node.attrs?.class ?? "").split(/\s+/).includes(c));
const attr = (node, name) => node[name] ?? node.getAttribute(name);
const layers = (p) => p.els["scene-wrap"].children.filter((c) => hasClass(c, "sticker-layer"));
const photoStickers = (p) => layers(p).flatMap((l) => findAll(l, (x) => hasClass(x, "sticker")));
const placedLis = (p) => findAll(p.els["sticker-placed"], (x) => x.tagName === "LI");
const liFor = (p, text) => placedLis(p).find((li) => li.textContent.includes(text)) ?? null;
const button = (root, action) =>
  find(root, (x) => x.tagName === "BUTTON" && x.dataset.action === action, { visibleOnly: true });
const options = (p) => p.els["sticker-locus"].children.filter((c) => typeof c === "object" && c.tagName === "OPTION");

async function seed(pool) {
  const up = await pool.add({ kind: "upload", desc: "umbrella at kendall", image: JPEG });
  await pool.place("demo", 1, up.id);
  await pool.place("demo", 2, EMOJI_ID);
  await pool.place("demo", 3, EMOJI_ID);
  await pool.place("other", 1, up.id);
  return up;
}

async function show(b, view = VIEW) {
  await b.show(structuredClone(view));
  await settle();
}

/** Fill the add form and click Stick it on. */
async function addVia(p, { file = { type: "image/png", size: 1000, name: "u.png" }, desc = "a red umbrella", n = "1" } = {}) {
  p.els["sticker-file"].files = file ? [file] : [];
  p.els["sticker-file"].value = file ? "C:\\fakepath\\u.png" : "";
  p.els["sticker-desc"].value = desc;
  p.els["sticker-locus"].value = n;
  p.fire(p.els["sticker-add"], "click");
  await settle();
}

// Covers: MEM-045
// Requirement: show unhides the panel, lists every locus in the Spot select and renders stored placements on the
// list and on the photo (box centre, percent of the photo), without duplicating the layer on a re-show.
describe("sticker_board show (MEM-045)", () => {
  test("unhides #sticker-panel", async () => {
    const { p, b } = setup();
    await show(b);
    assert.equal(p.els["sticker-panel"].hidden, false);
  });

  test("fills #sticker-locus with one option per locus (value n, text 'n. label'), not duplicated on re-show", async () => {
    const { p, b } = setup();
    await show(b);
    await show(b);
    assert.deepEqual(options(p).map((o) => [String(attr(o, "value")), o.textContent]), [
      ["1", "1. kendall sign"], ["2", "2. red line door"], ["3", "3. bench"],
    ]);
  });

  test("lists one li per stored placement of this place, text including the sticker desc", async () => {
    const { p, pool, b } = setup();
    await seed(pool);
    await show(b);
    assert.equal(placedLis(p).length, 3, "the 'other' place's placement is not listed");
    assert.ok(liFor(p, "umbrella at kendall"), "upload placement listed");
    assert.equal(placedLis(p).filter((li) => li.textContent.includes(EMOJI_DESC)).length, 2, "both emoji placements listed");
  });

  test("one .sticker-layer in #scene-wrap, kept on re-show, beside the scene canvas", async () => {
    const { p, pool, b } = setup();
    await seed(pool);
    await show(b);
    await show(b);
    assert.equal(layers(p).length, 1);
    assert.ok(p.els["scene-wrap"].children.includes(p.els.scene), "the scene canvas stays in #scene-wrap");
  });

  test("a .sticker per boxed placement at the box centre in percent; the no-box locus is not on the photo", async () => {
    const { p, pool, b } = setup();
    await seed(pool);
    await show(b);
    const stickers = photoStickers(p);
    assert.equal(stickers.length, 2, "locus 3 has no box, so only 2 photo stickers");
    const at = stickers.map((s) => [s.style.left, s.style.top]).sort();
    assert.deepEqual(at, [["25%", "25%"], ["75%", "75%"]]);
  });

  test("upload sticker is an img with the data URL src and the desc alt; emoji sticker is a span with the glyph", async () => {
    const { p, pool, b } = setup();
    await seed(pool);
    await show(b);
    const [s1] = photoStickers(p).filter((s) => s.style.left === "25%");
    const img = find(s1, (x) => x.tagName === "IMG");
    assert.ok(img, "upload sticker renders an img");
    assert.equal(img.src, JPEG);
    assert.equal(attr(img, "alt"), "umbrella at kendall");
    const [s2] = photoStickers(p).filter((s) => s.style.left === "75%");
    const span = find(s2, (x) => x.tagName === "SPAN" && x.textContent === EMOJI.emoji);
    assert.ok(span, "emoji sticker renders a span with the glyph");
    assert.equal(find(s2, (x) => x.tagName === "IMG"), null, "emoji sticker has no img");
  });

  test("a second board over the same pool (reload) renders the stored placements", async () => {
    const first = setup();
    await seed(first.pool);
    const p2 = fakePage(IDS, { hidden: HIDDEN });
    const b2 = boardApi("createStickerBoard")({ doc: p2.doc, pool: first.pool, makeImage: async () => MADE });
    await show(b2);
    assert.equal(placedLis(p2).length, 3);
    assert.equal(photoStickers(p2).length, 2);
  });
});

// Covers: MEM-045
// Requirement: Stick it on refuses a bad picture or description before reading the file; an unreadable picture
// shows an error and adds nothing; a good one is added to the pool, placed on the chosen spot and shown.
describe("sticker_board add (MEM-045)", () => {
  const INVALID = [
    ["svg file", { file: { type: "image/svg+xml", size: 1000, name: "x.svg" } }],
    ["text file", { file: { type: "text/plain", size: 10, name: "x.txt" } }],
    ["no file", { file: null }],
    ["empty desc", { desc: "   " }],
    ["61-char desc", { desc: "x".repeat(61) }],
    ["too large file", { file: { type: "image/jpeg", size: 2 * 1024 * 1024 + 1, name: "big.jpg" } }],
  ];
  for (const [label, input] of INVALID) {
    test(`${label}: error shown, makeImage not called, pool unchanged`, async () => {
      const { p, pool, b, imageCalls } = setup();
      await show(b);
      const before = await pool.list();
      await addVia(p, input);
      assert.equal(p.els["sticker-error"].hidden, false, "error is shown");
      assert.notEqual(p.els["sticker-error"].textContent.trim(), "", "error has a message");
      assert.equal(imageCalls.length, 0, "makeImage not called");
      assert.deepEqual(await pool.list(), before, "pool unchanged");
      assert.deepEqual(await pool.placements("demo"), []);
    });
  }

  test("makeImage rejection: 'couldn't read that picture' error, nothing added", async () => {
    const { p, pool, b, imageCalls } = setup({ makeImage: async () => { throw new Error("decode failed"); } });
    await show(b);
    const before = await pool.list();
    await addVia(p);
    assert.equal(imageCalls.length, 1);
    assert.equal(p.els["sticker-error"].hidden, false);
    assert.match(p.els["sticker-error"].textContent, /couldn.?t read that picture/i);
    assert.deepEqual(await pool.list(), before);
    assert.deepEqual(await pool.placements("demo"), []);
  });

  test("success: makeImage gets the file; upload added + placed on the chosen spot + rendered", async () => {
    const { p, pool, b, imageCalls } = setup();
    await show(b);
    const file = { type: "image/png", size: 1000, name: "u.png" };
    await addVia(p, { file, desc: "  a red umbrella ", n: "2" });
    assert.deepEqual(imageCalls, [file]);
    const added = (await pool.list()).filter((e) => e.kind === "upload");
    assert.equal(added.length, 1);
    assert.equal(added[0].desc, "a red umbrella");
    assert.equal(added[0].image, MADE);
    assert.deepEqual((await pool.placements("demo")).map((x) => [x.n, x.stickerId]), [[2, added[0].id]]);
    assert.ok(liFor(p, "a red umbrella"), "listed");
    const stickers = photoStickers(p);
    assert.equal(stickers.length, 1);
    assert.deepEqual([stickers[0].style.left, stickers[0].style.top], ["75%", "75%"]);
    assert.equal(find(stickers[0], (x) => x.tagName === "IMG")?.src, MADE);
  });

  test("success clears desc and file inputs and hides a previous error", async () => {
    const { p, b } = setup();
    await show(b);
    await addVia(p, { desc: "" });
    assert.equal(p.els["sticker-error"].hidden, false, "precondition: an error is showing");
    await addVia(p);
    assert.equal(p.els["sticker-error"].hidden, true);
    assert.equal(p.els["sticker-desc"].value, "");
    assert.equal(p.els["sticker-file"].value, "");
  });

  test("a hostile desc is shown only as text, never parsed as HTML", async () => {
    const { p, pool, b } = setup();
    await show(b);
    const hostile = "<img src=x onerror=alert(1)>";
    await addVia(p, { desc: hostile });
    assert.equal((await pool.list()).filter((e) => e.desc === hostile).length, 1, "stored verbatim");
    assert.deepEqual(p.htmlWrites, [], "no innerHTML / outerHTML / insertAdjacentHTML");
    assert.ok(liFor(p, hostile), "the li shows the desc as literal text");
    assert.ok(!p.srcWrites.includes("x"), "no img src taken from the desc");
    const imgs = findAll(p.els["sticker-panel"], (x) => x.tagName === "IMG")
      .concat(findAll(p.els["scene-wrap"], (x) => x.tagName === "IMG"));
    assert.ok(imgs.every((i) => i.src === MADE), `only the sticker img exists: ${imgs.map((i) => i.src).join(" ")}`);
  });
});

// Covers: MEM-045
// Requirement: peeling a sticker off needs a confirm step (Keep it cancels); a confirmed peel removes it from the
// list and the photo and shows a toast whose Undo puts it back and hides the toast.
describe("sticker_board peel off + undo (MEM-045)", () => {
  async function ready() {
    const s = setup();
    await seed(s.pool);
    await show(s.b);
    return s;
  }

  test("Peel off shows confirm and cancel; nothing removed yet", async () => {
    const { p, pool } = await ready();
    const li = liFor(p, "umbrella at kendall");
    const peel = button(li, "peel");
    assert.ok(peel, "li has a Peel off button");
    assert.match(peel.textContent, /peel off/i);
    p.fire(peel, "click");
    await settle();
    const li2 = liFor(p, "umbrella at kendall");
    assert.ok(li2, "still listed before confirm");
    assert.match(button(li2, "peel-confirm")?.textContent ?? "", /yes, peel it off/i);
    assert.match(button(li2, "peel-cancel")?.textContent ?? "", /keep it/i);
    assert.equal((await pool.placements("demo")).length, 3);
    assert.equal(photoStickers(p).length, 2);
  });

  test("Keep it cancels: still placed and still on the photo", async () => {
    const { p, pool } = await ready();
    p.fire(button(liFor(p, "umbrella at kendall"), "peel"), "click");
    await settle();
    p.fire(button(liFor(p, "umbrella at kendall"), "peel-cancel"), "click");
    await settle();
    assert.ok(liFor(p, "umbrella at kendall"));
    assert.deepEqual((await pool.placements("demo")).map((x) => x.n), [1, 2, 3]);
    assert.equal(photoStickers(p).length, 2);
    assert.equal(p.els["sticker-toast"].hidden, true);
  });

  test("confirm removes it (pool, list, photo) and shows the toast; Undo restores and hides the toast", async () => {
    const { p, pool } = await ready();
    p.fire(button(liFor(p, "umbrella at kendall"), "peel"), "click");
    await settle();
    p.fire(button(liFor(p, "umbrella at kendall"), "peel-confirm"), "click");
    await settle();
    assert.equal(liFor(p, "umbrella at kendall"), null, "li gone");
    assert.deepEqual((await pool.placements("demo")).map((x) => x.n), [2, 3]);
    assert.equal(photoStickers(p).filter((s) => s.style.left === "25%").length, 0, "photo sticker gone");
    assert.equal(p.els["sticker-toast"].hidden, false, "toast shown");
    assert.notEqual(visibleText(p.els["sticker-toast-text"]).trim(), "", "toast has text");

    p.fire(p.els["sticker-undo"], "click");
    await settle();
    assert.deepEqual((await pool.placements("demo")).map((x) => x.n), [1, 2, 3]);
    assert.ok(liFor(p, "umbrella at kendall"), "li back");
    assert.equal(photoStickers(p).filter((s) => s.style.left === "25%").length, 1, "photo sticker back");
    assert.equal(p.els["sticker-toast"].hidden, true, "toast hidden");
  });
});

// Covers: MEM-045
// Requirement: the board never builds markup from strings: static/sticker_board.js has no innerHTML.
describe("sticker_board source (MEM-045)", () => {
  test("static/sticker_board.js exists and contains no innerHTML", () => {
    const url = new URL("./sticker_board.js", import.meta.url);
    assert.ok(existsSync(url), "static/sticker_board.js must exist");
    assert.doesNotMatch(readFileSync(url, "utf8"), /innerHTML/);
  });
});
