// Covers: MEM-077
// Requirement: the app shows the Kendall demo route (plan 2026-11-02-real-map S6, MEM-055 B10 "Load demo
// route"). Clicking Load demo puts static/demo_route.js DEMO_ROUTE into the route store as a saved route
// (other demo routes, MEM-133, may seed beside it; their own tests pin them):
// its id, name and kind "daily", its 6 stations in docs/design/map/preview.js order with the preview's
// titles as names and the preview's coords (within 1e-4, the store's 4 dp). S1 #routes-list then shows its
// card among S1's cards (Open button aria-label "Open <DEMO_ROUTE.name>", no Draft chip). Since the map-first shell (MEM-072)
// Load demo also opens the route: the 6 stations list on S5 and the real map mounts on #route-map with all 6
// in-bbox stations; nothing mounts the map before Load demo. Seeding is idempotent:
// a second Load demo, also after a reload over the same store, keeps exactly one DEMO_ROUTE and adds no route. Seeding
// never touches the server (no /station, /baseline or coordinate-bearing request). The room demo on the same
// click is unchanged (one /loci POST, #recall shown;
// its existing tests pin the rest), and a route store whose writes fail never breaks it or leaks a rejection.
// Loading path: the existing #load-demo click (flow.js wireApp) seeds deps.routes when deps.routes is
// present; no new control.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { boot, el, find, findAll, kvAdapter, loadDemo, settle, TURNS, until, watchRejections } from "./ux_flow_harness_test.mjs";
import { memoryAdapter } from "./route_store_fakes_test.mjs";
import { createRouteStore } from "./route_store.js";
import { inRealMapBbox } from "./real_map.js";
import { DEMO_ROUTE } from "./demo_route.js";

const FIXTURE = { status: "ok", mode: "fixture" };

/** preview.js STATIONS, the design source of truth: [{ lng, lat, title }] in order. */
function previewStations() {
  const text = readFileSync(new URL("../docs/design/map/preview.js", import.meta.url), "utf8");
  const start = text.indexOf("var STATIONS = [");
  const block = text.slice(start, text.indexOf("];", start));
  const re = /lngLat:\s*\[\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\][\s\S]*?title:\s*"([^"]*)"/g;
  return [...block.matchAll(re)].map(([, lng, lat, title]) => ({ lng: Number(lng), lat: Number(lat), title }));
}
const PREVIEW = previewStations();

/** Fake real-map loader (createRealMapLoader shape): records each mount, resolves null. */
function fakeRealMap() {
  const calls = [];
  return {
    calls,
    mount(svg, stations) {
      calls.push({ svg, stations: structuredClone(stations) });
      return Promise.resolve(null);
    },
  };
}

function start(adapter = memoryAdapter()) {
  const routes = createRouteStore(adapter);
  const realMap = fakeRealMap();
  const b = boot({ routes, realMap, rehAdapter: kvAdapter(), health: FIXTURE });
  return { b, routes, realMap, adapter };
}

const cards = (b) => findAll(el(b, "routes-list"), (n) => n.tagName === "LI", { visibleOnly: true });
const openLabel = (li) => find(li, (n) => n.tagName === "BUTTON" && n.dataset.action === "open")?.getAttribute("aria-label");
/** S1 cards for DEMO_ROUTE (by its Open aria-label). */
const demoCards = (b) => cards(b).filter((li) => openLabel(li) === `Open ${DEMO_ROUTE.name}`);
const demoStored = async (routes) => (await routes.listRoutes()).filter((r) => r.id === DEMO_ROUTE.id);

async function loadDemoRoute(b) {
  await loadDemo(b);
  await until(() => demoCards(b).length === 1, "the DEMO_ROUTE card on S1 after Load demo", TURNS);
  await settle(20);
}

/** The demo route module, or {} while it does not exist (so RED fails on an assertion naming it). */
async function demoModule() {
  const mod = await import("./demo_route.js").catch(() => ({}));
  assert.ok(mod.DEMO_ROUTE, "static/demo_route.js exports DEMO_ROUTE");
  return mod.DEMO_ROUTE;
}

const LATLON_TEXT = /-?\d{1,3}\.\d{2,}\s*(?:,|\/|_|&\w+=|;)\s*-?\d{1,3}\.\d{2,}/;

