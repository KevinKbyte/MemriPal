// Covers: MEM-133
// Requirement: Load demo fills the Routes tab with curated routes the planner made (MEM-133, ADR 0079): committed
// static/data/demo_routes.json holds at least "Morning commute to the T" (demo-route-commute, Meta office -> Kendall
// T), "Coffee run" (demo-route-coffee, Meta office -> a cafe) and "Landmark loop" (demo-route-landmarks, landmarks
// counter-clockwise around their centroid), all kind daily with coords on every station and no self-crossing.
// Load demo seeds them alongside DEMO_ROUTE, idempotent by id; when demo_routes.json cannot be fetched it seeds
// none of them (DEMO_ROUTE and the in-code six-principles route, demo_principles_route.test.mjs, still seed).
// Load demo fetches it through deps.fetch at a URL ending data/demo_routes.json.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { boot, el, findAll, kvAdapter, loadDemo, settle, TURNS, until, watchRejections } from "./ux_flow_harness_test.mjs";
import { memoryAdapter } from "./route_store_fakes_test.mjs";
import { createRouteStore } from "./route_store.js";
import { DEMO_ROUTE } from "./demo_route.js";

const FILE = new URL("./data/demo_routes.json", import.meta.url);
const IDS = ["demo-route-commute", "demo-route-coffee", "demo-route-landmarks"];
const POIS = JSON.parse(readFileSync(new URL("./data/kendall_pois.json", import.meta.url), "utf8"));

function demoRoutes() {
  let text;
  try {
    text = readFileSync(FILE, "utf8");
  } catch (err) {
    assert.fail(`static/data/demo_routes.json must be committed (${err.code ?? err})`);
  }
  return JSON.parse(text);
}

const pts = (r) => r.stations.map((s) => ({ x: s.coords.lon, y: s.coords.lat }));
const orient = (a, b, c) => Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
const crosses = (p1, p2, p3, p4) => orient(p1, p2, p3) * orient(p1, p2, p4) < 0 && orient(p3, p4, p1) * orient(p3, p4, p2) < 0;

/** Segments of the station path; the landmark loop is a closed polygon (last -> first included). */
function segments(r) {
  const p = pts(r);
  const segs = p.slice(0, -1).map((a, i) => [a, p[i + 1]]);
  if (r.id === "demo-route-landmarks") segs.push([p.at(-1), p[0]]);
  return segs;
}

/** Shoelace signed area, lng as x, lat as y; > 0 is counter-clockwise. */
const signedArea = (p) => p.reduce((sum, a, i) => { const b = p[(i + 1) % p.length]; return sum + a.x * b.y - b.x * a.y; }, 0) / 2;

// Covers: MEM-133
// Requirement: the committed curated routes are well formed, fixed-id, located and never cross themselves.
describe("MEM-133 committed demo_routes.json", () => {
  test(">= 3 routes with the fixed ids, kind daily, names as specified", () => {
    const routes = demoRoutes();
    assert.ok(Array.isArray(routes) && routes.length >= 3, `>= 3 routes, got ${routes?.length}`);
    const byId = new Map(routes.map((r) => [r.id, r]));
    for (const id of IDS) assert.ok(byId.has(id), `${id} present`);
    assert.equal(byId.size, routes.length, "ids unique");
    assert.equal(byId.get("demo-route-commute").name, "Morning commute to the T");
    assert.equal(byId.get("demo-route-coffee").name, "Coffee run");
    assert.equal(byId.get("demo-route-landmarks").name, "Landmark loop");
    for (const r of routes) assert.equal(r.kind, "daily", r.id);
  });

  test("every station has an id, its n in order, a name and finite coords", () => {
    for (const r of demoRoutes()) {
      assert.ok(r.stations.length >= 2, `${r.id} has >= 2 stations`);
      assert.deepEqual(r.stations.map((s) => s.n), r.stations.map((_, i) => i + 1), r.id);
      assert.equal(new Set(r.stations.map((s) => s.id)).size, r.stations.length, `${r.id} station ids unique`);
      for (const s of r.stations) {
        assert.ok(typeof s.id === "string" && s.id && typeof s.name === "string" && s.name, `${r.id} station id + name`);
        assert.ok(Number.isFinite(s.coords?.lat) && Number.isFinite(s.coords?.lon), `${r.id} ${s.name} coords`);
      }
    }
  });

  test("commute runs Meta office -> Kendall/MIT T; coffee runs Meta office -> a cafe POI", () => {
    const byId = new Map(demoRoutes().map((r) => [r.id, r]));
    const commute = byId.get("demo-route-commute").stations;
    assert.equal(commute[0].name, "Meta office");
    assert.equal(commute.at(-1).name, "Kendall/MIT T");
    const coffee = byId.get("demo-route-coffee").stations;
    assert.equal(coffee[0].name, "Meta office");
    const end = coffee.at(-1).name;
    assert.ok(POIS.some((p) => p.name === end), `${end} is a committed POI`);
    assert.match(end, /caf|coffee|starbucks|blue bottle|dunkin/i);
  });

  test("no two non-adjacent station segments of any route cross", () => {
    for (const r of demoRoutes()) {
      const segs = segments(r);
      const closed = r.id === "demo-route-landmarks";
      for (let i = 0; i < segs.length; i++) {
        for (let j = i + 2; j < segs.length; j++) {
          if (closed && i === 0 && j === segs.length - 1) continue; // adjacent through the closing vertex
          assert.ok(!crosses(...segs[i], ...segs[j]), `${r.id}: segment ${i + 1} crosses segment ${j + 1}`);
        }
      }
    }
  });

  test("the landmark loop has >= 3 stations and runs counter-clockwise (signed area > 0)", () => {
    const loop = demoRoutes().find((r) => r.id === "demo-route-landmarks");
    assert.ok(loop.stations.length >= 3);
    assert.ok(signedArea(pts(loop)) > 0, `signed area ${signedArea(pts(loop))}`);
  });
});

