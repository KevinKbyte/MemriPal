import { describe, test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeTourDom, makeEvent } from "./tour_fake_dom_test.mjs";

const mod = await import("./tour.js").catch((err) => ({ __missing: String(err) }));
const stkMod = await import("./stickers.js").catch((err) => ({ __missing: String(err) }));

function need(name) {
  assert.ok(name in mod, `static/tour.js must export ${name} (${mod.__missing ?? "not exported"})`);
  return mod[name];
}

function needStk(name) {
  assert.ok(name in stkMod, `static/stickers.js must export ${name} (${stkMod.__missing ?? "not exported"})`);
  return stkMod[name];
}

const HOUSE_SPOTS = ["Doormat", "Water bowl", "Chew-toy throne", "Scratching post", "Window"];
// Box centres in viewBox units, from STEPS[2].house boxes [x, y, w, h].
const CENTRE = {
  "Doormat": [160, 191.5], "Water bowl": [75, 154], "Chew-toy throne": [78, 100], "Scratching post": [253, 126],
  "Window": [160, 51],
};
// Desktop: the 320x200 house svg drawn at 640x400 from the client origin, so client = 2 x viewBox.
const DESK = { top: 0, left: 0, width: 640, height: 400 };
// A 375px phone: the svg spans the card width (343px) at the same 320:200 aspect.
const PHONE = { left: 16, top: 300, width: 343, height: 214.375 };

function memStore() {
  const data = new Map();
  return { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => { data.set(k, String(v)); } };
}

const next = (dom, times = 1) => { for (let i = 0; i < times; i++) dom.click(dom.$("tour-next")); };
const figItems = () => need("STEPS")[2].fig.map((r) => r.item);
const composed = (v) => figItems().map((item) => needStk("compose")(item, () => v).parts);
const houseSvgOf = (dom) => dom.$("tour-house").querySelector("svg");
const stickerFor = (dom, spot) => {
  const g = houseSvgOf(dom).querySelectorAll("g.tour-sticker").find((e) => e.getAttribute("aria-label") === `Sticker on ${spot}`);
  assert.ok(g, `no g.tour-sticker with aria-label "Sticker on ${spot}"`);
  return g;
};
const partsOf = (g) => g.querySelectorAll("text").map((t) => t.textContent);
const allParts = (dom) => HOUSE_SPOTS.map((s) => partsOf(stickerFor(dom, s)));
const rowText = (dom, cls) => dom.$("tour-fig").children.map((li) => li.querySelector(`.${cls}`)?.textContent);
const figIcons = (dom) => rowText(dom, "fig-icon");
const pressed = (dom) => HOUSE_SPOTS.map((s) => stickerFor(dom, s).getAttribute("aria-pressed"));
const selected = (dom) => HOUSE_SPOTS.filter((s) => stickerFor(dom, s).classList.contains("is-selected"));
const undoBtn = (dom) => dom.$("tour-roll-undo");
/** Copy of `a` with entries i and j exchanged. */
const swapped = (a, i, j) => { const b = [...a]; [b[i], b[j]] = [a[j], a[i]]; return b; };

/** The group's translate(x y) in viewBox units. */
function translateOf(g) {
  const m = /translate\(\s*(-?[\d.]+)(?:[\s,]+(-?[\d.]+))?\s*\)/.exec(g.getAttribute("transform") ?? "");
  assert.ok(m, `g.tour-sticker "${g.getAttribute("aria-label")}" has no translate(): ${g.getAttribute("transform")}`);
  return [Number(m[1]), Number(m[2] ?? 0)];
}
const anchors = (dom) => HOUSE_SPOTS.map((s) => translateOf(stickerFor(dom, s)));
function assertAnchored(dom, want, why) {
  anchors(dom).forEach(([x, y], n) => {
    const [wx, wy] = want[n];
    assert.ok(Math.abs(x - wx) < 0.01 && Math.abs(y - wy) < 0.01,
      `${why}: ${HOUSE_SPOTS[n]} at translate(${x} ${y}), anchor (${wx} ${wy})`);
  });
}

const toClient = (r, [x, y]) => [r.left + (x * r.width) / 320, r.top + (y * r.height) / 200];

/** Dispatch a pointer event at client point `at` on `g`; returns the event. */
function pointer(g, type, [clientX, clientY], init = {}) {
  const ev = makeEvent(type, { pointerId: 1, button: 0, pointerType: "mouse", clientX, clientY, ...init });
  g.dispatchEvent(ev);
  return ev;
}

