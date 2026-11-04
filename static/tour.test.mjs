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
import { makeTourDom } from "./tour_fake_dom_test.mjs";

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