// Covers: MEM-077
// Requirement: Load demo adds the Kendall demo route to the route store and S1 and opens it (MEM-072): the
// 6 stations show and the real map mounts with them, never before Load demo.
describe("Load demo seeds the Kendall demo route (plan S6, MEM-077)", () => {
  test("one saved route of 6 stations: preview titles in order, preview coords, all in the bbox", async (t) => {
    const rejections = watchRejections(t);
    const { b, routes } = start();
    await loadDemoRoute(b);
    const list = await demoStored(routes);
    assert.equal(list.length, 1, "exactly one DEMO_ROUTE after Load demo");
    const [r] = list;
    assert.equal(r.status, "saved", "the demo route is saved, not a draft");
    assert.equal(r.kind, "daily");
    assert.deepEqual(r.stations.map((s) => s.n), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(r.stations.map((s) => s.name), PREVIEW.map((p) => p.title));
    r.stations.forEach((s, i) => {
      assert.ok(Math.abs(s.coords?.lat - PREVIEW[i].lat) <= 1e-4, `station ${i + 1} lat ${s.coords?.lat}`);
      assert.ok(Math.abs(s.coords?.lon - PREVIEW[i].lng) <= 1e-4, `station ${i + 1} lon ${s.coords?.lon}`);
    });
    assert.equal(inRealMapBbox(r.stations), true, "every demo station inside the extract bbox");
    assert.deepEqual(rejections, []);
  });

  test("the stored route is DEMO_ROUTE: same id, name, kind and station ids", async () => {
    const demo = await demoModule();
    const { b, routes } = start();
    await loadDemoRoute(b);
    const [r] = await demoStored(routes);
    assert.ok(r, "a route was stored");
    assert.equal(r.id, demo.id);
    assert.equal(r.name, demo.name);
    assert.equal(r.kind, demo.kind);
    assert.deepEqual(r.stations.map((s) => s.id), demo.stations.map((s) => s.id));
  });

  test("S1 card: Open <DEMO_ROUTE.name>, 6 stations, no Draft chip", async () => {
    const demo = await demoModule();
    const { b } = start();
    await loadDemoRoute(b);
    const [li] = demoCards(b);
    const open = find(li, (n) => n.tagName === "BUTTON" && n.dataset.action === "open");
    assert.ok(open, "card has an Open button");
    assert.equal(open.getAttribute("aria-label"), `Open ${demo.name}`);
    assert.ok(li.textContent.includes("6 stations"), li.textContent);
    assert.ok(!li.textContent.includes("Draft"), "no Draft chip on the demo route");
  });

  test("Load demo opens the route: 6 stations on S5 and one real-map mount with them, none before (MEM-072)", async (t) => {
    const rejections = watchRejections(t);
    const { b, realMap } = start();
    await settle(20);
    assert.equal(realMap.calls.length, 0, "no map mount before Load demo");
    await loadDemoRoute(b);
    await until(() => !el(b, "route-view").hidden, "#route-view shown by Load demo (MEM-072)", TURNS);
    await settle(20);
    const items = findAll(el(b, "route-view-stations"), (n) => n.tagName === "LI");
    assert.deepEqual(items.map((li) => li.textContent), PREVIEW.map((p) => p.title));
    assert.equal(realMap.calls.length, 1, "one real-map mount when Load demo opens the route");
    const [call] = realMap.calls;
    assert.equal(call.svg, el(b, "route-map"), "mounted on #route-map");
    assert.equal(call.stations.length, 6, "mounted with all 6 demo stations");
    assert.equal(inRealMapBbox(call.stations), true, "mounted stations are in the bbox (real map, not sketch)");
    assert.deepEqual(rejections, []);
  });
});

// Covers: MEM-077
// Requirement: seeding the demo route is idempotent, server-free and never breaks the room demo.
describe("demo route seeding edges (plan S6, MEM-077)", () => {
  test("Load demo twice keeps exactly one demo route", async () => {
    const { b, routes } = start();
    await loadDemoRoute(b);
    await settle(50);
    const before = (await routes.listRoutes()).length;
    await loadDemoRoute(b);
    await settle(50);
    assert.equal((await demoStored(routes)).length, 1, "still one DEMO_ROUTE after a second Load demo");
    assert.equal((await routes.listRoutes()).length, before, "no route added by a second Load demo");
    assert.equal(demoCards(b).length, 1, "still one DEMO_ROUTE card on S1");
  });

  test("a reload over the same store, then Load demo: still one demo route", async () => {
    const adapter = memoryAdapter();
    const first = start(adapter);
    await loadDemoRoute(first.b);
    await settle(50);
    const before = (await first.routes.listRoutes()).length;
    const second = start(adapter);
    await until(() => demoCards(second.b).length === 1, "the stored demo route listed after reload", TURNS);
    await loadDemoRoute(second.b);
    await settle(50);
    assert.equal((await demoStored(second.routes)).length, 1, "no DEMO_ROUTE duplicate after reload + Load demo");
    assert.equal((await second.routes.listRoutes()).length, before, "no route added after reload + Load demo");
  });

  test("seeding sends nothing to the server: no /station, /baseline or coordinate-bearing request", async () => {
    const { b } = start();
    await loadDemoRoute(b);
    const urls = b.server.calls.map((c) => String(c.u));
    assert.deepEqual(urls.filter((u) => /\/(station|baseline)\b/.test(u)), []);
    assert.deepEqual(urls.filter((u) => LATLON_TEXT.test(decodeURIComponent(u))), []);
    for (const p of PREVIEW) {
      const marks = [p.lat.toFixed(4).slice(0, 5), p.lng.toFixed(4).slice(0, 6)];
      assert.deepEqual(urls.filter((u) => marks.some((m) => u.includes(m))), [], `${p.title} coords in a URL`);
    }
    assert.equal(b.server.posts("/loci").length, 1, "the room demo still runs on the same click");
  });

  test("a route store whose writes fail: the room demo still shows #recall and no rejection escapes", async (t) => {
    const rejections = watchRejections(t);
    const adapter = memoryAdapter();
    adapter.state.failPuts = true;
    const { b } = start(adapter);
    await loadDemo(b);
    await settle(50);
    assert.equal(el(b, "recall").hidden, false, "#recall shown");
    assert.deepEqual(rejections, []);
  });
});
