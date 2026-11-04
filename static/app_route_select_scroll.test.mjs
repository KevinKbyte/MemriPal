// Covers: MEM-088
// Requirement (R3b): a map marker click scrolls the newly selected li into view in #route-view-stations
// (the drawer list may be longer than the drawer), calling li.scrollIntoView({ block: "nearest" }) on that li
// only; a DOM without scrollIntoView still selects (the call is optional-chained).
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { boot, el, find, findAll, kvAdapter, settle, TURNS, until } from "./ux_flow_harness_test.mjs";
import { createRouteStore } from "./route_store.js";

const ROUTE = {
  id: "rscr",
  name: "Scroll walk",
  kind: "daily",
  stations: [
    { id: "rscr-st-1", n: 1, name: "red bench", coords: { lat: 42.36238, lon: -71.0856 } },
    { id: "rscr-st-2", n: 2, name: "old oak", coords: { lat: 42.36265, lon: -71.08441 } },
    { id: "rscr-st-3", n: 3, name: "stone arch", coords: { lat: 42.36385, lon: -71.08347 } },
  ],
};

describe("route view: marker click scrolls the selected station into view (MEM-088)", () => {
  test("only the selected #route-view-stations li gets scrollIntoView({ block: 'nearest' })", async () => {
    const routes = createRouteStore(kvAdapter());
    await routes.seedRoute(ROUTE);
    const b = boot({ routes, realMap: { mount: () => Promise.resolve(null) }, rehAdapter: kvAdapter(),
      health: { status: "ok", mode: "fixture" } });
    const cards = () => findAll(el(b, "routes-list"), (n) => n.tagName === "LI");
    await until(() => cards().some((li) => li.textContent.includes(ROUTE.name)), "Scroll walk card", TURNS);
    const card = cards().find((li) => li.textContent.includes(ROUTE.name));
    b.p.fire(find(card, (n) => n.tagName === "BUTTON" && n.dataset.action === "open"), "click");
    await until(() => !el(b, "route-view").hidden, "#route-view shown", TURNS);
    await settle(20);
    const calls = [];
    const lis = findAll(el(b, "route-view-stations"), (n) => n.tagName === "LI");
    lis.forEach((li, i) => { li.scrollIntoView = (opts) => calls.push([i, opts]); });
    const map = el(b, "route-map");
    const node = find(map, (n) => n !== map && n.dataset?.stationId === "rscr-st-2");
    b.p.fire(node, "click");
    await settle(10);
    assert.deepEqual(calls, [[1, { block: "nearest" }]]);
  });
});
