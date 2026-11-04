// Covers: MEM-088
// Requirement: "Map a new route" never dead-ends on a failure (MEM-088). When the walk-graph fetch itself
// rejects (network error, not a 404), Find still previews 3-8 stations with the straight-line distance,
// labelled, and no error; the rejection is not cached, so the next Find fetches the graph again. When saving
// the route fails (the store rejects, e.g. quota), #route-new shows "Couldn't save the route. Try again.",
// the form stays open, no route is opened and no rejection escapes; a later Save that succeeds stores the
// route, opens it and clears the error.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { boot, click, el, findAll, kvAdapter, settle, TURNS, until, walkDataFile, watchRejections } from "./ux_flow_harness_test.mjs";
import { createRouteStore } from "./route_store.js";

const FIXTURE = { status: "ok", mode: "fixture" };
const SAVE_FAILED = "Couldn't save the route. Try again.";
const FALLBACK = "(straight line; walking paths unavailable)";

function start(opts = {}) {
  const routes = opts.routes ?? createRouteStore(kvAdapter());
  const calls = [];
  const realMap = { calls, mount(svg, stations) { calls.push({ svg, stations: structuredClone(stations) }); return Promise.resolve(); } };
  const b = boot({ routes, realMap, health: FIXTURE, ...opts });
  return { b, routes, realMap };
}
const lis = (b, id) => findAll(el(b, id), (n) => n.tagName === "LI");
const fetched = (b, file) => b.server.calls.filter((c) => walkDataFile(c.u) === file).length;
// Microtask turns only: the failed Save is judged before Node reports any unhandled rejection.
const microtasks = async (n) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

async function find(b, from = "Kendall/MIT T", to = "Meta office") {
  click(b, "routes-new");
  el(b, "route-from").value = from;
  el(b, "route-to").value = to;
  el(b, "route-new-result").hidden = true;
  el(b, "route-new-error").hidden = true;
  click(b, "route-find");
  await until(() => !el(b, "route-new-result").hidden || !el(b, "route-new-error").hidden, "Find answered", TURNS);
  await settle(20);
}

describe("Map a new route: network and save failures (MEM-088)", () => {
  test("walk-graph fetch rejects: straight-line preview, no error; the next Find fetches the graph again", async (t) => {
    const seen = watchRejections(t);
    const { b } = start({
      extra: (u) => {
        if (walkDataFile(u) === "kendall_walk_graph.json") throw new TypeError("Failed to fetch");
      },
    });
    await find(b);
    assert.equal(el(b, "route-new-result").hidden, false, "#route-new-result shown");
    assert.equal(el(b, "route-new-error").hidden, true, "#route-new-error hidden");
    assert.ok(el(b, "route-distance").textContent.endsWith(FALLBACK), el(b, "route-distance").textContent);
    const items = lis(b, "route-new-stations").map((li) => li.textContent);
    assert.ok(items.length >= 3 && items.length <= 8, `stations: ${items.join(" | ")}`);
    assert.ok(items[0].startsWith("Kendall/MIT T"), items[0]);
    assert.ok(items.at(-1).startsWith("Meta office"), items.at(-1));
    assert.equal(fetched(b, "kendall_walk_graph.json"), 1);
    await find(b);
    assert.equal(fetched(b, "kendall_walk_graph.json"), 2, "a rejected graph fetch is not cached");
    assert.equal(fetched(b, "kendall_pois.json"), 1, "POIs fetched once");
    assert.equal(el(b, "route-new-result").hidden, false, "#route-new-result shown after the retry");
    assert.deepEqual(seen, [], "no unhandled rejection");
  });

  test(`Save fails: "${SAVE_FAILED}" shown, form stays, nothing opened; a later Save stores and opens`, async (t) => {
    const seen = watchRejections(t);
    const store = createRouteStore(kvAdapter());
    let fail = true;
    const routes = { ...store, seedRoute: (r) => (fail ? Promise.reject(new Error("quota")) : store.seedRoute(r)) };
    const { b } = start({ routes });
    await find(b);
    assert.equal(el(b, "route-new-result").hidden, false, "Find previewed a route");
    click(b, "route-new-save");
    await microtasks(50);
    assert.equal(el(b, "route-new-error").hidden, false, "#route-new-error shown after a failed Save");
    assert.equal(el(b, "route-new-error").textContent, SAVE_FAILED);
    assert.equal(el(b, "route-new").hidden, false, "#route-new stays open");
    assert.equal(el(b, "route-view").hidden, true, "no route opened");
    await settle(20);
    assert.deepEqual(seen, [], "no unhandled rejection");
    assert.equal((await store.listRoutes()).length, 0, "nothing stored");

    fail = false;
    click(b, "route-new-save");
    await until(() => !el(b, "route-view").hidden, "#route-view shown after the retried Save", TURNS);
    await settle(20);
    const list = await store.listRoutes();
    assert.equal(list.length, 1, "one route saved");
    assert.equal(list[0].name, "Kendall/MIT T to Meta office");
    assert.equal(el(b, "route-new").hidden, true, "#route-new hidden after Save");
    assert.equal(el(b, "route-new-error").hidden, true, "#route-new-error hidden after a successful Save");
    assert.deepEqual(seen, [], "no unhandled rejection");
  });
});
