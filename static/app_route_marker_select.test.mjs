// Covers: MEM-088
// Requirement: on an opened route, clicking a station marker on the #route-map sketch selects that station.
// Both #route-view-stations and #landmarks-list carry one li per station, in route order, each with
// data-station-id set to the station's id. A click whose target is (or is inside) an element carrying
// data-station-id gives the matching li in BOTH lists aria-current="true" and leaves every other li in those
// lists without an aria-current attribute; clicking another marker moves the selection. A click on #route-map
// whose target has no data-station-id ancestor (the route line, the map itself) changes nothing.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { boot, el, find, findAll, kvAdapter, settle, TURNS, until } from "./ux_flow_harness_test.mjs";
import { createRouteStore } from "./route_store.js";

const FIXTURE = { status: "ok", mode: "fixture" };
const ROUTE = {
  id: "rsel",
  name: "Marker walk",
  kind: "daily",
  stations: [
    { id: "rsel-st-1", n: 1, name: "red bench", coords: { lat: 42.36238, lon: -71.0856 } },
    { id: "rsel-st-2", n: 2, name: "old oak", coords: { lat: 42.36265, lon: -71.08441 } },
    { id: "rsel-st-3", n: 3, name: "stone arch", coords: { lat: 42.36385, lon: -71.08347 } },
    { id: "rsel-st-4", n: 4, name: "blue gate", coords: { lat: 42.36554, lon: -71.0809 } },
  ],
};
const IDS = ROUTE.stations.map((s) => s.id);
const LISTS = ["route-view-stations", "landmarks-list"];

/** Seeds ROUTE, boots with a stub real map (no real_map*.js), and opens ROUTE from its S1 card. */
async function openSeeded() {
  const routes = createRouteStore(kvAdapter());
  await routes.seedRoute(ROUTE);
  const realMap = { mount: () => Promise.resolve(null) };
  const b = boot({ routes, realMap, rehAdapter: kvAdapter(), health: FIXTURE });
  await until(() => findAll(el(b, "routes-list"), (n) => n.tagName === "LI").some((li) => li.textContent.includes(ROUTE.name)),
    "Marker walk card on S1", TURNS);
  const card = findAll(el(b, "routes-list"), (n) => n.tagName === "LI").find((li) => li.textContent.includes(ROUTE.name));
  const open = find(card, (n) => n.tagName === "BUTTON" && n.dataset.action === "open");
  assert.ok(open, "Marker walk card has an Open button");
  b.p.fire(open, "click");
  await until(() => !el(b, "route-view").hidden, "#route-view shown", TURNS);
  await settle(20);
  return b;
}

const lis = (b, id) => findAll(el(b, id), (n) => n.tagName === "LI");
const current = (b, id) => lis(b, id).map((li) => li.getAttribute("aria-current"));
const selectedOnly = (i) => IDS.map((_, j) => (j === i ? "true" : null));
const marker = (b, stationId) => {
  const map = el(b, "route-map");
  const node = find(map, (n) => n !== map && n.dataset?.stationId === stationId);
  assert.ok(node, `#route-map has a node with data-station-id="${stationId}"`);
  return node;
};

async function clickOn(b, target) {
  b.p.fire(target, "click");
  await settle(10);
}

// Covers: MEM-088
// Requirement: see file header (marker click selects the station in both lists; misses change nothing).
describe("route view: a #route-map marker click selects its station (MEM-088)", () => {
  test("both lists carry data-station-id per li in route order", async () => {
    const b = await openSeeded();
    for (const id of LISTS) {
      assert.deepEqual(lis(b, id).map((li) => li.dataset.stationId), IDS, `#${id} li data-station-id in route order`);
    }
  });

  test("clicking station 3's marker marks li 3 aria-current=true in both lists, no other li", async () => {
    const b = await openSeeded();
    await clickOn(b, marker(b, IDS[2]));
    for (const id of LISTS) assert.deepEqual(current(b, id), selectedOnly(2), `#${id} aria-current after marker 3 click`);
  });

  test("a second marker click moves the selection, including a click inside a marker", async () => {
    const b = await openSeeded();
    await clickOn(b, marker(b, IDS[0]));
    for (const id of LISTS) assert.deepEqual(current(b, id), selectedOnly(0), `#${id} after marker 1 click`);
    // The target is a child of station 4's node: the selection follows the nearest data-station-id ancestor.
    const inner = b.p.doc.createElementNS("http://www.w3.org/2000/svg", "title");
    marker(b, IDS[3]).appendChild(inner);
    await clickOn(b, inner);
    for (const id of LISTS) assert.deepEqual(current(b, id), selectedOnly(3), `#${id} after a click inside marker 4`);
  });

  test("a click on #route-map with no data-station-id ancestor changes nothing", async () => {
    const b = await openSeeded();
    const map = el(b, "route-map");
    const line = find(map, (n) => n.tagName === "POLYLINE");
    assert.ok(line, "#route-map has the route line");
    await clickOn(b, line);
    await clickOn(b, map);
    for (const id of LISTS) assert.deepEqual(current(b, id), IDS.map(() => null), `#${id} untouched by a miss`);
    await clickOn(b, marker(b, IDS[1]));
    await clickOn(b, line);
    await clickOn(b, map);
    for (const id of LISTS) assert.deepEqual(current(b, id), selectedOnly(1), `#${id} keeps marker 2 after misses`);
  });
});
