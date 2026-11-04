// Covers: MEM-055
// Requirement: while Pal's first-run tour is open, static/tour.js publishes the current step's target selector on
// body as data-tour-target ("" for target-less steps) so the Pal chat bubble can go inert without importing the
// tour; Skip, Escape and finishing the last step remove it, and Replay from Settings sets it again.
import { describe, test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { makeTourDom } from "./tour_fake_dom_test.mjs";

const mod = await import("./tour.js").catch((err) => ({ __missing: String(err) }));
const KEY = "memripal.tour.done";

function memStore(init = {}) {
  const data = new Map(Object.entries(init));
  return { data, getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => void data.set(k, String(v)) };
}
function wire(store = memStore()) {
  assert.equal(typeof mod.wireTour, "function", `static/tour.js must export wireTour (${mod.__missing ?? "not exported"})`);
  const dom = makeTourDom();
  mod.wireTour(dom.doc, store);
  return dom;
}
const next = (dom, times = 1) => { for (let i = 0; i < times; i++) dom.click(dom.$("tour-next")); };
const target = (dom) => dom.doc.body.dataset.tourTarget;

beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
afterEach(() => mock.timers.reset());

describe("tour publishes body data-tour-target (MEM-055)", () => {
  test('step 1 (no target): present and ""', () => {
    assert.equal(target(wire()), "");
  });

  test("Next to a targeted step: equals that step's target selector", () => {
    const dom = wire();
    next(dom, 6);
    assert.equal(target(dom), '.tab[href="#routes"]');
    next(dom);
    assert.equal(target(dom), ".drawer-handle");
  });

  test("not open (already done): attribute never set", () => {
    assert.equal(target(wire(memStore({ [KEY]: "1" }))), undefined);
  });

  test("Skip removes it", () => {
    const dom = wire();
    next(dom, 2);
    dom.click(dom.$("tour-skip"));
    assert.equal(target(dom), undefined);
  });

  test("Escape removes it", () => {
    const dom = wire();
    next(dom);
    dom.key("Escape");
    assert.equal(target(dom), undefined);
  });

  test("finishing the last step removes it", () => {
    const dom = wire();
    next(dom, 9);
    assert.notEqual(target(dom), undefined, "still open on the last step");
    next(dom);
    assert.equal(target(dom), undefined);
  });

  test("Replay sets it again, and Skip removes it again", () => {
    const dom = wire(memStore({ [KEY]: "1" }));
    dom.click(dom.$("tour-replay"));
    assert.equal(target(dom), "");
    dom.click(dom.$("tour-skip"));
    assert.equal(target(dom), undefined);
  });
});
