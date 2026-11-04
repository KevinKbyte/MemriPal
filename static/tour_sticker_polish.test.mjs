import { describe, test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { makeTourDom } from "./tour_fake_dom_test.mjs";

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

/** In-memory store; `writes` lists every setItem call. */
function memStore(init = {}) {
  const data = new Map(Object.entries(init));
  const writes = [];
  return {
    data, writes,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { writes.push([k, v]); data.set(k, String(v)); },
  };
}

function wire(store = memStore()) {
  const dom = makeTourDom();
  need("wireTour")(dom.doc, store);
  return dom;
}

const stepN = (dom) => dom.$("tour-n").textContent;
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
const rolling = (dom, spot) => stickerFor(dom, spot).classList.contains("is-rolling");
/** A readable name for the focused element: its id, else its aria-label. */
const focusName = (dom) => {
  const a = dom.doc.activeElement;
  return a?.id || a?.getAttribute?.("aria-label") || String(a?.tagName);
};

/** Wire the tour with Math.random returning `rng.v` (mutable), then go to step 3. */
function onHouse(t, rng = { v: 0 }) {
  t.mock.method(Math, "random", () => rng.v);
  const dom = wire();
  next(dom, 2);
  return dom;
}

beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
afterEach(() => mock.timers.reset());

// Covers: MEM-109, MEM-131
// Requirement: MEM-109 amends MEM-117. On step 3 the focus trap cycles the card's visible buttons AND its
// g.tour-sticker badges in document order: Skip, the five stickers in walk order (Doormat, Water bowl, Chew-toy
// throne, Scratching post, Window), New sticker ("Roll all" before MEM-131), Back, Next, then wraps; Shift+Tab
// walks the same ring backwards. Each trapped Tab is defaultPrevented. Since MEM-131 Enter or Space on a sticker
// reached by Tab selects that sticker (aria-pressed="true") without re-rolling anything, and focus stays on it.
describe("step 3 stickers are reachable by keyboard (MEM-109)", () => {
  const RING = ["tour-skip", ...HOUSE_SPOTS.map((s) => `Sticker on ${s}`), "tour-roll", "tour-back", "tour-next"];

  test("Tab from Next visits Skip, the 5 stickers in walk order, New sticker, Back, then Next again", (t) => {
    const dom = onHouse(t);
    assert.equal(focusName(dom), "tour-next", "Next has focus on step 3");
    RING.forEach((want, n) => {
      const ev = dom.key("Tab");
      assert.equal(ev.defaultPrevented, true, `Tab ${n + 1} is trapped (defaultPrevented)`);
      assert.equal(focusName(dom), want, `Tab ${n + 1} from Next lands on ${want}`);
    });
  });

  test("Shift+Tab from Skip wraps to Next; Shift+Tab from the Doormat sticker goes to Skip", (t) => {
    const dom = onHouse(t);
    dom.$("tour-skip").focus();
    const ev = dom.key("Tab", { shiftKey: true });
    assert.equal(ev.defaultPrevented, true, "Shift+Tab is trapped");
    assert.equal(focusName(dom), "tour-next", "Shift+Tab from Skip wraps to Next");
    stickerFor(dom, "Doormat").focus();
    dom.key("Tab", { shiftKey: true });
    assert.equal(focusName(dom), "tour-skip", "Shift+Tab from the Doormat sticker goes to Skip");
  });

  test("Enter on a Tab-reached sticker selects it, re-rolls nothing, keeps focus; Space does the same next", (t) => {
    const rng = { v: 0 };
    const dom = onHouse(t, rng);
    const before = allParts(dom);
    dom.key("Tab");
    dom.key("Tab");
    const doormat = stickerFor(dom, "Doormat");
    assert.ok(dom.doc.activeElement === doormat, `two Tabs from Next reach the Doormat sticker, got ${focusName(dom)}`);
    rng.v = 0.999;
    dom.key("Enter");
    assert.deepEqual(allParts(dom), before, "Enter re-rolled nothing (MEM-131)");
    assert.equal(doormat.getAttribute("aria-pressed"), "true", "Enter selected the Doormat");
    assert.ok(dom.doc.activeElement === doormat, "focus stays on the Doormat sticker after Enter");

    rng.v = 0;
    dom.key("Tab");
    const bowl = stickerFor(dom, "Water bowl");
    assert.ok(dom.doc.activeElement === bowl, `Tab from Doormat reaches Water bowl, got ${focusName(dom)}`);
    rng.v = 0.999;
    dom.key(" ");
    assert.deepEqual(allParts(dom), before, "Space re-rolled nothing (MEM-131)");
    assert.equal(bowl.getAttribute("aria-pressed"), "true", "Space selected the Water bowl");
    assert.ok(dom.doc.activeElement === bowl, "focus stays on the Water bowl sticker after Space");
    assert.equal(stepN(dom), "3", "Enter/Space on a sticker does not change the step");
  });
});

// Covers: MEM-109, MEM-131
// Requirement: MEM-109 amends MEM-117. Re-rolling a sticker that is still spinning restarts the spin: tour.js
// removes is-rolling, forces a reflow (reads getBoundingClientRect) and adds is-rolling again, and the 300 ms
// clear timer restarts from the second roll. A second re-roll mid-spin still re-rolls the locus. Since MEM-131 a
// re-roll is the selected sticker plus New sticker (#tour-roll); a click on the sticker only selects it.
describe("re-rolling a sticker mid-spin restarts the spin (MEM-109)", () => {
  const SPOT = "Chew-toy throne";
  const I = HOUSE_SPOTS.indexOf(SPOT);

  test("second New sticker mid-roll: remove is-rolling, read the rect, add is-rolling; 300 ms restarts", (t) => {
    const dom = onHouse(t);
    const g = stickerFor(dom, SPOT);
    dom.click(g);
    dom.click(dom.$("tour-roll"));
    mock.timers.tick(200);
    assert.equal(rolling(dom, SPOT), true, "still spinning at 200 ms");
    const ops = [];
    const { add, remove } = g.classList;
    const rect = g.getBoundingClientRect.bind(g);
    t.mock.method(g.classList, "add", (...cs) => { ops.push(...cs.map((c) => `add:${c}`)); return add(...cs); });
    t.mock.method(g.classList, "remove", (...cs) => { ops.push(...cs.map((c) => `remove:${c}`)); return remove(...cs); });
    t.mock.method(g, "getBoundingClientRect", () => { ops.push("rect"); return rect(); });
    dom.click(dom.$("tour-roll"));
    const rm = ops.indexOf("remove:is-rolling");
    assert.ok(rm >= 0, `re-roll mid-spin removes is-rolling first; ops: ${JSON.stringify(ops)}`);
    const rd = ops.indexOf("rect", rm + 1);
    assert.ok(rd > rm, `then reads getBoundingClientRect to restart the animation; ops: ${JSON.stringify(ops)}`);
    const ad = ops.indexOf("add:is-rolling", rd + 1);
    assert.ok(ad > rd, `then adds is-rolling again; ops: ${JSON.stringify(ops)}`);
    mock.timers.tick(299);
    assert.equal(rolling(dom, SPOT), true, "still spinning 299 ms after the second click");
    mock.timers.tick(1);
    assert.equal(rolling(dom, SPOT), false, "done 300 ms after the second click");
  });

  test("a second New sticker mid-roll still re-rolls the selected locus", (t) => {
    const rng = { v: 0 };
    const dom = onHouse(t, rng);
    assert.notDeepEqual(composed(0)[I], composed(0.999)[I], "fixture: the two rolls differ for this locus");
    rng.v = 0.999;
    dom.click(stickerFor(dom, SPOT));
    assert.deepEqual(allParts(dom)[I], composed(0)[I], "selecting the sticker re-rolls nothing (MEM-131)");
    dom.click(dom.$("tour-roll"));
    assert.deepEqual(allParts(dom)[I], composed(0.999)[I], "first New sticker re-rolled");
    mock.timers.tick(100);
    rng.v = 0;
    dom.click(dom.$("tour-roll"));
    assert.deepEqual(allParts(dom)[I], composed(0)[I], "second New sticker mid-roll re-rolled again");
  });
});

// Covers: MEM-109
// Requirement: MEM-109 amends MEM-112 and MEM-117. Each tour run rolls its own stickers: replaying the tour
// from Settings (#tour-replay) re-rolls step 3's stickers fresh, while within one run Next then Back keeps them.
describe("replaying the tour re-rolls the stickers (MEM-109)", () => {
  test("replay shows fresh stickers on step 3; Next then Back keeps them within the run", (t) => {
    const rng = { v: 0 };
    t.mock.method(Math, "random", () => rng.v);
    const dom = wire(memStore());
    next(dom, 2);
    const first = allParts(dom);
    assert.deepEqual(first, composed(0), "first run rolls with rng 0");
    dom.click(dom.$("tour-skip"));
    assert.equal(dom.$("tour").hidden, true, "Skip closes the tour");
    rng.v = 0.999;
    dom.click(dom.$("tour-replay"));
    assert.equal(stepN(dom), "1", "replay opens at step 1");
    next(dom, 2);
    const second = allParts(dom);
    assert.deepEqual(second, composed(0.999), "replay re-rolls step 3's stickers fresh");
    assert.notDeepEqual(second, first, "replay stickers differ from the first run");
    rng.v = 0.5;
    next(dom);
    dom.click(dom.$("tour-back"));
    assert.deepEqual(allParts(dom), composed(0.999), "within the replay run, Next then Back keeps the rolls");
  });
});