/**
 * Press `spot`'s sticker at its anchor, move to viewBox point `to`, then (unless `end` is "none") release there
 * ("up", followed by the click a browser fires) or cancel ("cancel"). The house svg's client rect is `rect`.
 */
function drag(dom, spot, to, { rect = DESK, pointerType = "mouse", end = "up" } = {}) {
  houseSvgOf(dom).rect = { ...rect };
  const g = stickerFor(dom, spot);
  const at = toClient(rect, to);
  pointer(g, "pointerdown", toClient(rect, translateOf(g)), { pointerType });
  const move = pointer(g, "pointermove", at, { pointerType });
  if (end === "up") {
    pointer(g, "pointerup", at, { pointerType });
    g.dispatchEvent(makeEvent("click", { clientX: at[0], clientY: at[1] }));
  } else if (end === "cancel") {
    pointer(g, "pointercancel", at, { pointerType });
  }
  return { g, move };
}

/** Wire the tour with Math.random returning `rng.v` (mutable), then go to step 3. */
function onHouse(t, rng = { v: 0 }) {
  t.mock.method(Math, "random", () => rng.v);
  const dom = makeTourDom();
  need("wireTour")(dom.doc, memStore());
  next(dom, 2);
  return dom;
}

beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
afterEach(() => mock.timers.reset());

// Covers: MEM-130
// Requirement: MEM-130 amends MEM-117/MEM-109. On step 3 a tap never regenerates a sticker: a press that moves
// past the drag slop drags the g.tour-sticker (aria-label "Sticker on <spot>"), its translate following the
// pointer mapped into the 320x200 viewBox through the house svg's client rect; the drop snaps to the box under
// the point, else the box with the nearest edge, and swaps the two loci's sticker, fig row icon, fig item and
// .tour-kw caption. Every sticker then returns to its box's anchor and the dropped one is selected at its new
// spot. A drop on its own box, or a pointercancel, changes nothing. Touch drags work the same at 375px.
describe("dragging a step 3 sticker onto another spot (MEM-130)", () => {
  test("dropping the Doormat sticker on the Window box swaps sticker, fig icon, item and keywords", (t) => {
    const rng = { v: 0 };
    const dom = onHouse(t, rng);
    const parts = allParts(dom);
    const icons = figIcons(dom);
    const items = rowText(dom, "fig-item");
    const kws = rowText(dom, "tour-kw");
    const home = anchors(dom);
    rng.v = 0.999;
    drag(dom, "Doormat", CENTRE.Window);
    assert.deepEqual(allParts(dom), swapped(parts, 0, 4), "Doormat and Window stickers swapped");
    assert.deepEqual(allParts(dom), swapped(composed(0), 0, 4), "a drag never re-rolls");
    assert.deepEqual(figIcons(dom), swapped(icons, 0, 4), "fig row icons swapped");
    assert.deepEqual(rowText(dom, "fig-item"), swapped(items, 0, 4), "fig items swapped");
    assert.deepEqual(rowText(dom, "tour-kw"), swapped(kws, 0, 4), ".tour-kw captions swapped");
    assert.deepEqual(rowText(dom, "fig-spot"), HOUSE_SPOTS, "spot names stay in walk order");
    assert.deepEqual(selected(dom), ["Window"], "the dropped sticker is selected at its new spot");
    assert.equal(stickerFor(dom, "Window").getAttribute("aria-pressed"), "true");
    assertAnchored(dom, home, "after the drop");
    for (const s of HOUSE_SPOTS) {
      assert.equal(stickerFor(dom, s).classList.contains("is-dragging"), false, `${s} still is-dragging`);
    }
  });

  test("a drop outside every box snaps to the box with the nearest edge (Scratching post, not Window)", (t) => {
    const dom = onHouse(t);
    const parts = allParts(dom);
    // (300, 10): Scratching post's edge is ~77.7 away, Window's ~116.9.
    drag(dom, "Doormat", [300, 10]);
    assert.deepEqual(allParts(dom), swapped(parts, 0, 3), "Doormat swapped with Scratching post");
    assert.deepEqual(selected(dom), ["Scratching post"]);
  });

  test("a drop back on its own box changes nothing and leaves Undo hidden", (t) => {
    const dom = onHouse(t);
    const parts = allParts(dom);
    const icons = figIcons(dom);
    const home = anchors(dom);
    drag(dom, "Doormat", CENTRE.Doormat);
    assert.deepEqual(allParts(dom), parts);
    assert.deepEqual(figIcons(dom), icons);
    assertAnchored(dom, home, "after a drop on its own box");
    assert.equal(undoBtn(dom).hidden, true, "nothing to undo");
  });

  test("during a drag the moved sticker's translate follows the mapped pointer and it carries is-dragging", (t) => {
    const dom = onHouse(t);
    const home = anchors(dom);
    const { g, move } = drag(dom, "Water bowl", [230, 60], { end: "none" });
    const [x, y] = translateOf(g);
    assert.ok(Math.abs(x - 230) <= 1 && Math.abs(y - 60) <= 1, `dragged sticker at (${x}, ${y}), pointer at (230, 60)`);
    assert.equal(g.classList.contains("is-dragging"), true, "is-dragging while dragged");
    assert.equal(move.defaultPrevented, true, "a drag move is defaultPrevented");
    HOUSE_SPOTS.forEach((s, n) => {
      if (s === "Water bowl") return;
      const [ox, oy] = translateOf(stickerFor(dom, s));
      assert.ok(ox === home[n][0] && oy === home[n][1], `${s} moved during another sticker's drag`);
    });
  });

  test("a pointercancel mid-drag puts the sticker back and swaps nothing", (t) => {
    const dom = onHouse(t);
    const parts = allParts(dom);
    const home = anchors(dom);
    const { g } = drag(dom, "Doormat", CENTRE.Window, { end: "cancel" });
    assert.deepEqual(allParts(dom), parts);
    assertAnchored(dom, home, "after pointercancel");
    assert.equal(g.classList.contains("is-dragging"), false);
    assert.equal(undoBtn(dom).hidden, true);
  });

  test("a press that moves less than the slop is a tap: it selects, moves nothing, re-rolls nothing", (t) => {
    const rng = { v: 0 };
    const dom = onHouse(t, rng);
    houseSvgOf(dom).rect = { ...DESK };
    const home = anchors(dom);
    rng.v = 0.999;
    const g = stickerFor(dom, "Window");
    const [cx, cy] = toClient(DESK, translateOf(g));
    pointer(g, "pointerdown", [cx, cy]);
    pointer(g, "pointermove", [cx + 3, cy]);
    pointer(g, "pointerup", [cx + 3, cy]);
    g.dispatchEvent(makeEvent("click"));
    assert.deepEqual(allParts(dom), composed(0), "a tap never re-rolls");
    assertAnchored(dom, home, "after a tap");
    assert.deepEqual(selected(dom), ["Window"]);
  });

  test("a 375px touch drag of the Doormat onto the Window box swaps them", (t) => {
    const dom = onHouse(t);
    dom.win.innerWidth = 375;
    const parts = allParts(dom);
    const { move } = drag(dom, "Doormat", CENTRE.Window, { rect: PHONE, pointerType: "touch" });
    assert.equal(move.defaultPrevented, true, "the touch move does not scroll the page");
    assert.deepEqual(allParts(dom), swapped(parts, 0, 4));
    assert.deepEqual(selected(dom), ["Window"]);
  });
});

