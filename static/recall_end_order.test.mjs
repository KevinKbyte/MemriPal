// Covers: MEM-080
// Requirement: a route practice point said out of order is got (the matcher heard it) but not a hit (its
// station's hits entry is false, countInOrder did not count it). The end screen offers "Mark got it" on
// every point that does not count: missed points, and on route runs, got points whose station hit is
// false. Clicking it sets that station's hit true. A got point whose hit is true, and any got point of a
// non-route run (no hits), has no button.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { fakePage, findAll } from "./fake_dom_test.mjs";
import { markPointGot, pointCounted, renderEndScreen } from "./recall_end.js";

const IDS = ["r1-st-1", "r1-st-2", "r1-st-3"];

/** A saved route run: point 0 in order, point 1 said out of order (got, not hit), point 2 missed. */
function routeRecord() {
  return {
    id: "reh-1",
    palace_id: "r1",
    timestamp: "2026-11-02T08:00:00.000Z",
    transcript: "stone arch red bench",
    mode: "route",
    points: [
      { label: "red bench", source_quote: "red bench", got: true, override: false, span: "red bench" },
      { label: "old oak", source_quote: "old oak", got: true, override: false, span: "old oak" },
      { label: "stone arch", source_quote: "stone arch", got: false, override: false, span: null },
    ],
    hits: { [IDS[0]]: true, [IDS[1]]: false, [IDS[2]]: false },
  };
}

function markButtons(list) {
  return list.children.map((row) => findAll(row, (n) => n.dataset?.action === "mark-got").length);
}

describe("MEM-080 route point said out of order", () => {
  test("pointCounted: got and hit counts; got but not hit does not; missed does not", () => {
    const record = routeRecord();
    assert.deepEqual([0, 1, 2].map((i) => pointCounted(record, i)), [true, false, false]);
  });

  test("pointCounted on a non-route run is the point's got", () => {
    const { hits, ...plain } = routeRecord();
    assert.deepEqual([0, 1, 2].map((i) => pointCounted(plain, i)), [true, true, false]);
  });

  test("the end screen offers Mark got it on the out-of-order point and the missed one only", () => {
    const { doc } = fakePage([]);
    const list = renderEndScreen(routeRecord(), doc, () => {});
    assert.deepEqual(markButtons(list), [0, 1, 1]);
  });

  test("clicking it on the out-of-order point reports that point's index", () => {
    const { doc, fire } = fakePage([]);
    const marked = [];
    const list = renderEndScreen(routeRecord(), doc, (i) => marked.push(i));
    const [button] = findAll(list.children[1], (n) => n.dataset?.action === "mark-got");
    fire(button, "click");
    assert.deepEqual(marked, [1]);
  });

  test("marking it sets its station hit true, keeps got, and then it counts with no button", () => {
    const { doc } = fakePage([]);
    const marked = markPointGot(routeRecord(), 1);
    assert.equal(marked.points[1].got, true);
    assert.deepEqual(marked.hits, { [IDS[0]]: true, [IDS[1]]: true, [IDS[2]]: false });
    assert.equal(pointCounted(marked, 1), true);
    assert.deepEqual(markButtons(renderEndScreen(marked, doc, () => {})), [0, 0, 1]);
  });

  test("a non-route run shows no button on got points", () => {
    const { doc } = fakePage([]);
    const { hits, ...plain } = routeRecord();
    assert.deepEqual(markButtons(renderEndScreen(plain, doc, () => {})), [0, 0, 1]);
  });
});
