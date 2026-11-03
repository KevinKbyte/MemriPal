// Covers: MEM-076
// Requirement: the route view mounts the real Kendall map over its SVG sketch on both route maps, S5
// #route-map (opening a route) and S8 #recall-map (Practice this route), without ever blanking or delaying
// the sketch (plan S3, "route_view.js mounts it on #route-map / #recall-map for in-bbox geo routes").
// Dep shape (the implementer follows this):
//   wireApp(deps) takes an optional deps.realMap and forwards it unchanged to
//   createRouteView({ doc, routes, rehearsals, onPractice, realMap }). realMap is the object
//   createRealMapLoader(...) returns: { mount(svg, stations) -> Promise<{ map } | null> }. Absent -> sketch only.
//   renderRoute calls realMap.mount(#route-map svg, route.stations) once per route-view entry, and practice
//   calls realMap.mount(#recall-map svg, route.stations) once per Practice click, each AFTER
//   renderRouteMap has drawn that svg's sketch. Neither awaits the mount (fire and forget, rejection
//   swallowed): the route view and #recall show while the mount is still pending, and onPractice still
//   receives renderRouteMap's { nodes, light, finish }, whose finish marks the sketch nodes at the run's end.
//   A London or coord-less route never fetches the extract (route_view may skip mount via inRealMapBbox or
//   leave the bbox check to the loader, which resolves null without fetching); the sketch stays drawn.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { boot, click, deferred, el, find, findAll, kvAdapter, settle, TURNS, until, watchRejections } from "./ux_flow_harness_test.mjs";
import { memoryAdapter } from "./route_store_fakes_test.mjs";
import { createRouteStore } from "./route_store.js";

const FIXTURE = { status: "ok", mode: "fixture" };
// ADR 0041 extract bbox; the fake loader below applies it the way the real loader does.
const BBOX = { west: -71.1083, south: 42.3494, east: -71.0719, north: 42.3764 };
const KENDALL = [[42.36238, -71.0856], [42.36265, -71.08441], [42.36385, -71.08347], [42.36554, -71.0809]];
const LONDON = [[51.5074, -0.1278], [51.5081, -0.1269], [51.5093, -0.1255], [51.5101, -0.1249]];
const NAMES = ["red bench", "old oak", "stone arch", "blue gate"];

function geoRoute(id, name, pts) {
  const stations = NAMES.map((n, i) => {
    const s = { id: `${id}-st-${i + 1}`, n: i + 1, name: n, photo_ref: `${id}-ph-${i + 1}`, status: "named",
      taps: { turn: "Left" } };
    if (pts) s.coords = { lat: pts[i][0], lon: pts[i][1] };
    return s;
  });
  return { id, name, kind: "daily", status: "saved", created_at: "2026-11-02T08:00:00.000Z", stations, lists: [] };
}

const KENDALL_ROUTE = geoRoute("rk", "Kendall walk", KENDALL);
const LONDON_ROUTE = geoRoute("rl", "London walk", LONDON);
const BARE_ROUTE = geoRoute("rb", "No-GPS walk", null);

function seededRoutes(list) {
  const adapter = memoryAdapter();
  const photo = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x03, 0x42, 0xff, 0xd9]);
  for (const r of list) {
    adapter.map.set(`route:${r.id}`, structuredClone({ type: "route", route: r }));
    for (const s of r.stations) adapter.map.set(`photo:${s.photo_ref}`, { type: "photo", bytes: photo });
  }
  return adapter;
}

const inBbox = (stations) => stations.length > 0 && stations.every((s) => {
  const lat = s?.coords?.lat;
  const lon = s?.coords?.lon;
  return Number.isFinite(lat) && Number.isFinite(lon) &&
    lat >= BBOX.south && lat <= BBOX.north && lon >= BBOX.west && lon <= BBOX.east;
});

const nodesOf = (svg) => findAll(svg, (n) => n !== svg && n.dataset?.stationId !== undefined);
const nodeIds = (svg) => nodesOf(svg).map((n) => n.dataset.stationId);