// Covers: MEM-130
// Requirement: a click, a tap (pointerdown, pointerup, click), Enter or Space on a g.tour-sticker selects it and
// never re-rolls: one sticker at a time carries is-selected and aria-pressed="true", the rest aria-pressed="false".
// On a focused sticker ArrowRight/ArrowDown swaps it with the next spot and ArrowLeft/ArrowUp with the previous
// one (defaultPrevented), focus following the moved sticker; an arrow past either end does nothing.
describe("selecting and keyboard-moving step 3 stickers (MEM-130)", () => {
  test("no sticker starts selected; every sticker is a toggle button with aria-pressed=false", (t) => {
    const dom = onHouse(t);
    assert.deepEqual(pressed(dom), HOUSE_SPOTS.map(() => "false"));
    assert.deepEqual(selected(dom), []);
  });

  test("click, tap, Enter and Space each select one sticker and never re-roll", (t) => {
    const rng = { v: 0 };
    const dom = onHouse(t, rng);
    const icons = figIcons(dom);
    rng.v = 0.999;
    const check = (spot, how) => {
      assert.deepEqual(allParts(dom), composed(0), `${how} re-rolled a sticker`);
      assert.deepEqual(figIcons(dom), icons, `${how} changed a fig icon`);
      assert.deepEqual(selected(dom), [spot], `${how} selects ${spot} only`);
      assert.deepEqual(pressed(dom), HOUSE_SPOTS.map((s) => String(s === spot)), `${how}: aria-pressed`);
    };
    dom.click(stickerFor(dom, "Chew-toy throne"));
    check("Chew-toy throne", "click");
    const g = stickerFor(dom, "Window");
    pointer(g, "pointerdown", [10, 10]);
    pointer(g, "pointerup", [10, 10]);
    g.dispatchEvent(makeEvent("click"));
    check("Window", "tap");
    const enter = makeEvent("keydown", { key: "Enter" });
    stickerFor(dom, "Doormat").dispatchEvent(enter);
    check("Doormat", "Enter");
    assert.equal(enter.defaultPrevented, true, "Enter is defaultPrevented");
    const space = makeEvent("keydown", { key: " " });
    stickerFor(dom, "Water bowl").dispatchEvent(space);
    check("Water bowl", "Space");
    assert.equal(space.defaultPrevented, true, "Space does not scroll the page");
  });

  test("ArrowRight/ArrowDown swap with the next spot, ArrowLeft/ArrowUp with the previous; focus follows", (t) => {
    const dom = onHouse(t);
    let want = allParts(dom);
    stickerFor(dom, "Doormat").focus();
    for (const [k, from, to] of [["ArrowRight", 0, 1], ["ArrowDown", 1, 2], ["ArrowLeft", 2, 1], ["ArrowUp", 1, 0]]) {
      const ev = dom.key(k);
      want = swapped(want, from, to);
      assert.equal(ev.defaultPrevented, true, `${k} is defaultPrevented`);
      assert.deepEqual(allParts(dom), want, `${k} on ${HOUSE_SPOTS[from]} swaps it with ${HOUSE_SPOTS[to]}`);
      assert.ok(dom.doc.activeElement === stickerFor(dom, HOUSE_SPOTS[to]),
        `${k}: focus follows to ${HOUSE_SPOTS[to]}, got ${dom.doc.activeElement?.getAttribute?.("aria-label")}`);
    }
  });

  test("ArrowLeft on the first spot and ArrowDown on the last do nothing", (t) => {
    const dom = onHouse(t);
    const parts = allParts(dom);
    stickerFor(dom, "Doormat").focus();
    dom.key("ArrowLeft");
    assert.deepEqual(allParts(dom), parts, "ArrowLeft at index 0 is a no-op");
    assert.ok(dom.doc.activeElement === stickerFor(dom, "Doormat"), "focus stays on the Doormat");
    stickerFor(dom, "Window").focus();
    dom.key("ArrowDown");
    assert.deepEqual(allParts(dom), parts, "ArrowDown on the last spot is a no-op");
    assert.ok(dom.doc.activeElement === stickerFor(dom, "Window"), "focus stays on the Window");
    assert.equal(undoBtn(dom).hidden, true, "a no-op arrow leaves nothing to undo");
  });
});

