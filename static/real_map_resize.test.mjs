// Covers: MEM-096
// Requirement: the real Kendall map is never stuck blank. A map mounted while its box is 0x0 (the route view
// not laid out yet) grows to fill the box once the box gains size: the loader watches the map's host box with
// win.ResizeObserver and calls map.resize() when the observed box is non-zero (MapLibre 5 skips its own
// observer's first callback, so it never does this itself). A 0x0 box never triggers a resize; the observer is
// disconnected when the map is removed (a remount of the same svg); without win.ResizeObserver the map still
// mounts, as before.
// Contract (RED; GREEN implements static/real_map.js):
//   createRealMapLoader({ fetch, loadLibs, doc, win }) uses new win.ResizeObserver(callback) and observes
//   map.getContainer() (the .real-map box). callback(entries) with a non-zero entry for that box -> map.resize().
//   The box's size is reported both in the entry (contentRect, contentBoxSize, borderBoxSize) and on the element
//   (clientWidth/clientHeight, getBoundingClientRect), so either reading works.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { settle } from "./fake_dom_test.mjs";
import { createRealMapLoader } from "./real_map.js";
import { rig, setSize } from "./real_map_overlay_fakes_test.mjs";

/** ResizeObserver fake: records every instance, its observed targets, unobserve and disconnect calls. */
function fakeResizeObserverClass() {
  const instances = [];
  class FakeResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.observed = [];
      this.unobserved = [];
      this.disconnected = false;
      instances.push(this);
    }
    observe(target, options) {
      this.observed.push({ target, options });
    }
    unobserve(target) {
      this.unobserved.push(target);
    }
    disconnect() {
      this.disconnected = true;
    }
    /** Browser-shaped delivery: sizes the element, then calls back with one entry per target. */
    fire(target, w, h) {
      setSize(target, w, h);
      const rect = { x: 0, y: 0, left: 0, top: 0, width: w, height: h, right: w, bottom: h };
      const box = [{ inlineSize: w, blockSize: h }];
      this.callback([{ target, contentRect: rect, contentBoxSize: box, borderBoxSize: box,
        devicePixelContentBoxSize: box }], this);
    }
  }
  return { FakeResizeObserver, instances };
}

/**
 * The overlay rig (real sketch, fake MapLibre), with a second loader over a win that may carry a
 * ResizeObserver. Mount resolves { map }; map.resize and map.remove are wrapped to record calls, and
 * remove() emits "remove" afterwards, as MapLibre does.
 */
async function mountWith({ resizeObserver = true } = {}) {
  const base = rig();
  const ro = fakeResizeObserverClass();
  const win = {
    matchMedia: (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }),
    location: { origin: "https://app.test", href: "https://app.test/" },
    requestAnimationFrame: (fn) => setImmediate(fn),
    ...(resizeObserver ? { ResizeObserver: ro.FakeResizeObserver } : {}),
  };
  const loader = createRealMapLoader({ fetch: base.fetch, loadLibs: base.libs.loadLibs, doc: base.doc, win });
  const mount = async () => {
    const res = await loader.mount(base.svg, base.stations);
    if (res?.map) instrument(res.map);
    return res;
  };
  return { ...base, ro, win, loader, mount };
}

/** @param {any} map */
function instrument(map) {
  map.resizeCalls = 0;
  const resize = map.resize.bind(map);
  map.resize = (...args) => {
    map.resizeCalls += 1;
    return resize(...args);
  };
  const remove = map.remove.bind(map);
  map.remove = () => {
    remove();
    map.emit("remove");
  };
}

/** The observer instances watching el. */
const watching = (instances, el) => instances.filter((o) => o.observed.some((x) => x.target === el));

describe("real map: resizes when its box gains size (MEM-096)", () => {
  test("the map's host box is observed with win.ResizeObserver after mount", async () => {
    const r = await mountWith();
    const res = await r.mount();
    assert.ok(res?.map, "map created");
    const box = res.map.getContainer();
    assert.ok(box, "map has a host box");
    const obs = watching(r.ro.instances, box);
    assert.equal(obs.length, 1, `observers watching the map box: ${obs.length} of ${r.ro.instances.length} created`);
  });

  test("a first callback reporting 1189x900 -> map.resize() called once", async () => {
    const r = await mountWith();
    const res = await r.mount();
    const box = res.map.getContainer();
    const [obs] = watching(r.ro.instances, box);
    assert.ok(obs, "the map box is observed");
    obs.fire(box, 1189, 900);
    await settle(5);
    assert.equal(res.map.resizeCalls, 1, "map.resize() calls after a 1189x900 callback");
  });

  test("a 0x0 callback -> no resize; a later non-zero callback -> one resize", async () => {
    const r = await mountWith();
    const res = await r.mount();
    const box = res.map.getContainer();
    const [obs] = watching(r.ro.instances, box);
    assert.ok(obs, "the map box is observed");
    obs.fire(box, 0, 0);
    await settle(5);
    assert.equal(res.map.resizeCalls, 0, "map.resize() calls after a 0x0 callback");
    obs.fire(box, 1189, 900);
    await settle(5);
    assert.equal(res.map.resizeCalls, 1, "map.resize() calls once the box gains size");
  });

  test("map removed by a remount of the same svg -> its observer is disconnected", async () => {
    const r = await mountWith();
    const first = await r.mount();
    const box = first.map.getContainer();
    const [obs] = watching(r.ro.instances, box);
    assert.ok(obs, "the first map's box is observed");
    const second = await r.mount();
    assert.ok(second?.map && second.map !== first.map, "the remount made a new map");
    assert.equal(first.map.removed, true, "the first map was removed");
    assert.ok(obs.disconnected || obs.unobserved.includes(box),
      "the first map's observer stopped watching its box (disconnect or unobserve)");
  });

  test("no win.ResizeObserver -> mount still resolves { map } without throwing", async () => {
    const r = await mountWith({ resizeObserver: false });
    const res = await r.mount();
    assert.ok(res?.map, "mount resolves { map }");
    assert.equal(r.libs.maps.length, 1, "one map instance");
  });
});