/**
 * Fake real-map loader honouring the createRealMapLoader contract: an out-of-bbox route resolves null with
 * no extract fetch; an in-bbox mount counts one extract fetch and stays pending until settle(). Records each
 * call's svg, stations and the svg's sketch node ids at call time. rejects: every mount rejects instead.
 */
function fakeRealMap({ rejects = false } = {}) {
  const calls = [];
  let extractFetches = 0;
  return {
    calls,
    extractFetches: () => extractFetches,
    settleAll(value = null) {
      for (const c of calls) c.d?.resolve(value);
    },
    mount(svg, stations) {
      const call = { svg, stations: structuredClone(stations), sketchAtCall: nodeIds(svg) };
      calls.push(call);
      if (rejects) return Promise.reject(new Error("map boom"));
      if (!inBbox(stations)) return Promise.resolve(null);
      extractFetches += 1;
      call.d = deferred();
      return call.d.promise;
    },
  };
}

async function start(list, realMap) {
  const routes = createRouteStore(seededRoutes(list));
  const b = boot({ routes, rehAdapter: kvAdapter(), health: FIXTURE, realMap });
  await until(() => findAll(el(b, "routes-list"), (n) => n.tagName === "LI", { visibleOnly: true }).length === list.length,
    `${list.length} route cards on S1`, TURNS);
  return b;
}

async function openRoute(b, name) {
  const card = findAll(el(b, "routes-list"), (n) => n.tagName === "LI", { visibleOnly: true })
    .find((li) => li.textContent.includes(name));
  assert.ok(card, `S1 has a card for ${name}`);
  const open = find(card, (n) => n.tagName === "BUTTON" && n.dataset.action === "open");
  assert.ok(open, `${name} card has an Open button`);
  b.p.fire(open, "click");
  await until(() => !el(b, "route-view").hidden, `#route-view shown for ${name}`, TURNS);
  await settle(20);
}

async function practice(b) {
  click(b, "route-view-practice");
  await until(() => !el(b, "recall").hidden, "#recall shown", TURNS);
  await settle(20);
}

const extractRequests = (b) => b.server.calls.filter((c) => /pmtiles/i.test(c.u));

