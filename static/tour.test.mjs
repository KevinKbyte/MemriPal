// Covers: MEM-095, MEM-112
// Requirement: Pal's first-run tour (static/tour.js). TOUR_KEY is "memripal.tour.done"; STEPS are the 10 steps of
// docs/design/tutorial/preview.js (same order, titles, bodies, `after` closers, fig rows, targets, button labels).
// wireTour(doc, store) opens the tour at step 1 when store.getItem(TOUR_KEY) is null/undefined, keeps it hidden
// for any stored value or when getItem throws. "N of 10" and one dot per step come from STEPS.length; Back is
// hidden on step 1; Next takes focus on every step and advances; Next on step 10 closes silently. Skip and Escape
// close and show #tour-toast ("Tour skipped. Replay it any time in Settings.") for 4 s. Every close stores
// TOUR_KEY = "1"; a throwing setItem still closes. Tab/Shift+Tab cycle only the card's visible buttons. A missing
// spotlight target gives a centred card with no cut-out. Step text is never parsed as HTML; tour.js is ASCII-only,
// uses no innerHTML and no network. MEM-112: #tour-replay switches to the routes tab (tabbar showTab), hides any
// toast and reopens the tour at step 1 whatever is stored; closing it again stores "1".
import { describe, test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { makeTourDom, makeEvent } from "./tour_fake_dom_test.mjs";

const mod = await import("./tour.js").catch((err) => ({ __missing: String(err) }));

function need(name) {
  assert.ok(name in mod, `static/tour.js must export ${name} (${mod.__missing ?? "not exported"})`);
  return mod[name];
}

const KEY = "memripal.tour.done";
const TOAST = "Tour skipped. Replay it any time in Settings.";

// The design preview's STEPS literal, evaluated with its E(codepoint) helper.
function previewSteps() {
  const src = readFileSync(new URL("../docs/design/tutorial/preview.js", import.meta.url), "utf8");
  const lit = src.match(/var STEPS = (\[[\s\S]*?\n {2}\]);/);
  assert.ok(lit, "docs/design/tutorial/preview.js has no `var STEPS = [...]` literal");
  return new Function("E", `return ${lit[1]};`)((cp) => String.fromCodePoint(cp));
}
const normRow = (r) => ({
  spot: r.spot, icon: r.icon ?? null, item: r.item, done: Boolean(r.done), faded: Boolean(r.faded),
  sub: r.sub ? r.sub.map(normRow) : null,
});
const normStep = (s) => ({
  target: s.target ?? null, story: Boolean(s.story), title: s.title, body: s.body, after: s.after ?? null,
  next: s.next, fig: s.fig ? s.fig.map(normRow) : null,
  house: s.house ? s.house.map((h) => ({ spot: h.spot, box: [...h.box] })) : null,
});

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

function wire(store = memStore(), opts) {
  const dom = makeTourDom(opts);
  need("wireTour")(dom.doc, store);
  return dom;
}

const tourShown = (dom) => !dom.$("tour").hidden;
const toastShown = (dom) => !dom.$("tour-toast").hidden;
const title = (dom) => dom.$("tour-title").textContent;
const stepN = (dom) => dom.$("tour-n").textContent;
const next = (dom, times = 1) => { for (let i = 0; i < times; i++) dom.click(dom.$("tour-next")); };
const dots = (dom) => dom.doc.querySelector(".tour-dots").children;

beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
afterEach(() => mock.timers.reset());

describe("tour.js exports TOUR_KEY and the 10 preview STEPS (MEM-095)", () => {
  test('TOUR_KEY is "memripal.tour.done"', () => {
    assert.equal(need("TOUR_KEY"), KEY);
  });

  test("STEPS equal the design preview's STEPS: order, titles, bodies, after, fig rows, targets, button labels", () => {
    const steps = need("STEPS");
    assert.ok(Array.isArray(steps), "STEPS is an array");
    assert.equal(steps.length, 10);
    assert.deepEqual(steps.map(normStep), previewSteps().map(normStep));
  });

  test("steps 1 and 7-10 carry the spec targets; steps 2-6 are story cards", () => {
    const steps = need("STEPS");
    assert.deepEqual(steps.map((s) => s.target ?? null),
      [null, null, null, null, null, null, '.tab[href="#routes"]', ".drawer-handle", '.tab[href="#recall"]',
        '.tab[href="#settings"]']);
    assert.deepEqual(steps.map((s) => Boolean(s.story)), [false, true, true, true, true, true, false, false, false, false]);
  });
});

// Covers: MEM-095
// Requirement: the tour opens once for a first-time visitor and never nags afterwards (stored value or
// unusable storage keeps it hidden).
describe("tour first-run gating (MEM-095)", () => {
  test("empty store: #tour visible at step 1 'Hi! I'm King Memri.', 1 of 10, Back hidden, Next says 'Show me'", () => {
    const dom = wire();
    assert.equal(tourShown(dom), true, "#tour visible");
    assert.equal(title(dom), "Hi! I'm King Memri.");
    assert.equal(stepN(dom), "1");
    assert.equal(dom.$("tour-total").textContent, "10");
    assert.equal(dom.$("tour-back").hidden, true, "Back hidden on step 1");
    assert.equal(dom.$("tour-next").textContent, "Show me");
    assert.equal(toastShown(dom), false, "no toast on open");
  });

  test('stored "1": #tour stays hidden', () => {
    assert.equal(tourShown(wire(memStore({ [KEY]: "1" }))), false);
  });

  test("any stored value (even an empty string) keeps #tour hidden", () => {
    for (const v of ["yes", "0", ""]) assert.equal(tourShown(wire(memStore({ [KEY]: v }))), false, `stored ${JSON.stringify(v)}`);
  });

  test("getItem returning undefined opens the tour like null", () => {
    const store = { getItem: () => undefined, setItem() {} };
    assert.equal(tourShown(wire(store)), true);
  });

  test("getItem throws: wireTour does not throw and #tour stays hidden", () => {
    const dom = makeTourDom();
    const store = { getItem: () => { throw new Error("SecurityError: storage disabled"); }, setItem() {} };
    assert.doesNotThrow(() => need("wireTour")(dom.doc, store));
    assert.equal(tourShown(dom), false);
  });
});

// Covers: MEM-095
// Requirement: Next walks all 10 steps showing each step's title, body, closer, figure and button label, with
// a "N of 10" count and one dot per step; Back returns a step; Next on the last step closes without a toast.
describe("tour step navigation (MEM-095)", () => {
  test("Next x9 reaches step 10 'Now let's build your palace' with 10 dots, only the 10th current", () => {
    const dom = wire();
    next(dom, 9);
    assert.equal(title(dom), "Now let's build your palace");
    assert.equal(stepN(dom), "10");
    assert.equal(dots(dom).length, 10, "one dot per step");
    assert.deepEqual([...dots(dom)].map((d) => d.classList.contains("is-current")),
      [false, false, false, false, false, false, false, false, false, true]);
    assert.equal(dom.$("tour-next").textContent, "Let's go");
  });

  test("every step shows its STEPS title, body, after closer (hidden when absent) and button label", () => {
    const steps = need("STEPS");
    const dom = wire();
    steps.forEach((s, i) => {
      if (i > 0) next(dom);
      assert.equal(stepN(dom), String(i + 1), `count on step ${i + 1}`);
      assert.equal(title(dom), s.title, `title on step ${i + 1}`);
      assert.equal(dom.$("tour-body").textContent, s.body, `body on step ${i + 1}`);
      assert.equal(dom.$("tour-after").hidden, !s.after, `#tour-after hidden iff no closer on step ${i + 1}`);
      if (s.after) assert.equal(dom.$("tour-after").textContent, s.after);
      assert.equal(dom.$("tour-next").textContent, s.next, `button label on step ${i + 1}`);
      assert.equal(dom.$("tour-fig").hidden, !s.fig, `#tour-fig hidden iff no figure on step ${i + 1}`);
    });
  });

  test("Back is visible from step 2 and returns to step 1", () => {
    const dom = wire();
    next(dom);
    assert.equal(dom.$("tour-back").hidden, false, "Back visible on step 2");
    dom.click(dom.$("tour-back"));
    assert.equal(stepN(dom), "1");
    assert.equal(title(dom), "Hi! I'm King Memri.");
    assert.equal(dom.$("tour-back").hidden, true);
  });

  test("step 3 figure lists the five Royal Shopping List rows", () => {
    const dom = wire();
    next(dom, 2);
    const rows = dom.$("tour-fig").children;
    assert.equal(rows.length, 5);
    ["sizzling bacon", "squeaking tennis ball", "dripping peanut butter", "belly-rub voucher", "spare paper crown"]
      .forEach((item, i) => assert.ok(rows[i].textContent.includes(item), `row ${i + 1} shows ${item}`));
  });

  test("step 5 figure shows the whole cart on the doormat with 5 nested sub rows", () => {
    const dom = wire();
    next(dom, 4);
    const fig = dom.$("tour-fig");
    assert.equal(fig.hidden, false, "#tour-fig visible");
    assert.equal(fig.children.length, 1, "one top-level row");
    const cart = fig.children[0];
    assert.ok(cart.textContent.includes("Doormat") && cart.textContent.includes("the whole cart"));
    const sub = cart.querySelectorAll("li");
    assert.equal(sub.length, 5, "5 sub rows");
    ["leash", "squeaky duck", "kibble", "dog shampoo", "four tennis balls"]
      .forEach((item, i) => assert.ok(sub[i].textContent.includes(item), `sub row ${i + 1} shows ${item}`));
  });

  test('Next on step 10 closes: #tour hidden, no toast, store has "1"', () => {
    const store = memStore();
    const dom = wire(store);
    next(dom, 10);
    assert.equal(tourShown(dom), false);
    assert.equal(toastShown(dom), false, "finishing shows no toast");
    assert.equal(store.data.get(KEY), "1");
  });

  test("a missing target element gives a centred card with no cut-out; a present one is spotlit", () => {
    const dom = wire(memStore(), { drawerHandle: false });
    const spot = dom.doc.querySelector(".tour-spot");
    assert.equal(spot.classList.contains("is-empty"), true, "welcome step (null target) has no cut-out");
    next(dom, 6);
    assert.equal(spot.classList.contains("is-empty"), false, "step 7 spotlights the Routes tab");
    next(dom);
    assert.equal(title(dom), "Your routes live here", "step 8 still shows without .drawer-handle");
    assert.equal(tourShown(dom), true);
    assert.equal(spot.classList.contains("is-empty"), true, "no .drawer-handle: no cut-out");
  });
});

// Covers: MEM-095
// Requirement: Skip and Escape close the tour and show a status toast that hides itself after 4 s; every close
// remembers the tour as done, and a storage failure never leaves the tour stuck open.
describe("tour close paths (MEM-095)", () => {
  test('Skip: #tour hidden, #tour-toast shown with its text, store has "1"', () => {
    const store = memStore();
    const dom = wire(store);
    next(dom, 2);
    dom.click(dom.$("tour-skip"));
    assert.equal(tourShown(dom), false);
    assert.equal(toastShown(dom), true);
    assert.equal(dom.$("tour-toast").textContent, TOAST);
    assert.equal(store.data.get(KEY), "1");
  });

  test('Escape: same as Skip (hidden, toast shown, store has "1")', () => {
    const store = memStore();
    const dom = wire(store);
    dom.key("Escape");
    assert.equal(tourShown(dom), false);
    assert.equal(toastShown(dom), true);
    assert.equal(dom.$("tour-toast").textContent, TOAST);
    assert.equal(store.data.get(KEY), "1");
  });

  test("the skip toast hides itself after 4 s", () => {
    const dom = wire();
    dom.click(dom.$("tour-skip"));
    mock.timers.tick(3999);
    assert.equal(toastShown(dom), true, "still shown at 3.999 s");
    mock.timers.tick(1);
    assert.equal(toastShown(dom), false, "hidden at 4 s");
  });

  test("Escape and Tab after the tour closed do nothing", () => {
    const dom = wire();
    next(dom, 10);
    assert.equal(dom.key("Escape").defaultPrevented, false);
    assert.equal(toastShown(dom), false, "no toast from Escape on a closed tour");
    assert.equal(dom.key("Tab").defaultPrevented, false, "Tab not trapped once closed");
  });

  test("setItem throws: Skip, Escape and finishing still close the tour", () => {
    const store = { getItem: () => null, setItem: () => { throw new Error("QuotaExceededError"); } };
    const skip = wire(store);
    skip.click(skip.$("tour-skip"));
    assert.equal(tourShown(skip), false, "Skip closes");
    const esc = wire(store);
    esc.key("Escape");
    assert.equal(tourShown(esc), false, "Escape closes");
    const done = wire(store);
    next(done, 10);
    assert.equal(tourShown(done), false, "finishing closes");
  });
});

// Covers: MEM-095
// Requirement: the tour is a modal dialog for keyboard users: Next takes focus on each step and Tab/Shift+Tab
// cycle only the card's visible buttons while it is open.
describe("tour focus (MEM-095)", () => {
  test("Next has focus on open and after every Next", () => {
    const dom = wire();
    for (let i = 0; i < 10; i++) {
      assert.equal(dom.doc.activeElement, dom.$("tour-next"), `focus on Next at step ${i + 1}`);
      if (i < 9) next(dom);
    }
  });

  test("step 1: Tab/Shift+Tab cycle Skip and Next only (Back is hidden)", () => {
    const dom = wire();
    const ev = dom.key("Tab");
    assert.equal(ev.defaultPrevented, true, "Tab handled by the trap");
    assert.equal(dom.doc.activeElement, dom.$("tour-skip"), "Tab from Next wraps to Skip");
    dom.key("Tab");
    assert.equal(dom.doc.activeElement, dom.$("tour-next"), "Tab from Skip goes to Next, skipping hidden Back");
    dom.key("Tab", { shiftKey: true });
    assert.equal(dom.doc.activeElement, dom.$("tour-skip"), "Shift+Tab from Next goes to Skip");
  });

  test("step 2: Tab order Skip -> Back -> Next -> Skip; Shift+Tab reverses", () => {
    const dom = wire();
    next(dom);
    dom.key("Tab");
    assert.equal(dom.doc.activeElement, dom.$("tour-skip"));
    dom.key("Tab");
    assert.equal(dom.doc.activeElement, dom.$("tour-back"));
    dom.key("Tab");
    assert.equal(dom.doc.activeElement, dom.$("tour-next"));
    dom.key("Tab", { shiftKey: true });
    assert.equal(dom.doc.activeElement, dom.$("tour-back"));
  });
});

// Covers: MEM-095
// Requirement: step text is shown as text, never parsed as HTML; tour.js stays ASCII-only, uses no innerHTML,
// makes no network calls and adds no dependency.
describe("tour text safety and source rules (MEM-095)", () => {
  test("a step body containing <b> renders as literal text with no element created", () => {
    const steps = need("STEPS");
    const saved = { title: steps[0].title, body: steps[0].body };
    try {
      steps[0].title = "<b>Hi</b>";
      steps[0].body = "I am <b>bold</b> & <i>brave</i>";
      const dom = wire();
      assert.equal(title(dom), "<b>Hi</b>");
      assert.equal(dom.$("tour-body").textContent, "I am <b>bold</b> & <i>brave</i>");
      assert.equal(dom.$("tour-body").children.length, 0, "no element parsed out of the body");
      assert.equal(dom.$("tour-title").children.length, 0, "no element parsed out of the title");
    } finally {
      Object.assign(steps[0], saved);
    }
  });

  test("tour.js is ASCII-only, has no innerHTML/outerHTML/insertAdjacentHTML, no network, only relative imports", () => {
    const url = new URL("./tour.js", import.meta.url);
    assert.ok(existsSync(url), "static/tour.js exists");
    const bytes = readFileSync(url);
    const high = [...bytes].findIndex((b) => b > 0x7f);
    assert.equal(high, -1, `non-ASCII byte at offset ${high}`);
    const src = bytes.toString("utf8");
    assert.doesNotMatch(src, /\b(innerHTML|outerHTML|insertAdjacentHTML)\b/);
    assert.doesNotMatch(src, /\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource/);
    for (const [, spec] of src.matchAll(/\bimport\b[^"']*["']([^"']+)["']/g)) {
      assert.match(spec, /^\.\//, `import "${spec}" is not a relative ./ module`);
    }
  });

  test("static/tour.css exists and styles the tour classes tour.js toggles", () => {
    const url = new URL("./tour.css", import.meta.url);
    assert.ok(existsSync(url), "static/tour.css exists");
    const css = readFileSync(url, "utf8");
    for (const sel of [".tour-spot", ".tour-card", ".tour-dots", ".tour-toast", ".is-empty", ".is-current", ".fig-sub"]) {
      assert.ok(css.includes(sel), `tour.css styles ${sel}`);
    }
  });

  test("app.js imports wireTour from ./tour.js and calls wireTour(document, ...)", () => {
    const src = readFileSync(new URL("./app.js", import.meta.url), "utf8");
    assert.match(src, /import\s*\{[^}]*\bwireTour\b[^}]*\}\s*from\s*["']\.\/tour\.js["']/, "no wireTour import from ./tour.js");
    assert.match(src, /\bwireTour\(\s*document\s*,/, "wireTour(document, store) never called");
  });
});

// Covers: MEM-112
// Requirement: Settings' "Replay Pal's tour" button brings back the tour from step 1 on the routes tab, whatever
// is stored, clearing any skip toast; closing it again remembers the tour as done.
describe("replay Pal's tour from Settings (MEM-112)", () => {
  test('stored "1": click #tour-replay -> #tour at step 1, #tab-routes shown, #tab-settings hidden', () => {
    const dom = wire(memStore({ [KEY]: "1" }), { tab: "settings" });
    assert.equal(tourShown(dom), false, "hidden before replay");
    dom.click(dom.$("tour-replay"));
    assert.equal(tourShown(dom), true);
    assert.equal(stepN(dom), "1");
    assert.equal(title(dom), "Hi! I'm King Memri.");
    assert.equal(dom.$("tab-routes").hidden, false, "#tab-routes shown");
    assert.equal(dom.$("tab-settings").hidden, true, "#tab-settings hidden");
    assert.equal(dom.doc.querySelector('a.tab[href="#routes"]').getAttribute("aria-current"), "page");
    assert.equal(dom.doc.querySelector('a.tab[href="#settings"]').getAttribute("aria-current"), null);
    assert.equal(dom.doc.activeElement, dom.$("tour-next"), "Next takes focus");
  });

  test('Skip after replay hides the tour again and stores "1"', () => {
    const store = memStore({ [KEY]: "1" });
    const dom = wire(store, { tab: "settings" });
    dom.click(dom.$("tour-replay"));
    dom.click(dom.$("tour-skip"));
    assert.equal(tourShown(dom), false);
    assert.deepEqual(store.writes, [[KEY, "1"]]);
  });

  test("replay restarts at step 1 and hides a showing skip toast", () => {
    const dom = wire();
    next(dom, 4);
    dom.click(dom.$("tour-skip"));
    assert.equal(toastShown(dom), true);
    dom.click(dom.$("tour-replay"));
    assert.equal(toastShown(dom), false, "toast hidden on replay");
    assert.equal(stepN(dom), "1");
    assert.equal(dom.$("tour-back").hidden, true);
    mock.timers.tick(4000);
    assert.equal(tourShown(dom), true, "the old toast timer does not close the replayed tour");
  });

  test("replay opens even when getItem throws", () => {
    const dom = wire({ getItem: () => { throw new Error("storage disabled"); }, setItem() {} });
    dom.click(dom.$("tour-replay"));
    assert.equal(tourShown(dom), true);
  });
});

// Covers: MEM-095
// Requirement: MEM-095 amend 2026-11-04. Step 3 carries `house: [{spot, box: [x, y, w, h]}]`, the 5 dog-house
// spots in walk order (Doormat, Water bowl, Chew-toy throne, Scratching post, Window). #tour-house shows one SVG
// (createElementNS, SVG namespace, viewBox "0 0 320 200") with an .o-under + .o-line rect per box, an .o-label
// naming each spot, a .pin numbered 1-5 at each box's top-left and one .route-line polyline through the box
// centres in order. Every box lies inside the viewBox; no two non-adjacent route segments intersect. Steps
// without `house` hide and empty #tour-house.
const SVG_NS = "http://www.w3.org/2000/svg";
const HOUSE_SPOTS = ["Doormat", "Water bowl", "Chew-toy throne", "Scratching post", "Window"];
const num = (e, k) => Number(e.getAttribute(k));
const centre = (b) => [b[0] + b[2] / 2, b[1] + b[3] / 2];

/** Proper or touching intersection of segments ab and cd (orientation test, collinear overlap included). */
function segmentsIntersect([a, b], [c, d]) {
  const orient = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  const onSeg = (p, q, r) => Math.min(p[0], r[0]) <= q[0] && q[0] <= Math.max(p[0], r[0])
    && Math.min(p[1], r[1]) <= q[1] && q[1] <= Math.max(p[1], r[1]);
  const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  return (o1 === 0 && onSeg(a, c, b)) || (o2 === 0 && onSeg(a, d, b))
    || (o3 === 0 && onSeg(c, a, d)) || (o4 === 0 && onSeg(c, b, d));
}

/** Pairs [i, j] of route segments that are not neighbours and intersect. */
function selfCrossings(points) {
  const segs = points.slice(1).map((p, i) => [points[i], p]);
  const bad = [];
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 2; j < segs.length; j++) if (segmentsIntersect(segs[i], segs[j])) bad.push([i + 1, j + 1]);
  }
  return bad;
}

describe("step 3 dog house: segmented spots, numbered pins, route (MEM-095)", () => {
  const houseSvg = (dom) => dom.$("tour-house").querySelector("svg");

  test("the segment-intersection check itself: an X crosses, a C-shape does not", () => {
    assert.deepEqual(selfCrossings([[0, 0], [10, 10], [10, 0], [0, 10]]), [[1, 3]]);
    assert.deepEqual(selfCrossings([[10, 0], [0, 0], [0, 10], [10, 10]]), []);
  });

  test("STEPS[2].house names the 5 spots in walk order; boxes are [x, y, w, h] inside 320x200", () => {
    const house = need("STEPS")[2].house;
    assert.ok(Array.isArray(house), "step 3 has a house array");
    assert.deepEqual(house.map((h) => h.spot), HOUSE_SPOTS);
    for (const { spot, box } of house) {
      assert.equal(box.length, 4, `${spot} box has 4 numbers`);
      const [x, y, w, h] = box;
      assert.ok(w > 0 && h > 0 && x >= 0 && y >= 0 && x + w <= 320 && y + h <= 200, `${spot} box ${box} inside 320x200`);
    }
    assert.deepEqual(need("STEPS").map((s, i) => (s.house ? i : -1)).filter((i) => i >= 0), [2], "only step 3 has a house");
  });

  test("the route through the box centres in order never crosses itself", () => {
    const pts = need("STEPS")[2].house.map((h) => centre(h.box));
    assert.deepEqual(selfCrossings(pts), [], "non-adjacent route segments intersect");
  });

  test("step 3 shows #tour-house with one SVG-namespace svg, viewBox 0 0 320 200, labelled for screen readers", () => {
    const dom = wire();
    next(dom, 2);
    const box = dom.$("tour-house");
    assert.equal(box.hidden, false, "#tour-house visible on step 3");
    assert.equal(box.children.length, 1, "one child");
    const svg = houseSvg(dom);
    assert.ok(svg, "#tour-house holds an svg");
    assert.equal(svg.namespaceURI, SVG_NS, "svg built with createElementNS");
    assert.equal(svg.getAttribute("viewBox"), "0 0 320 200");
    assert.equal(svg.getAttribute("role"), "img");
    for (const spot of HOUSE_SPOTS) assert.ok(svg.getAttribute("aria-label").includes(spot), `aria-label names ${spot}`);
  });

  test("5 boxes: an .o-under and an .o-line rect at each spot's box, each with an .o-label naming its spot", () => {
    const dom = wire();
    next(dom, 2);
    const svg = houseSvg(dom);
    const house = need("STEPS")[2].house;
    for (const cls of ["o-under", "o-line"]) {
      const rects = svg.querySelectorAll(`rect.${cls}`);
      assert.equal(rects.length, 5, `5 rect.${cls}`);
      rects.forEach((r, i) => {
        assert.equal(r.namespaceURI, SVG_NS);
        assert.deepEqual(["x", "y", "width", "height"].map((k) => num(r, k)), house[i].box, `${cls} ${i + 1} at its box`);
        assert.ok(num(r, "rx") > 0, `${cls} ${i + 1} is rounded`);
      });
    }
    const labels = svg.querySelectorAll("text.o-label");
    assert.equal(labels.length, 5, "5 text.o-label");
    labels.forEach((t, i) => {
      const lines = t.querySelectorAll("tspan").map((s) => s.textContent);
      assert.equal(lines.length ? lines.join(" ") : t.textContent, HOUSE_SPOTS[i], `label ${i + 1}`);
      const [x, y, w, h] = house[i].box;
      assert.ok(num(t, "x") > x && num(t, "x") < x + w && num(t, "y") > y && num(t, "y") < y + h, `label ${i + 1} inside its box`);
    });
  });

  test("pins 1-5: a .pin circle at each box's top-left with its number, drawn after every box and label", () => {
    const dom = wire();
    next(dom, 2);
    const svg = houseSvg(dom);
    const house = need("STEPS")[2].house;
    const pins = svg.querySelectorAll("g.pin");
    assert.equal(pins.length, 5, "5 g.pin");
    pins.forEach((g, i) => {
      const c = g.querySelector("circle");
      const r = num(c, "r");
      assert.ok(r >= 8, `pin ${i + 1} radius ${r} >= 8 (legible)`);
      assert.equal(num(c, "cx"), Math.max(r + 1, house[i].box[0]), `pin ${i + 1} cx at box left`);
      assert.equal(num(c, "cy"), Math.max(r + 1, house[i].box[1]), `pin ${i + 1} cy at box top`);
      assert.equal(g.querySelector("text").textContent, String(i + 1));
    });
    const kids = svg.children;
    const lastShape = Math.max(...kids.map((k, n) => (/o-line|o-label/.test(k.getAttribute("class") ?? "") ? n : -1)));
    assert.ok(kids.indexOf(pins[0]) > lastShape, "pins paint over every box and label");
  });

  test("one .route-line polyline through the box centres in walk order, under the boxes", () => {
    const dom = wire();
    next(dom, 2);
    const svg = houseSvg(dom);
    const lines = svg.querySelectorAll("polyline.route-line");
    assert.equal(lines.length, 1, "one polyline.route-line");
    const pts = lines[0].getAttribute("points").trim().split(/\s+/).map((p) => p.split(",").map(Number));
    assert.deepEqual(pts, need("STEPS")[2].house.map((h) => centre(h.box)));
    assert.deepEqual(selfCrossings(pts), [], "rendered route crosses itself");
    assert.ok(svg.children.indexOf(lines[0]) < svg.children.indexOf(svg.querySelector("rect.o-line")), "route under boxes");
  });

  test("steps without a house hide and empty #tour-house; Back to step 3 redraws one svg", () => {
    const dom = wire();
    const box = dom.$("tour-house");
    assert.equal(box.hidden, true, "step 1");
    next(dom, 2);
    assert.equal(box.hidden, false, "step 3");
    next(dom);
    assert.equal(box.hidden, true, "step 4");
    assert.equal(box.children.length, 0, "step 4 leaves no svg behind");
    dom.click(dom.$("tour-back"));
    assert.equal(box.hidden, false);
    assert.equal(box.querySelectorAll("svg").length, 1, "one svg after Back");
  });

  test("tour.css styles the dog house with tokens: .tour-house, .o-line, .o-label, .pin, .route-line", () => {
    const css = readFileSync(new URL("./tour.css", import.meta.url), "utf8");
    for (const sel of [".tour-house", ".tour-house svg", ".o-under", ".o-line", ".o-label", ".pin circle", ".pin text",
      ".route-line"]) {
      assert.ok(css.includes(sel), `tour.css styles ${sel}`);
    }
    const house = css.slice(css.indexOf(".tour-house"));
    assert.match(house, /var\(--lamp\)/, "dog house uses --lamp");
    assert.match(house, /var\(--surface\)/, "dog house uses --surface");
    assert.doesNotMatch(house, /#[0-9a-f]{3,8}\b/i, "dog house uses tokens, not hex colours");
    assert.match(house, /\.tour-house svg\s*\{[^}]*width:\s*100%/, "svg scales to the card width");
  });
});

// Covers: MEM-117, MEM-131
// Requirement: MEM-117 amends MEM-095. Step 3's dog house gains a sticker per locus: houseFig appends 5
// g.tour-sticker after the pins, in walk order (SVG namespace, role=button, tabindex 0, aria-label
// "Sticker on <spot>" since MEM-131), each anchored at its box's top-right corner (x + w, y) clamped inside the 320x200 viewBox;
// its text children are stickers.compose(STEPS[2].fig[i].item).parts, the first in a larger font. Each step-3 fig
// row's icon shows the same parts joined and a .tour-kw caption gives the item's keywords joined by " + " (row 1
// "sizzling + bacon"). STEPS[2].after is "I break each item into keywords and mash their emoji into one sticker.
// Drag a sticker onto another spot, or tap New sticker for a fresh one." (MEM-131). Steps without a house show no
// sticker and no caption.
const stkMod = await import("./stickers.js").catch((err) => ({ __missing: String(err) }));

function needStk(name) {
  assert.ok(name in stkMod, `static/stickers.js must export ${name} (${stkMod.__missing ?? "not exported"})`);
  return stkMod[name];
}

const BREAKDOWN = "I break each item into keywords and mash their emoji into one sticker. "
  + "Drag a sticker onto another spot, or tap New sticker for a fresh one.";
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
const figIcons = (dom) => dom.$("tour-fig").children.map((li) => li.querySelector(".fig-icon")?.textContent);
const rolling = (dom, spot) => stickerFor(dom, spot).classList.contains("is-rolling");

/** Wire the tour with Math.random returning `rng.v` (mutable), then go to step 3. */
function onHouse(t, rng = { v: 0 }) {
  t.mock.method(Math, "random", () => rng.v);
  const dom = wire();
  next(dom, 2);
  return dom;
}

/** Position of a sticker text part in viewBox units: its x/y plus any translate() on its ancestors up to the svg. */
function partPos(t) {
  let [x, y] = [num(t, "x") || 0, num(t, "y") || 0];
  for (let n = t.parentNode; n && typeof n.getAttribute === "function"; n = n.parentNode) {
    const m = /translate\(\s*(-?[\d.]+)(?:[\s,]+(-?[\d.]+))?\s*\)/.exec(n.getAttribute("transform") ?? "");
    if (m) { x += Number(m[1]); y += Number(m[2] ?? 0); }
    if (String(n.tagName).toLowerCase() === "svg") break;
  }
  return [x, y];
}
const inView = ([x, y]) => x >= 0 && x <= 320 && y >= 0 && y <= 200;

describe("step 3 stickers on Pal's dog house (MEM-117)", () => {
  test("still 10 steps; step 3's closer is the keyword breakdown", () => {
    const steps = need("STEPS");
    assert.equal(steps.length, 10);
    assert.equal(steps[2].after, BREAKDOWN);
  });

  test("5 g.tour-sticker in walk order, drawn after every pin, SVG namespace, role=button, tabindex 0", (t) => {
    const svg = houseSvgOf(onHouse(t));
    const kids = svg.children;
    const at = (cls) => kids.map((k, n) => (k.classList.contains(cls) ? n : -1)).filter((n) => n >= 0);
    assert.equal(at("tour-sticker").length, 5, "5 g.tour-sticker as direct children of the house svg");
    assert.ok(Math.min(...at("tour-sticker")) > Math.max(...at("pin")), "every sticker comes after every pin");
    const gs = svg.querySelectorAll("g.tour-sticker");
    assert.deepEqual(gs.map((g) => g.getAttribute("aria-label")), HOUSE_SPOTS.map((s) => `Sticker on ${s}`));
    for (const g of gs) {
      assert.equal(g.namespaceURI, SVG_NS, "sticker built with createElementNS");
      assert.equal(g.getAttribute("role"), "button");
      assert.equal(g.getAttribute("tabindex"), "0");
      for (const p of g.querySelectorAll("text")) assert.equal(p.namespaceURI, SVG_NS, "sticker part in the SVG namespace");
    }
  });

  test("each sticker's text children are compose(fig item).parts; the first part has the largest font-size", (t) => {
    const dom = onHouse(t);
    assert.deepEqual(allParts(dom), composed(0));
    let layered = 0;
    for (const spot of HOUSE_SPOTS) {
      const [first, ...rest] = stickerFor(dom, spot).querySelectorAll("text");
      if (rest.length) layered++;
      for (const r of rest) {
        assert.ok(num(first, "font-size") > num(r, "font-size"),
          `${spot}: first part font-size ${first.getAttribute("font-size")} not above ${r.getAttribute("font-size")}`);
      }
    }
    assert.ok(layered >= 1, "at least one sticker merges 2+ emoji");
  });

  test("each sticker sits at its box's top-right corner and every part lies inside the 320x200 viewBox", (t) => {
    const dom = onHouse(t);
    need("STEPS")[2].house.forEach(({ spot, box: [x, y, w] }) => {
      const parts = stickerFor(dom, spot).querySelectorAll("text");
      const [px, py] = partPos(parts[0]);
      assert.ok(Math.abs(px - (x + w)) <= 16 && Math.abs(py - y) <= 16,
        `${spot} sticker at (${px}, ${py}), box top-right (${x + w}, ${y})`);
      for (const p of parts) assert.ok(inView(partPos(p)), `${spot} part at ${partPos(p)} leaves the viewBox`);
    });
  });

  test("a box touching the viewBox's top-right corner gets its sticker clamped inside", (t) => {
    const box = need("STEPS")[2].house[4].box;
    const saved = [...box];
    try {
      box.splice(0, 4, 268, 0, 52, 30);
      const parts = stickerFor(onHouse(t), "Window").querySelectorAll("text");
      const [px, py] = partPos(parts[0]);
      assert.ok(px < 320 && py > 0, `corner sticker at (${px}, ${py}) not pulled inside`);
      for (const p of parts) assert.ok(inView(partPos(p)), `Window part at ${partPos(p)} leaves the viewBox`);
    } finally {
      box.splice(0, 4, ...saved);
    }
  });

  test("step 3 fig rows: icon = the sticker's parts joined; one .tour-kw caption = keywords joined by ' + '", (t) => {
    const dom = onHouse(t);
    const rows = dom.$("tour-fig").children;
    assert.equal(rows.length, 5);
    assert.deepEqual(figIcons(dom), composed(0).map((p) => p.join("")));
    const caps = rows.map((li) => li.querySelectorAll(".tour-kw").map((k) => k.textContent));
    assert.deepEqual(caps, figItems().map((item) => [needStk("keywords")(item).join(" + ")]));
    assert.deepEqual(caps[0], ["sizzling + bacon"]);
  });

  test("steps without a house show no sticker and no .tour-kw; step 4 icons stay its STEPS icons", () => {
    const steps = need("STEPS");
    const dom = wire();
    steps.forEach((s, i) => {
      if (i > 0) next(dom);
      if (i === 2) return;
      assert.equal(dom.doc.querySelectorAll("g.tour-sticker").length, 0, `step ${i + 1} has a sticker`);
      assert.equal(dom.doc.querySelectorAll(".tour-kw").length, 0, `step ${i + 1} has a .tour-kw caption`);
      if (i === 3) assert.deepEqual(figIcons(dom), s.fig.map((r) => r.icon), "step 4 icons");
    });
  });
});

// Covers: MEM-117, MEM-131
// Requirement: "New sticker" (#tour-roll, in .tour-actions; "Roll all" before MEM-131) shows only on the house
// step and re-rolls every locus when no sticker is selected. Since MEM-131 a click or Enter/Space on one
// g.tour-sticker only selects it (never re-rolls); New sticker then re-rolls that locus only (sticker and fig row
// icon); a re-rolled sticker carries is-rolling for 300 ms; rolls are kept while the tour is open (Next then
// Back); #tour-roll joins the focus trap's visible buttons. tour.css styles .tour-sticker, .tour-kw and .is-rolling and turns the roll
// animation off under prefers-reduced-motion: reduce.
describe("rolling stickers on step 3 (MEM-117)", () => {
  test("#tour-roll 'New sticker' is visible on step 3 only", () => {
    const steps = need("STEPS");
    const dom = wire();
    const roll = dom.$("tour-roll");
    steps.forEach((_, i) => {
      if (i > 0) next(dom);
      assert.equal(roll.hidden, i !== 2, `#tour-roll hidden on step ${i + 1}: ${roll.hidden}`);
    });
    assert.equal(roll.textContent, "New sticker");
  });

  test("New sticker with none selected re-rolls every sticker and fig icon, stays on step 3, keeps 5/5/1", (t) => {
    const rng = { v: 0 };
    const dom = onHouse(t, rng);
    const before = allParts(dom);
    rng.v = 0.999;
    dom.click(dom.$("tour-roll"));
    assert.equal(stepN(dom), "3");
    const svg = houseSvgOf(dom);
    for (const [sel, n] of [["g.tour-sticker", 5], ["g.pin", 5], ["polyline.route-line", 1]]) {
      assert.equal(svg.querySelectorAll(sel).length, n, `${sel} after New sticker`);
    }
    const after = allParts(dom);
    assert.deepEqual(after, composed(0.999));
    HOUSE_SPOTS.forEach((s, i) => assert.notDeepEqual(after[i], before[i], `${s} sticker changed`));
    assert.deepEqual(figIcons(dom), composed(0.999).map((p) => p.join("")), "fig icons follow the roll");
  });

  test("clicking one sticker never re-rolls it; New sticker then re-rolls only that locus and its fig icon", (t) => {
    const rng = { v: 0 };
    const dom = onHouse(t, rng);
    const before = allParts(dom);
    const iconsBefore = figIcons(dom);
    rng.v = 0.999;
    dom.click(stickerFor(dom, "Chew-toy throne"));
    assert.deepEqual(allParts(dom), before, "a click on a sticker selects it and re-rolls nothing");
    assert.deepEqual(figIcons(dom), iconsBefore, "a click on a sticker leaves every fig icon");
    dom.click(dom.$("tour-roll"));
    const after = allParts(dom);
    assert.deepEqual(after[2], composed(0.999)[2], "Chew-toy throne re-rolled");
    assert.notDeepEqual(after[2], before[2], "Chew-toy throne sticker changed");
    for (const i of [0, 1, 3, 4]) assert.deepEqual(after[i], before[i], `${HOUSE_SPOTS[i]} untouched`);
    const icons = figIcons(dom);
    assert.equal(icons[2], composed(0.999)[2].join(""), "row 3 icon follows its sticker");
    for (const i of [0, 1, 3, 4]) assert.equal(icons[i], iconsBefore[i], `row ${i + 1} icon untouched`);
    assert.equal(houseSvgOf(dom).querySelectorAll("g.tour-sticker").length, 5);
  });

  test("Enter and Space on a sticker select it and never re-roll (MEM-131)", (t) => {
    const rng = { v: 0 };
    const dom = onHouse(t, rng);
    const before = allParts(dom);
    rng.v = 0.999;
    stickerFor(dom, "Doormat").dispatchEvent(makeEvent("keydown", { key: "Enter" }));
    assert.deepEqual(allParts(dom), before, "Enter re-rolled nothing");
    assert.equal(stickerFor(dom, "Doormat").getAttribute("aria-pressed"), "true", "Enter selected the Doormat");
    stickerFor(dom, "Window").dispatchEvent(makeEvent("keydown", { key: " " }));
    assert.deepEqual(allParts(dom), before, "Space re-rolled nothing");
    assert.equal(stickerFor(dom, "Window").getAttribute("aria-pressed"), "true", "Space selected the Window");
    assert.deepEqual(allParts(dom), composed(0), "every sticker keeps its first roll");
    assert.equal(stepN(dom), "3", "Enter/Space on a sticker does not change the step");
  });

  test("a re-rolled sticker carries is-rolling for 300 ms; the others never do", (t) => {
    const dom = onHouse(t);
    dom.click(stickerFor(dom, "Water bowl"));
    assert.equal(rolling(dom, "Water bowl"), false, "selecting a sticker does not spin it (MEM-131)");
    dom.click(dom.$("tour-roll"));
    assert.equal(rolling(dom, "Water bowl"), true, "is-rolling on New sticker");
    for (const s of HOUSE_SPOTS.filter((x) => x !== "Water bowl")) assert.equal(rolling(dom, s), false, `${s} not rolling`);
    mock.timers.tick(299);
    assert.equal(rolling(dom, "Water bowl"), true, "still rolling at 299 ms");
    mock.timers.tick(1);
    assert.equal(rolling(dom, "Water bowl"), false, "done at 300 ms");
  });

  test("New sticker with none selected marks every sticker is-rolling, cleared after 300 ms", (t) => {
    const dom = onHouse(t);
    dom.click(dom.$("tour-roll"));
    for (const s of HOUSE_SPOTS) assert.equal(rolling(dom, s), true, `${s} rolling`);
    mock.timers.tick(300);
    for (const s of HOUSE_SPOTS) assert.equal(rolling(dom, s), false, `${s} done`);
  });

  test("rolls are kept while the tour is open: Next then Back shows the same stickers and icons", (t) => {
    const rng = { v: 0.999 };
    const dom = onHouse(t, rng);
    rng.v = 0;
    dom.click(dom.$("tour-roll"));
    const rolled = allParts(dom);
    const icons = figIcons(dom);
    rng.v = 0.5;
    next(dom);
    dom.click(dom.$("tour-back"));
    assert.deepEqual(allParts(dom), rolled);
    assert.deepEqual(figIcons(dom), icons);
  });

  test("focus trap: step 3 Shift+Tab from Next reaches Back then New sticker; step 4 skips the hidden one", () => {
    const dom = wire();
    next(dom, 2);
    assert.equal(dom.doc.activeElement?.id, "tour-next");
    dom.key("Tab", { shiftKey: true });
    assert.equal(dom.doc.activeElement?.id, "tour-back");
    dom.key("Tab", { shiftKey: true });
    assert.equal(dom.doc.activeElement?.id, "tour-roll", "Shift+Tab from Back reaches #tour-roll");
    next(dom);
    dom.key("Tab", { shiftKey: true });
    dom.key("Tab", { shiftKey: true });
    assert.equal(dom.doc.activeElement?.id, "tour-skip", "step 4: Shift+Tab from Back skips the hidden #tour-roll");
  });

  test("tour.css styles .tour-sticker, .tour-kw and .is-rolling; reduced motion turns .is-rolling off", () => {
    const css = readFileSync(new URL("./tour.css", import.meta.url), "utf8");
    for (const sel of [".tour-sticker", ".tour-kw", ".is-rolling"]) assert.ok(css.includes(sel), `tour.css styles ${sel}`);
    const blocks = [...css.matchAll(/@media[^{]*prefers-reduced-motion\s*:\s*reduce[^{]*\{([\s\S]*?)\n\}/g)].map((m) => m[1]);
    assert.ok(blocks.some((b) => b.includes(".is-rolling")), "no prefers-reduced-motion: reduce rule for .is-rolling");
  });
});
