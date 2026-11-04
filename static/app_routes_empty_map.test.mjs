// Covers: MEM-114
// Requirement: a fresh profile with zero routes boots the Routes tab onto a real basemap at the default
// location with Load demo / Map a new route visible over the map (not only inside the closed drawer); once a
// route exists the call to action goes away.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { boot, el, find, findAll, kvAdapter, loadDemo, settle, TURNS, until, watchRejections } from "./ux_flow_harness_test.mjs";
import { memoryAdapter } from "./route_store_fakes_test.mjs";
import { createRouteStore } from "./route_store.js";

const FIXTURE = { status: "ok", mode: "fixture" };
const DEFAULT_CENTER = { lat: 42.3664, lon: -71.0832 };

/** Fake real-map loader: mount (station mounts) and mountAt (empty basemap) both record, resolve null. */
function fakeRealMap() {
  const calls = [];
  const atCalls = [];
  return {
    calls,
    atCalls,
    mount(svg, stations) {
      calls.push({ svg, stations: structuredClone(stations) });
      return Promise.resolve(null);
    },
    mountAt(svg, center, zoom) {
      atCalls.push({ svg, center: structuredClone(center), zoom });
      return Promise.resolve(null);
    },
  };
}

function start(adapter = memoryAdapter()) {
  const realMap = fakeRealMap();
  const b = boot({ routes: createRouteStore(adapter), realMap, rehAdapter: kvAdapter(), health: FIXTURE });
  // The harness page is flat (no parents); stand in for index.html's .map-wrap so the CTA has a mount point.
  const wrap = b.p.doc.createElement("div");
  wrap.classList.add("map-wrap");
  wrap.append(el(b, "route-map"));
  // The fake DOM has no click(); the production CTA calls getElementById(id).click().
  for (const id of ["load-demo", "routes-new"]) {
    const node = el(b, id);
    node.click = () => b.p.fire(node, "click");
  }
  return { b, realMap, adapter };
}

const ctaOf = (b) => {
  const wrap = el(b, "route-map").parentNode ?? el(b, "route-map").parent;
  return wrap && find(wrap, (n) => n.classList?.contains("empty-map-cta") || (typeof n.className === "string" && n.className.split(/\s+/).includes("empty-map-cta")));
};
const buttonOf = (cta, action) => cta && find(cta, (n) => n.tagName === "BUTTON" && n.dataset.action === action);

// Covers: MEM-114
// Requirement: a zero-route boot mounts the empty basemap at the default location, no station mount.
describe("empty route store boots onto a real basemap (MEM-114)", () => {
  test("one mountAt on #route-map at the default location, no station mount", async (t) => {
    const rejections = watchRejections(t);
    const { b, realMap } = start();
    await until(() => realMap.atCalls.length > 0, "mountAt called at boot with zero routes", TURNS);
    await settle(20);
    assert.equal(realMap.atCalls.length, 1, "exactly one mountAt");
    const [call] = realMap.atCalls;
    assert.equal(call.svg, el(b, "route-map"), "mounted on #route-map");
    assert.ok(Math.abs(call.center.lat - DEFAULT_CENTER.lat) <= 0.01, `lat ${call.center.lat}`);
    assert.ok(Math.abs(call.center.lon - DEFAULT_CENTER.lon) <= 0.01, `lon ${call.center.lon}`);
    assert.equal(realMap.calls.length, 0, "no station mount at boot");
    assert.deepEqual(rejections, []);
  });

  test("CTA with Load demo / Map a new route sits in .map-wrap while the drawer is closed", async () => {
    const { b } = start();
    await settle(50);
    const cta = ctaOf(b);
    assert.ok(cta, "an .empty-map-cta element in #route-map's parent");
    assert.ok(buttonOf(cta, "empty-load-demo"), "CTA has empty-load-demo button");
    assert.ok(buttonOf(cta, "empty-new-route"), "CTA has empty-new-route button");
    assert.ok(!el(b, "drawer").open, "#drawer is not open");
  });

  test("#empty-slogan headline is present and visible on a zero-route boot", async () => {
    const { b } = start();
    await settle(50);
    assert.equal(el(b, "empty-slogan").hidden, false, "#empty-slogan hidden on zero-route boot");
  });

  test("CTA Load demo loads the demo route like #load-demo and the CTA goes away", async (t) => {
    const rejections = watchRejections(t);
    const { b, realMap } = start();
    await settle(50);
    const btn = buttonOf(ctaOf(b), "empty-load-demo");
    assert.ok(btn, "CTA has empty-load-demo button");
    el(b, "auto").checked = true;
    b.p.fire(btn, "click");
    await until(() => !el(b, "route-view").hidden, "#route-view shown after CTA Load demo", TURNS);
    await settle(50);
    const items = findAll(el(b, "route-view-stations"), (n) => n.tagName === "LI");
    assert.equal(items.length, 6, "6 demo stations listed");
    assert.equal(realMap.calls.length, 1, "one station mount");
    assert.ok(!ctaOf(b), "empty-map-cta removed once a route exists");
    assert.equal(el(b, "empty-slogan").hidden, true, "#empty-slogan hidden once a route exists");
    assert.deepEqual(rejections, []);
  });
});

// Covers: MEM-114
// Requirement: with a stored route there is no empty basemap mount and no CTA.
describe("a stored route suppresses the empty map (MEM-114)", () => {
  test("reboot over a store holding the demo route: no mountAt, no CTA", async () => {
    const adapter = memoryAdapter();
    await loadDemo(start(adapter).b);
    const { b, realMap } = start(adapter);
    await settle(100);
    assert.equal(realMap.atCalls.length, 0, "no mountAt with a stored route");
    assert.ok(!ctaOf(b), "no empty-map-cta");
    assert.equal(el(b, "empty-state").hidden, true, "#empty-state hidden with a stored route");
    assert.equal(el(b, "empty-slogan").hidden, true, "#empty-slogan hidden with a stored route");
  });
});