const DEMO_ROUTES_URL = /(?:^|\/)data\/demo_routes\.json$/;

/** serve: "file" answers the committed JSON, "404" a not-found, "reject" a network failure. */
function start(serve = "file", adapter = memoryAdapter()) {
  const routes = createRouteStore(adapter);
  const realMap = { mount: () => Promise.resolve(null) };
  const extra = (u, method) => {
    if (method !== "GET" || !DEMO_ROUTES_URL.test(u)) return undefined;
    if (serve === "reject") return Promise.reject(new TypeError("Failed to fetch"));
    if (serve === "404") return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    return new Response(readFileSync(FILE, "utf8"), { headers: { "content-type": "application/json" } });
  };
  const b = boot({ routes, realMap, rehAdapter: kvAdapter(), health: { status: "ok", mode: "fixture" }, extra });
  return { b, routes };
}

/** Polls the store (settle turns, no wall clock) until pred(route count) holds. */
async function untilStored(routes, pred, label) {
  for (let i = 0; i < 200; i++) {
    if (pred((await routes.listRoutes()).length)) return;
    await settle(10);
  }
  assert.fail(`timed out: ${label}`);
}

const cards = (b) => findAll(el(b, "routes-list"), (n) => n.tagName === "LI", { visibleOnly: true });
const ids = async (routes) => (await routes.listRoutes()).map((r) => r.id).sort();

// Covers: MEM-133
// Requirement: Load demo seeds the curated routes alongside DEMO_ROUTE, idempotent by id; a fetch failure seeds
// none of the curated routes (DEMO_ROUTE still seeds) and never breaks the room demo.
describe("MEM-133 Load demo seeds the curated routes", () => {
  test("after Load demo the Routes tab lists DEMO_ROUTE plus every curated route", async (t) => {
    const rejections = watchRejections(t);
    const want = [DEMO_ROUTE.id, ...demoRoutes().map((r) => r.id)].sort();
    const { b, routes } = start();
    await loadDemo(b);
    await untilStored(routes, (n) => n >= want.length, `${want.length} routes stored`);
    await settle(80);
    const got = await ids(routes);
    for (const id of want) assert.ok(got.includes(id), `${id} stored`);
    assert.equal(new Set(got).size, got.length, "ids unique");
    for (const id of IDS) assert.ok(want.includes(id));
    await until(() => cards(b).length === got.length, `${got.length} route cards listed`, TURNS);
    assert.ok(cards(b).length >= 3);
    assert.deepEqual(rejections, []);
  });

  test("a second Load demo adds no duplicate", async () => {
    const want = [DEMO_ROUTE.id, ...demoRoutes().map((r) => r.id)].sort();
    const { b, routes } = start();
    await loadDemo(b);
    await untilStored(routes, (n) => n >= want.length, "first seed done");
    await settle(80);
    const first = await ids(routes);
    await loadDemo(b);
    await settle(80);
    assert.deepEqual(await ids(routes), first);
    for (const id of want) assert.ok(first.includes(id), `${id} stored`);
  });

  for (const serve of ["404", "reject"]) {
    test(`demo_routes.json ${serve === "404" ? "answering 404" : "failing to fetch"} seeds DEMO_ROUTE, no curated route`, async (t) => {
      const rejections = watchRejections(t);
      const { b, routes } = start(serve);
      await loadDemo(b);
      await untilStored(routes, (n) => n >= 1, "DEMO_ROUTE stored");
      await settle(80);
      const got = await ids(routes);
      assert.ok(got.includes(DEMO_ROUTE.id), "DEMO_ROUTE stored");
      for (const id of IDS) assert.ok(!got.includes(id), `${id} not stored without demo_routes.json`);
      assert.equal(el(b, "recall").hidden, false, "the room demo still shows #recall");
      assert.deepEqual(rejections, []);
    });
  }
});
