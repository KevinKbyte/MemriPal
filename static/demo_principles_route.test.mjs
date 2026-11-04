// Covers: MEM-133
// Requirement: the app ships a default route that teaches the six principles of engaging speaking, so a new
// user sees a solid starting point (Kev, MEM-133). Contract: static/demo_route.js exports PRINCIPLES_ROUTE
// (kept as code beside DEMO_ROUTE, not only in demo_routes.json, so a failed fetch still seeds it):
// id "demo-route-principles", name "Six principles of engaging speaking", kind "daily", exactly 6 stations
// with n 1..6, unique ids, a name, coords inside the Kendall real-map bbox, and profile.conceptual (the
// station's learning point) starting with its principle, in walking order: Relevance, Curiosity, Clarity,
// Concreteness, Progression, Payoff. Load demo seeds it on a fresh store whether demo_routes.json serves,
// answers 404 or fails to fetch, keeps its learning points through the store, lists its card, and a second
// Load demo adds no duplicate.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { boot, el, find, findAll, kvAdapter, loadDemo, settle, TURNS, until, watchRejections } from "./ux_flow_harness_test.mjs";
import { memoryAdapter } from "./route_store_fakes_test.mjs";
import { createRouteStore } from "./route_store.js";
import * as demoRouteModule from "./demo_route.js";
import { inRealMapBbox } from "./real_map.js";

const ID = "demo-route-principles";
const NAME = "Six principles of engaging speaking";
const PRINCIPLES = ["Relevance", "Curiosity", "Clarity", "Concreteness", "Progression", "Payoff"];
const FILE = new URL("./data/demo_routes.json", import.meta.url);
const DEMO_ROUTES_URL = /(?:^|\/)data\/demo_routes\.json$/;

/** PRINCIPLES_ROUTE via a namespace import, so its absence fails on this assertion, not at module link. */
function principlesRoute() {
  const r = demoRouteModule.PRINCIPLES_ROUTE;
  assert.ok(r, "static/demo_route.js exports PRINCIPLES_ROUTE");
  return r;
}

const startsWithPrinciple = (text, p) => new RegExp(`^${p}\\b`, "i").test(String(text ?? "").trim());

/** Asserts the 6 stations carry the principles in walking order via profile.conceptual. */
function assertPrinciples(stations, label) {
  assert.equal(stations.length, 6, `${label}: exactly 6 stations`);
  assert.deepEqual(stations.map((s) => s.n), [1, 2, 3, 4, 5, 6], `${label}: n in order`);
  stations.forEach((s, i) => {
    const text = s.profile?.conceptual;
    assert.ok(startsWithPrinciple(text, PRINCIPLES[i]), `${label}: station ${i + 1} learning point starts with ${PRINCIPLES[i]}, got ${JSON.stringify(text)}`);
  });
}

// Covers: MEM-133
// Requirement: PRINCIPLES_ROUTE is a fixed-id 6-station Kendall route whose stations teach the six principles in order.
describe("MEM-133 PRINCIPLES_ROUTE contract", () => {
  test("fixed id, name, kind daily", () => {
    const r = principlesRoute();
    assert.equal(r.id, ID);
    assert.equal(r.name, NAME);
    assert.equal(r.kind, "daily");
  });

  test("exactly 6 stations, n 1..6, each learning point names its principle in walking order", () => {
    assertPrinciples(principlesRoute().stations, "PRINCIPLES_ROUTE");
  });

  test("every station has a unique id, a name and coords inside the Kendall real-map bbox", () => {
    const { stations } = principlesRoute();
    assert.equal(new Set(stations.map((s) => s.id)).size, stations.length, "station ids unique");
    for (const s of stations) {
      assert.ok(typeof s.id === "string" && s.id, "station id");
      assert.ok(typeof s.name === "string" && s.name.trim(), `station ${s.n} name`);
      assert.ok(Number.isFinite(s.coords?.lat) && Number.isFinite(s.coords?.lon), `station ${s.n} coords`);
    }
    assert.equal(inRealMapBbox(stations), true, "every station on the Kendall demo map");
  });

  test("its route and station ids differ from DEMO_ROUTE's", () => {
    const r = principlesRoute();
    const demo = demoRouteModule.DEMO_ROUTE;
    assert.notEqual(r.id, demo.id);
    const demoIds = new Set(demo.stations.map((s) => s.id));
    for (const s of r.stations) assert.ok(!demoIds.has(s.id), `station ${s.n} id not shared with DEMO_ROUTE`);
  });
});

/** serve: "file" answers the committed JSON, "404" a not-found, "reject" a network failure. */
function start(serve) {
  const routes = createRouteStore(memoryAdapter());
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

/** Polls the store (settle turns, no wall clock) until the principles route is stored, or fails naming it. */
async function untilPrinciplesStored(routes) {
  for (let i = 0; i < 200; i++) {
    if ((await routes.listRoutes()).some((r) => r.id === ID)) return;
    await settle(10);
  }
  const ids = (await routes.listRoutes()).map((r) => r.id);
  assert.fail(`timed out: ${ID} never stored after Load demo; stored ids ${JSON.stringify(ids)}`);
}

const cards = (b) => findAll(el(b, "routes-list"), (n) => n.tagName === "LI", { visibleOnly: true });
const openLabel = (li) => find(li, (n) => n.tagName === "BUTTON" && n.dataset.action === "open")?.getAttribute("aria-label");

// Covers: MEM-133
// Requirement: Load demo seeds the six-principles route on a fresh store even when demo_routes.json is unavailable.
describe("MEM-133 Load demo seeds the six-principles default route", () => {
  for (const serve of ["file", "404", "reject"]) {
    const how = { file: "served", 404: "answering 404", reject: "failing to fetch" }[serve];
    test(`with demo_routes.json ${how}: stored with its 6 principle stations and its card listed`, async (t) => {
      const rejections = watchRejections(t);
      const { b, routes } = start(serve);
      await loadDemo(b);
      await untilPrinciplesStored(routes);
      const r = (await routes.listRoutes()).find((x) => x.id === ID);
      assert.equal(r.name, NAME);
      assert.equal(r.status, "saved");
      assertPrinciples(r.stations, "stored route");
      await until(() => cards(b).some((li) => openLabel(li) === `Open ${NAME}`), `card Open ${NAME} listed`, TURNS);
      assert.deepEqual(rejections, []);
    });
  }

  test("a second Load demo adds no duplicate of it", async () => {
    const { b, routes } = start("404");
    await loadDemo(b);
    await untilPrinciplesStored(routes);
    await loadDemo(b);
    await settle(80);
    assert.equal((await routes.listRoutes()).filter((r) => r.id === ID).length, 1);
  });
});
