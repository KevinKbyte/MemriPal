// Covers: MEM-114
// Requirement: with zero routes the Routes tab shows a real basemap centered on the default location (Meta, Kendall Square) with Load demo and Map a new route calls to action over the map, reusing the existing #load-demo / #routes-new handlers.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fakePage, findAll, settle } from "./fake_dom_test.mjs";
import { inRealMapBbox } from "./real_map.js";
import { EMPTY_MAP_CENTER, EMPTY_MAP_ZOOM, SLOGAN, createEmptyMap } from "./routes_empty_map.js";

function setup(realMapOverride) {
  const page = fakePage(["route-map", "load-demo", "routes-new"]);
  const wrap = page.doc.createElement("div");
  wrap.append(page.els["route-map"]);
  for (const id of ["load-demo", "routes-new"]) {
    page.els[id].clicks = 0;
    page.els[id].click = () => {
      page.els[id].clicks += 1;
    };
  }
  const realMap = realMapOverride ?? {
    calls: [],
    mountAt(svg, center, zoom) {
      this.calls.push({ svg, center, zoom });
      return Promise.resolve(null);
    },
  };
  const map = createEmptyMap({ doc: page.doc, realMap });
  const ctas = () => findAll(wrap, (n) => n.classList.contains("empty-map-cta"));
  const button = (action) => findAll(wrap, (n) => n.dataset.action === action)[0];
  return { page, wrap, realMap, map, ctas, button };
}

describe("empty Routes map (MEM-114)", () => {
  test("default center is Kendall Square, inside the real-map bbox, with a street-level zoom", () => {
    assert.ok(Object.isFrozen(EMPTY_MAP_CENTER));
    assert.ok(Math.abs(EMPTY_MAP_CENTER.lat - 42.3664) < 0.01);
    assert.ok(Math.abs(EMPTY_MAP_CENTER.lon - -71.0832) < 0.01);
    assert.equal(inRealMapBbox([{ coords: EMPTY_MAP_CENTER }]), true);
    assert.ok(EMPTY_MAP_ZOOM >= 13 && EMPTY_MAP_ZOOM <= 16);
  });

  test("show() mounts the basemap once at the default center and adds the two CTA buttons", () => {
    const { page, realMap, map, ctas, button } = setup();
    map.show();
    assert.equal(realMap.calls.length, 1);
    assert.equal(realMap.calls[0].svg, page.els["route-map"]);
    assert.deepEqual(realMap.calls[0].center, EMPTY_MAP_CENTER);
    assert.equal(realMap.calls[0].zoom, EMPTY_MAP_ZOOM);
    assert.equal(ctas().length, 1);
    assert.equal(ctas()[0].parent, page.els["route-map"].parentElement);
    assert.equal(button("empty-load-demo").textContent, "Load demo");
    assert.equal(button("empty-new-route").textContent, "Map a new route");
  });

  test("show() puts the slogan in the CTA overlay and exports SLOGAN", () => {
    assert.equal(SLOGAN, "Find a home for every memory");
    const { map, ctas } = setup();
    map.show();
    assert.ok(ctas()[0].textContent.includes("Find a home for every memory"));
  });

  test("CTA buttons reuse the existing #load-demo and #routes-new handlers", () => {
    const { page, map, button } = setup();
    map.show();
    page.fire(button("empty-load-demo"), "click");
    assert.equal(page.els["load-demo"].clicks, 1);
    assert.equal(page.els["routes-new"].clicks, 0);
    page.fire(button("empty-new-route"), "click");
    assert.equal(page.els["routes-new"].clicks, 1);
    assert.equal(page.els["load-demo"].clicks, 1);
  });

  test("show() twice is idempotent; hide() removes the CTA and show() re-mounts", () => {
    const { realMap, map, ctas } = setup();
    map.show();
    map.show();
    assert.equal(realMap.calls.length, 1);
    assert.equal(ctas().length, 1);
    map.hide();
    assert.equal(ctas().length, 0);
    map.show();
    assert.equal(realMap.calls.length, 2);
    assert.equal(ctas().length, 1);
  });

  test("a realMap without mountAt, or undefined, still shows the CTA without throwing", () => {
    for (const rm of [{}, undefined]) {
      const page = fakePage(["route-map", "load-demo", "routes-new"]);
      const wrap = page.doc.createElement("div");
      wrap.append(page.els["route-map"]);
      const map = createEmptyMap({ doc: page.doc, realMap: rm });
      assert.doesNotThrow(() => map.show());
      assert.equal(findAll(wrap, (n) => n.classList.contains("empty-map-cta")).length, 1);
    }
  });

  test("a mountAt that rejects causes no unhandled rejection", async () => {
    const seen = [];
    const onRej = (e) => seen.push(e);
    process.on("unhandledRejection", onRej);
    try {
      const { map, ctas } = setup({ mountAt: () => Promise.reject(new Error("tiles down")) });
      map.show();
      await settle();
      assert.equal(ctas().length, 1);
    } finally {
      process.off("unhandledRejection", onRej);
    }
    assert.deepEqual(seen, []);
  });
});
