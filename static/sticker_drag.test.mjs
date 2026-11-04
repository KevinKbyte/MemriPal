// Covers: MEM-130
// Requirement: static/sticker_drag.js is the shared press-drag-drop helper for placed stickers (tour dog house and
// photo sticker layer). A press that travels at least DRAG_SLOP_PX (6 CSS px) is a drag: the element gets
// .is-dragging, the move is defaultPrevented and onMove(x, y, ev) gets client coordinates; pointerup then calls
// onDrop(x, y) and clears .is-dragging. A press that stays inside the slop is a tap: onTap fires exactly once,
// even when the browser follows it with a click. Moves from another pointer are ignored; pointercancel calls
// onCancel and ends the gesture. boxDistance is 0 inside or on a box, else the distance to its nearest edge.
// nearestBox picks the smallest box containing the point, else the nearest box; ties keep the lower index;
// unusable boxes are skipped; no usable box -> -1.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { fakePage } from "./fake_dom_test.mjs";

const mod = await import("./sticker_drag.js").catch((err) => ({ __missing: String(err) }));

function api(name) {
  assert.ok(name in mod, `static/sticker_drag.js must export ${name} (${mod.__missing ?? "not exported"})`);
  return mod[name];
}

/** A fresh element wired with recording handlers. */
function wired(extra = {}) {
  const p = fakePage([]);
  const el = p.doc.createElement("div");
  const calls = { move: [], drop: [], tap: 0, cancel: 0 };
  api("wireDrag")(el, {
    onMove: (...a) => calls.move.push(a),
    onDrop: (...a) => calls.drop.push(a),
    onTap: () => {
      calls.tap += 1;
    },
    onCancel: () => {
      calls.cancel += 1;
    },
    ...extra,
  });
  const fire = (type, x, y, more = {}) =>
    p.fire(el, type, { pointerId: 1, clientX: x, clientY: y, button: 0, pointerType: "mouse", ...more });
  return { p, el, calls, fire };
}

const dragging = (el) => el.classList.contains("is-dragging");