// Covers: MEM-130
// Requirement: "New sticker" (#tour-roll) re-rolls only the selected sticker, or all five when none is selected.
// "Undo" (#tour-roll-undo) shows only on step 3 and only while there is something to undo; each click restores
// the state before the latest re-roll or move (sticker and fig row icon), without rolling anything new; replaying
// the tour from Settings starts with nothing to undo.
describe("New sticker and Undo on step 3 (MEM-130)", () => {
  test("New sticker re-rolls only the selected sticker", (t) => {
    const rng = { v: 0 };
    const dom = onHouse(t, rng);
    rng.v = 0.999;
    dom.click(stickerFor(dom, "Chew-toy throne"));
    dom.click(dom.$("tour-roll"));
    const one = composed(0).map((p, i) => (i === 2 ? composed(0.999)[2] : p));
    assert.deepEqual(allParts(dom), one, "only the Chew-toy throne re-rolled");
    assert.deepEqual(figIcons(dom), one.map((p) => p.join("")), "its fig icon followed");
  });

  test("New sticker with no sticker selected re-rolls all five", (t) => {
    const rng = { v: 0 };
    const dom = onHouse(t, rng);
    rng.v = 0.999;
    dom.click(dom.$("tour-roll"));
    assert.deepEqual(allParts(dom), composed(0.999));
  });

  test("Undo is hidden on step 3 until something changes, then hidden off step 3, shown again on Back", (t) => {
    const dom = onHouse(t);
    const undo = undoBtn(dom);
    assert.equal(undo.hidden, true, "nothing to undo yet");
    assert.equal(undo.textContent, "Undo");
    dom.click(dom.$("tour-roll"));
    assert.equal(undo.hidden, false, "Undo shows after a re-roll");
    next(dom);
    assert.equal(undo.hidden, true, "Undo hidden on step 4");
    dom.click(dom.$("tour-back"));
    assert.equal(undo.hidden, false, "Undo back on step 3 with the stack kept");
  });

  test("each Undo restores the state before the latest re-roll or move, newest first, then hides", (t) => {
    const rng = { v: 0 };
    const dom = onHouse(t, rng);
    const s0 = allParts(dom);
    rng.v = 0.999;
    dom.click(dom.$("tour-roll"));
    const s1 = allParts(dom);
    assert.deepEqual(s1, composed(0.999), "fixture: New sticker re-rolled all five");
    drag(dom, "Doormat", CENTRE.Window);
    const s2 = allParts(dom);
    assert.deepEqual(s2, swapped(s1, 0, 4), "fixture: the drag swapped Doormat and Window");
    stickerFor(dom, "Water bowl").focus();
    dom.key("ArrowRight");
    assert.deepEqual(allParts(dom), swapped(s2, 1, 2), "fixture: ArrowRight swapped Water bowl and Chew-toy throne");
    rng.v = 0.5;
    for (const [want, what] of [[s2, "the arrow move"], [s1, "the drag"], [s0, "the re-roll"]]) {
      assert.equal(undoBtn(dom).hidden, false, `Undo visible before undoing ${what}`);
      dom.click(undoBtn(dom));
      assert.deepEqual(allParts(dom), want, `Undo reverts ${what}`);
      assert.deepEqual(figIcons(dom), want.map((p) => p.join("")), `fig icons follow the Undo of ${what}`);
    }
    assert.equal(undoBtn(dom).hidden, true, "nothing left to undo");
  });

  test("replaying the tour from Settings starts step 3 with nothing to undo", (t) => {
    const dom = onHouse(t);
    dom.click(dom.$("tour-roll"));
    assert.equal(undoBtn(dom).hidden, false, "fixture: Undo shows after a re-roll");
    dom.click(dom.$("tour-skip"));
    dom.click(dom.$("tour-replay"));
    next(dom, 2);
    assert.equal(undoBtn(dom).hidden, true, "replay clears the undo stack");
  });
});

