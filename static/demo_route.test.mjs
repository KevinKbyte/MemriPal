// Covers: MEM-077
// Requirement: the demo route is the Kendall walk the real map was designed around (plan S6, MEM-077
// product rule): Kendall/MIT station -> Meta office, 100 Binney St, with the 6 stations of
// docs/design/map/preview.js STATIONS in that order. Each station's coords {lat, lon} equal the
// preview's [lng, lat] (within 1e-4, the store's 4 dp), every station is inside the extract bbox
// (REAL_MAP_BBOX) so the route renders on the real map, never the sketch, and the stop count is 3-8
// (ADR 0031). The route is walkable from the station list alone: each station name is the preview's
// title (where the walker is and which way to go next), at most 100 chars. Backups never carry
// coordinates (ADR 0033), so the demo route does not live in fixtures/demo/route_backup.json.
// Contract (RED; GREEN adds static/demo_route.js):
//   export const DEMO_ROUTE = { id: <uuid>, name: <non-empty string>, kind: "daily",
//     stations: [{ id: <uuid>, n: 1..6, name: <preview title>, coords: { lat: number, lon: number } }, ...] }
//   Station shape = static/route_store.js Station, so route_view's realMap.mount(svg, route.stations)
//   takes DEMO_ROUTE.stations as is.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { settle } from "./fake_dom_test.mjs";
import { REAL_MAP_BBOX, inRealMapBbox } from "./real_map.js";
import { rig, setSize, stationNodes } from "./real_map_overlay_fakes_test.mjs";
import { MAX_STATIONS, MIN_SAVE_STATIONS } from "./route_store.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** preview.js STATIONS, read from the design source of truth: [{ lng, lat, title }] in order. */
function previewStations() {
  const text = readFileSync(new URL("../docs/design/map/preview.js", import.meta.url), "utf8");
  const block = text.slice(text.indexOf("var STATIONS = ["), text.indexOf("];", text.indexOf("var STATIONS = [")));
  const re = /lngLat:\s*\[\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\][\s\S]*?title:\s*"([^"]*)"/g;
  return [...block.matchAll(re)].map(([, lng, lat, title]) => ({ lng: Number(lng), lat: Number(lat), title }));
}

/** The demo route module, or {} while it does not exist (so RED fails on assertions, not on load). */
async function demo() {
  const mod = await import("./demo_route.js").catch(() => ({}));
  assert.ok(mod.DEMO_ROUTE, "static/demo_route.js exports DEMO_ROUTE");
  return mod.DEMO_ROUTE;
}

describe("demo route on Kendall streets (MEM-077, plan S6)", () => {
  test("precondition: preview.js STATIONS has 6 Kendall stations, Kendall/MIT first, Meta last", () => {
    const p = previewStations();
    assert.equal(p.length, 6);
    assert.ok(p[0].title.startsWith("Kendall/MIT station"), p[0].title);
    assert.ok(p[5].title.startsWith("Meta office, 100 Binney St"), p[5].title);
  });

  test("route identity: uuid id, non-empty name, kind daily", async () => {
    const r = await demo();
    assert.match(String(r.id), UUID_RE);
    assert.ok(typeof r.name === "string" && r.name.trim() !== "", "route has a name");
    assert.equal(r.kind, "daily");
  });

  test("6 stations numbered 1..6 with unique uuid ids; stop count within 3-8 (ADR 0031)", async () => {
    const r = await demo();
    assert.ok(Array.isArray(r.stations), "stations is an array");
    assert.deepEqual(r.stations.map((s) => s.n), [1, 2, 3, 4, 5, 6]);
    assert.ok(r.stations.length >= MIN_SAVE_STATIONS && r.stations.length <= MAX_STATIONS);
    for (const s of r.stations) assert.match(String(s.id), UUID_RE, `station ${s.n} id`);
    assert.equal(new Set(r.stations.map((s) => s.id)).size, r.stations.length, "station ids unique");
  });

  test("station coords equal preview.js lngLat, in order (within 1e-4)", async () => {
    const r = await demo();
    const p = previewStations();
    assert.equal(r.stations.length, p.length);
    r.stations.forEach((s, i) => {
      assert.equal(typeof s.coords?.lat, "number", `station ${i + 1} lat`);
      assert.equal(typeof s.coords?.lon, "number", `station ${i + 1} lon`);
      assert.ok(Math.abs(s.coords.lat - p[i].lat) <= 1e-4, `station ${i + 1} lat ${s.coords.lat} vs ${p[i].lat}`);
      assert.ok(Math.abs(s.coords.lon - p[i].lng) <= 1e-4, `station ${i + 1} lon ${s.coords.lon} vs ${p[i].lng}`);
    });
  });

  test("walkable from the list: each name is the preview title, <= 100 chars; first Kendall/MIT, last Meta", async () => {
    const r = await demo();
    const p = previewStations();
    assert.deepEqual(r.stations.map((s) => s.name), p.map((x) => x.title));
    for (const s of r.stations) assert.ok(s.name.length <= 100, `station ${s.n} name length ${s.name.length}`);
    assert.ok(r.stations[0].name.startsWith("Kendall/MIT station"));
    assert.ok(r.stations.at(-1).name.startsWith("Meta office, 100 Binney St"));
  });

  test("criterion 1: every station inside the extract bbox (real map, not sketch)", async () => {
    const r = await demo();
    const { west, south, east, north } = REAL_MAP_BBOX;
    for (const s of r.stations) {
      const { lat, lon } = s.coords ?? {};
      assert.ok(lat >= south && lat <= north && lon >= west && lon <= east, `station ${s.n} at ${lat},${lon}`);
    }
    assert.equal(inRealMapBbox(r.stations), true);
  });

  test("criterion 4 (unit): the loader mounts a real map for the demo route and draws all 6 stations", async () => {
    const r = await demo();
    const page = rig({ stations: r.stations });
    const res = await page.loader.mount(page.svg, page.stations);
    assert.ok(res?.map, "a real map was created for the demo route");
    setSize(res.map.getContainer(), 375, 300);
    res.map.emit("load");
    res.map.emit("idle");
    await settle(5);
    assert.equal(stationNodes(page.svg).length, 6, "6 station markers on the overlay");
  });
});
