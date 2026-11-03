// Covers: MEM-072
// Requirement: the map-first shell routes the user to the right tab (MEM-072, ADR 0038). Load demo seeds the
// Kendall demo route and opens it on the Routes tab: #tab-routes shows (the other panels hide), the real map
// mounts on #route-map with the 6 stations, #map-chip reads the route name and #landmarks-list lists the
// station names in order; the room demo on the same click never switches tabs. Opening a stored route's card
// from #routes-list does the same. #routes-new ("Map a new route") opens the route drawer (#drawer.open).
// Practising a route (#route-view-practice) switches to the Recall tab.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { boot, click, el, find, findAll, kvAdapter, loadDemo, settle, TURNS, until, watchRejections } from "./ux_flow_harness_test.mjs";
import { memoryAdapter } from "./route_store_fakes_test.mjs";
import { createRouteStore } from "./route_store.js";
import { DEMO_ROUTE } from "./demo_route.js";

const FIXTURE = { status: "ok", mode: "fixture" };
const PANELS = ["tab-routes", "tab-landmarks", "tab-recall", "tab-settings"];
const NAMES = DEMO_ROUTE.stations.map((s) => s.name);

/** Fake real-map loader (createRealMapLoader shape): records each mount, resolves null. */
function fakeRealMap() {
  const calls = [];
  return { calls, mount(svg, stations) { calls.push({ svg, stations: structuredClone(stations) }); return Promise.resolve(null); } };
}

function start(adapter = memoryAdapter()) {
  const realMap = fakeRealMap();
  const b = boot({ routes: createRouteStore(adapter), realMap, rehAdapter: kvAdapter(), health: FIXTURE });
  return { b, realMap, adapter };
}

/** Puts the page on another tab first, so a switch to `want` is observable. */
function showOnly(b, id) {
  for (const p of PANELS) el(b, p).hidden = p !== id;
}
const shown = (b) => PANELS.filter((p) => !el(b, p).hidden);
const landmarks = (b) => findAll(el(b, "landmarks-list"), (n) => n.tagName === "LI").map((li) => li.textContent.trim());
const cards = (b) => findAll(el(b, "routes-list"), (n) => n.tagName === "LI", { visibleOnly: true });

/** Asserts the Routes tab shows the demo route: map mounted, chip named, landmarks listed. */
async function assertRouteOpen(b, realMap) {
  await until(() => el(b, "map-chip").textContent.trim() === DEMO_ROUTE.name, "#map-chip names the demo route", TURNS);
  await settle(20);
  assert.deepEqual(shown(b), ["tab-routes"], "only #tab-routes visible");
  const last = realMap.calls.at(-1);
  assert.ok(last, "the real map mounted");
  assert.equal(last.svg, el(b, "route-map"), "mounted on #route-map (inside .map-wrap)");
  assert.equal(last.stations.length, NAMES.length, "mounted with every demo station");
  assert.deepEqual(landmarks(b), NAMES, "#landmarks-list lists the station names in order");
}

// Covers: MEM-072
// Requirement: Load demo lands on the Routes tab with the demo route open on the map.
describe("Load demo opens the demo route on the Routes tab (MEM-072)", () => {
  test("from another tab: #tab-routes shown, map mounted, #map-chip = route name, #landmarks-list = stations", async (t) => {
    const rejections = watchRejections(t);
    const { b, realMap } = start();
    await settle(20);
    showOnly(b, "tab-settings");
    await loadDemo(b);
    await assertRouteOpen(b, realMap);
    assert.deepEqual(rejections, []);
  });

  test("the room demo on the same click never switches to the Recall tab", async () => {
    const { b, realMap } = start();
    await loadDemo(b);
    await assertRouteOpen(b, realMap);
    await settle(200);
    assert.equal(el(b, "tab-recall").hidden, true, "#tab-recall stays hidden after the room demo finishes");
  });
});

// Covers: MEM-072
// Requirement: opening a stored route card shows that route on the Routes tab map.
describe("opening a route card from #routes-list (MEM-072)", () => {
  test("after a reload, Open <name> shows #tab-routes with the map, chip and landmarks", async (t) => {
    const rejections = watchRejections(t);
    const adapter = memoryAdapter();
    await loadDemo(start(adapter).b);
    const { b, realMap } = start(adapter);
    await until(() => cards(b).length === 1, "the stored demo route listed after reload", TURNS);
    assert.equal(realMap.calls.length, 0, "no map mount at boot before a route is opened");
    showOnly(b, "tab-landmarks");
    const open = find(cards(b)[0], (n) => n.tagName === "BUTTON" && n.dataset.action === "open");
    assert.ok(open, "the card has an Open button");
    b.p.fire(open, "click");
    await assertRouteOpen(b, realMap);
    assert.deepEqual(rejections, []);
  });
});

// Covers: MEM-072
// Requirement: Map a new route opens the route drawer.
describe("#routes-new opens the route drawer (MEM-072)", () => {
  test("clicking #routes-new sets #drawer.open = true", async () => {
    const { b } = start();
    await settle(20);
    el(b, "drawer").open = false;
    click(b, "routes-new");
    await settle(20);
    assert.equal(el(b, "drawer").open, true, "#drawer open after Map a new route");
  });
});

// Covers: MEM-072
// Requirement: practising a route moves to the Recall tab.
describe("route practice switches to the Recall tab (MEM-072)", () => {
  test("#route-view-practice on the open demo route shows #tab-recall only", async (t) => {
    const rejections = watchRejections(t);
    const { b, realMap } = start();
    await loadDemo(b);
    await assertRouteOpen(b, realMap);
    click(b, "route-view-practice");
    await until(() => !el(b, "tab-recall").hidden, "#tab-recall shown for practice", TURNS);
    assert.deepEqual(shown(b), ["tab-recall"], "only #tab-recall visible");
    assert.deepEqual(rejections, []);
  });
});