// Covers: MEM-130
// Requirement: tour.css lets a sticker be dragged on touch screens and shows the drag affordance: .tour-sticker
// has touch-action: none and cursor: grab, a dragged sticker (.is-dragging) cursor: grabbing, and a selected
// sticker (.tour-sticker.is-selected) is marked with a design-token colour (var(--...)), never a hex literal.
// STEPS[2].after tells the user how: drag a sticker onto another spot, or tap New sticker.
describe("tour sticker drag styles and copy (MEM-130)", () => {
  const css = readFileSync(new URL("./tour.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(([, sel, body]) => ({ sels: sel.split(",").map((s) => s.trim()), body }));
  const bodiesWhere = (pred) => rules.filter((r) => r.sels.some(pred)).map((r) => r.body).join("\n");

  test(".tour-sticker has touch-action: none and cursor: grab", () => {
    const body = bodiesWhere((s) => /(^|[\s>])\.tour-sticker$/.test(s));
    assert.match(body, /touch-action\s*:\s*none/, ".tour-sticker touch-action: none");
    assert.match(body, /cursor\s*:\s*grab\s*(;|$)/m, ".tour-sticker cursor: grab");
  });

  test(".is-dragging sets cursor: grabbing", () => {
    assert.match(bodiesWhere((s) => s.includes(".is-dragging")), /cursor\s*:\s*grabbing/);
  });

  test(".tour-sticker.is-selected is styled with a var(--...) token and no hex colour", () => {
    const body = bodiesWhere((s) => s.includes(".tour-sticker.is-selected"));
    assert.ok(body.trim(), "no .tour-sticker.is-selected rule in tour.css");
    assert.match(body, /var\(--[\w-]+\)/, "selected sticker uses a design token");
    assert.doesNotMatch(body, /#[0-9a-f]{3,8}\b/i, "selected sticker uses tokens, not hex colours");
  });

  test("STEPS[2].after explains drag and New sticker", () => {
    assert.equal(need("STEPS")[2].after,
      "I break each item into keywords and mash their emoji into one sticker. "
      + "Drag a sticker onto another spot, or tap New sticker for a fresh one.");
  });
});