/** Deterministic PRNG (mulberry32) so the property loop is reproducible. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Covers: MEM-130
// Requirement: the drag threshold is 6 CSS px; a press that moves less is a tap, one that moves more is a drag.
describe("sticker_drag DRAG_SLOP_PX (MEM-130)", () => {
  test("DRAG_SLOP_PX is 6", () => {
    assert.equal(api("DRAG_SLOP_PX"), 6);
  });

  test("a 5px move then pointerup is a tap: onTap once, no onMove, no onDrop, no .is-dragging", () => {
    const { el, calls, fire } = wired();
    fire("pointerdown", 100, 100);
    fire("pointermove", 103, 104);
    assert.equal(dragging(el), false, "not dragging inside the slop");
    fire("pointerup", 103, 104);
    assert.equal(calls.tap, 1);
    assert.equal(calls.move.length, 0);
    assert.equal(calls.drop.length, 0);
  });

  test("a 7px move is a drag: .is-dragging set, move defaultPrevented, onMove(x, y, ev)", () => {
    const { el, calls, fire } = wired();
    fire("pointerdown", 100, 100);
    const ev = fire("pointermove", 100, 107);
    assert.equal(dragging(el), true, "element has .is-dragging");
    assert.equal(ev.defaultPrevented, true, "drag move is defaultPrevented");
    assert.equal(calls.move.length, 1);
    assert.equal(calls.move[0][0], 100);
    assert.equal(calls.move[0][1], 107);
    assert.equal(calls.move[0][2], ev, "onMove gets the pointer event third");
  });

  test("pointerup after a drag calls onDrop(x, y), clears .is-dragging and never calls onTap", () => {
    const { el, calls, fire } = wired();
    fire("pointerdown", 100, 100);
    fire("pointermove", 130, 140);
    fire("pointermove", 150, 160);
    fire("pointerup", 151, 162);
    assert.equal(calls.drop.length, 1);
    assert.deepEqual(calls.drop[0].slice(0, 2), [151, 162]);
    assert.equal(dragging(el), false, ".is-dragging removed on drop");
    assert.equal(calls.tap, 0, "a drag is never a tap");
  });

  test("a custom slop is honoured: 10px stays a tap at slop 20, 25px drags", () => {
    const { calls, fire } = wired({ slop: 20 });
    fire("pointerdown", 0, 0);
    fire("pointermove", 10, 0);
    assert.equal(calls.move.length, 0, "10px is inside a 20px slop");
    fire("pointermove", 25, 0);
    assert.equal(calls.move.length, 1, "25px leaves a 20px slop");
  });
});

// Covers: MEM-130
// Requirement: a gesture belongs to the pointer that started it, can be cancelled, and a tap fires once.
describe("sticker_drag gesture ownership (MEM-130)", () => {
  test("a move from a different pointerId is ignored", () => {
    const { el, calls, fire } = wired();
    fire("pointerdown", 100, 100, { pointerId: 1 });
    fire("pointermove", 200, 200, { pointerId: 2 });
    assert.equal(calls.move.length, 0);
    assert.equal(dragging(el), false);
    fire("pointerup", 100, 100, { pointerId: 1 });
    assert.equal(calls.drop.length, 0, "no drop: the owning pointer never left the slop");
  });

  test("pointercancel mid-drag calls onCancel and clears .is-dragging; a later pointerup does nothing", () => {
    const { el, calls, fire } = wired();
    fire("pointerdown", 100, 100);
    fire("pointermove", 140, 100);
    fire("pointercancel", 140, 100);
    assert.equal(calls.cancel, 1);
    assert.equal(dragging(el), false);
    fire("pointerup", 140, 100);
    assert.equal(calls.drop.length, 0, "no drop after cancel");
    assert.equal(calls.tap, 0, "no tap after cancel");
  });

  test("pointerdown, pointerup, click calls onTap exactly once", () => {
    const { p, el, calls, fire } = wired();
    fire("pointerdown", 50, 50);
    fire("pointerup", 50, 50);
    p.fire(el, "click", { clientX: 50, clientY: 50, button: 0 });
    assert.equal(calls.tap, 1);
    assert.equal(calls.drop.length, 0);
  });
});

// Covers: MEM-130
// Requirement: boxDistance is 0 inside or on the box edge, else the Euclidean distance to the nearest edge.
describe("sticker_drag boxDistance (MEM-130)", () => {
  const B = { x1: 0, y1: 0, x2: 10, y2: 10 };

  test("0 inside and on every edge and corner", () => {
    const d = api("boxDistance");
    for (const [x, y] of [[5, 5], [0, 5], [10, 5], [5, 0], [5, 10], [0, 0], [10, 10]]) {
      assert.equal(d(x, y, B), 0, `(${x}, ${y})`);
    }
  });

  test("distance to the nearest side when beside the box", () => {
    const d = api("boxDistance");
    assert.equal(d(15, 5, B), 5);
    assert.equal(d(-3, 5, B), 3);
    assert.equal(d(5, -7, B), 7);
    assert.equal(d(5, 12, B), 2);
  });

  test("diagonal distance to the nearest corner", () => {
    const d = api("boxDistance");
    assert.equal(d(13, 14, B), 5);
    assert.equal(d(-3, -4, B), 5);
  });
});

// Covers: MEM-130
// Requirement: a drop binds to the smallest box containing it (a nested object beats the one around it), else the
// box with the nearest edge; ties keep the lower index; null / NaN / missing-field boxes are skipped; with no usable
// box the result is -1.
describe("sticker_drag nearestBox (MEM-130)", () => {
  test("the smallest containing box wins over the box around it, whatever the order", () => {
    const nb = api("nearestBox");
    const outer = { x1: 0, y1: 0, x2: 100, y2: 100 };
    const inner = { x1: 40, y1: 40, x2: 60, y2: 60 };
    assert.equal(nb(50, 50, [outer, inner]), 1);
    assert.equal(nb(50, 50, [inner, outer]), 0);
  });

  test("outside every box, the nearest edge wins", () => {
    const nb = api("nearestBox");
    const a = { x1: 0, y1: 0, x2: 10, y2: 10 };
    const b = { x1: 30, y1: 0, x2: 40, y2: 10 };
    assert.equal(nb(26, 5, [a, b]), 1);
    assert.equal(nb(14, 5, [a, b]), 0);
  });

  test("ties keep the lower index (equal containing boxes, equidistant boxes)", () => {
    const nb = api("nearestBox");
    const box = { x1: 0, y1: 0, x2: 10, y2: 10 };
    assert.equal(nb(5, 5, [box, { ...box }]), 0);
    const a = { x1: 0, y1: 0, x2: 10, y2: 10 };
    const b = { x1: 30, y1: 0, x2: 40, y2: 10 };
    assert.equal(nb(20, 5, [a, b]), 0);
  });

  test("null, NaN and missing-field boxes are skipped", () => {
    const nb = api("nearestBox");
    const good = { x1: 100, y1: 100, x2: 110, y2: 110 };
    const bad = [null, undefined, { x1: NaN, y1: 0, x2: 10, y2: 10 }, { x1: 0, y1: 0, x2: 10 }];
    assert.equal(nb(5, 5, [...bad, good]), 4);
  });

  test("an empty list or only unusable boxes gives -1", () => {
    const nb = api("nearestBox");
    assert.equal(nb(5, 5, []), -1);
    assert.equal(nb(5, 5, [null, { x1: 0, y1: NaN, x2: 1, y2: 1 }, {}]), -1);
  });

  test("property: the chosen box always has the minimal distance, and the minimal area among containing boxes", () => {
    const nb = api("nearestBox");
    const bd = api("boxDistance");
    const rand = mulberry32(130);
    for (let round = 0; round < 300; round++) {
      const count = 1 + Math.floor(rand() * 6);
      const boxes = [];
      for (let i = 0; i < count; i++) {
        const x1 = Math.floor(rand() * 200);
        const y1 = Math.floor(rand() * 200);
        boxes.push({ x1, y1, x2: x1 + 1 + Math.floor(rand() * 80), y2: y1 + 1 + Math.floor(rand() * 80) });
      }
      const x = Math.floor(rand() * 300) - 50;
      const y = Math.floor(rand() * 300) - 50;
      const got = nb(x, y, boxes);
      const ctx = `round ${round}: (${x}, ${y}) in ${JSON.stringify(boxes)} -> ${got}`;
      assert.ok(got >= 0 && got < boxes.length, ctx);
      const dists = boxes.map((b) => bd(x, y, b));
      const min = Math.min(...dists);
      assert.equal(dists[got], min, `minimal distance; ${ctx}`);
      if (min === 0) {
        const area = (b) => (b.x2 - b.x1) * (b.y2 - b.y1);
        const minArea = Math.min(...boxes.filter((_, i) => dists[i] === 0).map(area));
        assert.equal(area(boxes[got]), minArea, `smallest containing box; ${ctx}`);
      }
    }
  });
});