// Covers: MEM-076
// Requirement: an in-bbox geo route mounts the real map once on #route-map and once on #recall-map, each
// with that view's svg and the route's stations, after the sketch is drawn and without being awaited.
describe("route view mounts the real map for an in-bbox geo route (plan S3)", () => {
  test("opening the route: one mount on #route-map with the route stations, after the sketch is drawn", async (t) => {
    const rejections = watchRejections(t);
    const realMap = fakeRealMap();
    const b = await start([KENDALL_ROUTE], realMap);
    assert.equal(realMap.calls.length, 0, "nothing mounted before route-view entry");
    await openRoute(b, "Kendall walk");
    assert.equal(realMap.calls.length, 1, "exactly one mount per route-view entry");
    const [call] = realMap.calls;
    assert.equal(call.svg, el(b, "route-map"), "mounted on #route-map");
    assert.deepEqual(call.stations, KENDALL_ROUTE.stations, "mounted with the route's stations");
    assert.deepEqual(call.sketchAtCall, KENDALL_ROUTE.stations.map((s) => s.id), "sketch drawn before mount");
    assert.deepEqual(nodeIds(el(b, "route-map")), KENDALL_ROUTE.stations.map((s) => s.id), "sketch still drawn");
    realMap.settleAll();
    await settle(20);
    assert.deepEqual(rejections, []);
  });

  test("Practice: one more mount, on #recall-map, after its sketch is drawn", async (t) => {
    const rejections = watchRejections(t);
    const realMap = fakeRealMap();
    const b = await start([KENDALL_ROUTE], realMap);
    await openRoute(b, "Kendall walk");
    await practice(b);
    assert.equal(realMap.calls.length, 2, "one mount for S5 + one for S8");
    const call = realMap.calls[1];
    assert.equal(call.svg, el(b, "recall-map"), "second mount on #recall-map");
    assert.deepEqual(call.stations, KENDALL_ROUTE.stations, "mounted with the route's stations");
    assert.deepEqual(call.sketchAtCall, KENDALL_ROUTE.stations.map((s) => s.id), "recall sketch drawn before mount");
    realMap.settleAll();
    await settle(20);
    assert.deepEqual(rejections, []);
  });

  test("a pending mount delays nothing: S5 and S8 show and the sketch's finish() marks the run's result", async (t) => {
    const rejections = watchRejections(t);
    const realMap = fakeRealMap();
    const b = await start([KENDALL_ROUTE], realMap);
    await openRoute(b, "Kendall walk");
    assert.equal(realMap.calls.length, 1, "S5 mount issued (and left pending)");
    await practice(b);
    assert.equal(realMap.calls.length, 2, "S8 mount issued (and left pending)");
    assert.equal(realMap.extractFetches(), 2, "both mounts are in flight, none settled");
    click(b, "recall-start");
    await until(() => !el(b, "recall-typed").hidden, "typed box shown", TURNS);
    el(b, "recall-typed").value = "red bench";
    click(b, "recall-submit");
    const nodes = () => nodesOf(el(b, "recall-map"));
    await until(() => nodes().every((n) => n.classList.contains("lit") || n.classList.contains("missed")),
      "finish() marked every #recall-map sketch node", TURNS);
    assert.equal(nodes()[0].classList.contains("lit"), true, "station 1 (said) lit");
    assert.equal(nodes()[3].classList.contains("missed"), true, "station 4 (not said) missed");
    realMap.settleAll();
    await settle(20);
    assert.deepEqual(rejections, []);
  });

  test("a mount that rejects never escapes and leaves both sketches drawn", async (t) => {
    const rejections = watchRejections(t);
    const realMap = fakeRealMap({ rejects: true });
    const b = await start([KENDALL_ROUTE], realMap);
    await openRoute(b, "Kendall walk");
    await practice(b);
    assert.equal(realMap.calls.length, 2, "both views tried the map");
    const ids = KENDALL_ROUTE.stations.map((s) => s.id);
    assert.deepEqual(nodeIds(el(b, "route-map")), ids, "#route-map sketch intact");
    assert.deepEqual(nodeIds(el(b, "recall-map")), ids, "#recall-map sketch intact");
    await settle(20);
    assert.deepEqual(rejections, []);
  });
});

// Covers: MEM-076
// Requirement: a London or coord-less route never fetches the extract and keeps the sketch on both maps,
// while an in-bbox route in the same session still mounts.
describe("route view keeps the sketch for out-of-bbox and coord-less routes (plan S3)", () => {
  test("London and coord-less routes: 0 extract fetches, sketch drawn; a later Kendall route still mounts", async (t) => {
    const rejections = watchRejections(t);
    const realMap = fakeRealMap();
    const b = await start([LONDON_ROUTE, BARE_ROUTE, KENDALL_ROUTE], realMap);
    for (const r of [LONDON_ROUTE, BARE_ROUTE]) {
      await openRoute(b, r.name);
      await practice(b);
      const ids = r.stations.map((s) => s.id);
      assert.deepEqual(nodeIds(el(b, "route-map")), ids, `${r.name}: #route-map sketch drawn`);
      assert.deepEqual(nodeIds(el(b, "recall-map")), ids, `${r.name}: #recall-map sketch drawn`);
    }
    assert.equal(realMap.extractFetches(), 0, "no extract fetch for an out-of-bbox or coord-less route");
    assert.deepEqual(extractRequests(b), [], "the app's own fetch never asked for the extract");
    const before = realMap.calls.length;
    await openRoute(b, "Kendall walk");
    assert.equal(realMap.calls.length - before, 1, "the Kendall route mounts once on S5");
    assert.equal(realMap.calls.at(-1).svg, el(b, "route-map"));
    assert.deepEqual(extractRequests(b), [], "still no extract request through the app's fetch");
    realMap.settleAll();
    await settle(20);
    assert.deepEqual(rejections, []);
  });
});
