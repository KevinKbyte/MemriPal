// Covers: MEM-114
// Requirement: the real-map loader can mount the basemap at a center point with no stations (Routes tab empty state), reusing the self-hosted extract, theme and resize handling.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { settle } from "./fake_dom_test.mjs";
import { REAL_MAP_BBOX } from "./real_map.js";
import { LONDON, hasClass, rig, setSize } from "./real_map_overlay_fakes_test.mjs";

const KENDALL_CENTER = { lat: 42.3664, lon: -71.0832 };
const extractCalls = (r) => r.fetch.calls.filter((u) => u.endsWith("kendall.pmtiles"));

describe("real-map loader mountAt (center, no stations)", () => {
  test("mounts at the center: fetches the extract and builds the Map with center/zoom, no bounds, same maxBounds", async () => {
    const r = rig();
    const res = await r.loader.mountAt(r.svg, KENDALL_CENTER, 15);
    assert.ok(res?.map, "mountAt resolves { map }");
    assert.equal(extractCalls(r).length, 1);
    assert.equal(r.libs.maps.length, 1);
    const opts = r.libs.maps[0].opts;
    assert.deepEqual(opts.center, [-71.0832, 42.3664]);
    assert.equal(opts.zoom, 15);
    assert.equal("bounds" in opts, false);
    assert.deepEqual(opts.maxBounds, [[REAL_MAP_BBOX.west, REAL_MAP_BBOX.south], [REAL_MAP_BBOX.east, REAL_MAP_BBOX.north]]);
  });

  test("box has real-map + real-map-pending, pending clears on first idle, no overlay attached", async () => {
    const r = rig({ stations: [] });
    const res = await r.loader.mountAt(r.svg, KENDALL_CENTER, 15);
    const box = res.map.getContainer();
    assert.ok(hasClass(box, "real-map"));
    assert.ok(hasClass(box, "real-map-pending"));
    setSize(box, 375, 300);
    res.map.emit("load");
    res.map.emit("idle");
    await settle(5);
    assert.equal(hasClass(box, "real-map-pending"), false);
    assert.equal(hasClass(r.svg, "route-map-overlay"), false);
  });

  test("a center outside REAL_MAP_BBOX resolves null and constructs no Map", async () => {
    const r = rig();
    const res = await r.loader.mountAt(r.svg, { lat: LONDON[0], lon: LONDON[1] }, 15);
    assert.equal(res, null);
    assert.equal(r.libs.maps.length, 0);
  });

  test("a later mount on the same svg removes the mountAt map", async () => {
    const r = rig();
    const first = await r.loader.mountAt(r.svg, KENDALL_CENTER, 15);
    assert.ok(first?.map, "mountAt resolves { map }");
    await r.loader.mount(r.svg, r.stations);
    assert.equal(first.map.removed, true);
  });
});
