// Covers: MEM-077
// Requirement: on the real Kendall map the route is drawn once, in one SVG overlay, never in the map style.
// On the map's first idle the route view's sketch svg itself becomes that overlay: class
// route-map-overlay, visible, inside the map container (which clips it, Q1), viewBox "0 0 <container
// width> <container height>" in px. Every station node (cx/cy) and every route-line point comes from
// map.project([lon, lat]) and is re-projected on the map's move and resize events (plan S4 criterion 1:
// within 1 px after a pan and a zoom). Stations are always drawn, never culled: marker count == station
// count at every viewport (criterion 2; culling is for off-route landmarks only, ADR 0038 rule 3, and the
// app has none yet). Q2: a station whose projected spot is off the map is pinned to the nearest point inside
// the edge insets (24 px sides, 48 px top, 24 px bottom), gets class lm-pinned and an .lm-arrow rotated
// toward its true spot through the transform attribute; a station on the map is never pinned (one inside
// the inset band is nudged inward, unpinned). Positions are attributes only, never a style attribute (CSP).
// The sketch's renderRouteMap light/finish controller keeps marking the same nodes on the overlay. The
// map canvas container is aria-hidden="true" (the station list stays the accessible path); attribution
// stays visible, uncollapsed, at 375 px; 0 route layers or sources reach the map in either style; one
// out-of-bbox station keeps the sketch with 0 extract fetches (criteria 3-6; spec MEM-077, ADR 0041).
// Contract (RED; GREEN extends static/real_map.js createRealMapLoader(...).mount):
//   On the first "idle": svg gains class route-map-overlay (classList or class attribute), loses hidden,
//   moves inside map.getContainer(), gets viewBox "0 0 W H" with W/H = container clientWidth/clientHeight.
//   Station nodes = the svg's existing elements with class route-node and data-station-id (the very
//   nodes renderRouteMap returned; matched to stations by id); cx/cy set from map.project. Each
//   .route-line polyline gets points from map.project of the stations, in route order.
//   map.on("move") and map.on("resize") re-project (viewBox follows the container on resize).
//   Pinned: x = clamp(p.x, 24, W - 24), y = clamp(p.y, 48, H - 24) for every station (on-map ones in the
//   band are nudged); lm-pinned iff p.x < 0 || p.y < 0 || p.x > W || p.y > H. Arrow: an element with class
//   lm-arrow that is a child of the station node or carries the same data-station-id; its transform
//   attribute contains rotate(<deg>), deg = atan2(p.y - y, p.x - x) in degrees. No overlay element has a
//   style attribute. map.getCanvasContainer() gets aria-hidden="true" by the time mount resolves.
//   Fake map surface: static/real_map_overlay_fakes_test.mjs (no querySelector: walk svg.children).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { findAll, settle } from "./fake_dom_test.mjs";
import {
  CENTER,
  IDS,
  KENDALL,
  LONDON,
  descendantOf,
  hasClass,
  lonLat,
  mountIdle,
  moveTo,
  nodeFor,
  offIds,
  rig,
  setSize,
  stationNodes,
  stationsAt,
} from "./real_map_overlay_fakes_test.mjs";

// Edge insets restated from the spec (preview.js PIN_SIDE / PIN_TOP / PIN_BOTTOM), not imported.
const PIN_SIDE = 24;
const PIN_TOP = 48;
const PIN_BOTTOM = 24;

// Pans (centres inside the bbox). At 375x300: WEST puts st-1 off the left edge and st-2 inside the left
// inset band; NORTH puts st-4 off the top; SOUTH_EAST puts st-1/st-2 off the bottom and st-4 off the right;
// FAR_NORTH puts every station off the bottom at all three viewports.
const WEST = [-71.08, 42.36396];
const NORTH = [-71.08325, 42.362];
const SOUTH_EAST = [-71.087, 42.3655];
const FAR_NORTH = [-71.08325, 42.374];
const VIEWPORTS = [[375, 300], [768, 400], [1280, 600]];

const pointOf = (n) => ({ x: Number(n.getAttribute("cx")), y: Number(n.getAttribute("cy")) });
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const angleDiff = (a, b) => Math.abs(((((a - b) % 360) + 540) % 360) - 180);
const readStatic = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** The sketch svg has become the overlay: class, visible, inside the (clipping) map container. */
function assertOverlay(svg, map) {
  assert.ok(hasClass(svg, "route-map-overlay"), `svg class: ${svg.getAttribute("class") ?? ""}`);
  assert.equal(svg.hidden, false, "overlay visible");
  assert.equal(svg.getAttribute("hidden"), null, "overlay has no hidden attribute");
  assert.ok(descendantOf(svg, map.getContainer()), "overlay inside the map container");
}

function assertOnProjection(svg, map, stations, label) {
  for (const s of stations) {
    const n = nodeFor(svg, s.id);
    assert.ok(n, `${label}: node for ${s.id} in the overlay`);
    const p = map.project(lonLat(s));
    const got = pointOf(n);
    assert.ok(near(got.x, p.x) && near(got.y, p.y),
      `${label}: ${s.id} at (${got.x}, ${got.y}), map.project (${p.x.toFixed(1)}, ${p.y.toFixed(1)})`);
  }
}

function assertLineOnProjection(svg, map, stations, label) {
  const lines = findAll(svg, (n) => n !== svg && hasClass(n, "route-line")).map((l) =>
    String(l.getAttribute("points") ?? "").trim().split(/\s+/).filter(Boolean).map((xy) => xy.split(",").map(Number)));
  assert.ok(lines.length >= 1, `${label}: a route-line in the overlay`);
  const want = stations.map((s) => map.project(lonLat(s)));
  for (const pts of lines) {
    assert.equal(pts.length, want.length, `${label}: one line point per station`);
    pts.forEach(([x, y], i) => assert.ok(near(x, want[i].x) && near(y, want[i].y),
      `${label}: line point ${i} (${x}, ${y}) vs map.project (${want[i].x.toFixed(1)}, ${want[i].y.toFixed(1)})`));
  }
}

const viewBoxOf = (svg) => String(svg.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);

/** The station's arrow: a child of its node, or an overlay element carrying its data-station-id. */
const arrowFor = (svg, node, id) => findAll(svg, (n) => n !== svg && hasClass(n, "lm-arrow") &&
  (n.parent === node || n.getAttribute?.("data-station-id") === id))[0] ?? null;

function rotateOf(el) {
  const m = /rotate\(\s*(-?\d+(?:\.\d+)?(?:e-?\d+)?)/i.exec(String(el.getAttribute("transform") ?? ""));
  return m ? Number(m[1]) : null;
}

/** Off-map stations pinned at the clamped point with an arrow; on-map ones unpinned at the clamped point. */
function assertPinning(svg, map, stations, label) {
  const c = map.getContainer();
  const w = c.clientWidth;
  const h = c.clientHeight;
  for (const s of stations) {
    const n = nodeFor(svg, s.id);
    assert.ok(n, `${label}: node for ${s.id}`);
    const p = map.project(lonLat(s));
    const x = clamp(p.x, PIN_SIDE, w - PIN_SIDE);
    const y = clamp(p.y, PIN_TOP, h - PIN_BOTTOM);
    const got = pointOf(n);
    assert.ok(near(got.x, x) && near(got.y, y),
      `${label}: ${s.id} drawn at (${got.x}, ${got.y}), want (${x.toFixed(1)}, ${y.toFixed(1)}) for spot ` +
      `(${p.x.toFixed(1)}, ${p.y.toFixed(1)}) in ${w}x${h}`);
    const off = p.x < 0 || p.y < 0 || p.x > w || p.y > h;
    assert.equal(hasClass(n, "lm-pinned"), off, `${label}: ${s.id} lm-pinned should be ${off}`);
    if (!off) continue;
    const arrow = arrowFor(svg, n, s.id);
    assert.ok(arrow, `${label}: pinned ${s.id} has an .lm-arrow`);
    assert.equal(arrow.hidden, false, `${label}: ${s.id} arrow visible`);
    const deg = rotateOf(arrow);
    const want = (Math.atan2(p.y - y, p.x - x) * 180) / Math.PI;
    assert.ok(deg !== null, `${label}: ${s.id} arrow transform: ${arrow.getAttribute("transform")}`);
    assert.ok(angleDiff(deg, want) <= 1, `${label}: ${s.id} arrow rotate(${deg}), want ${want.toFixed(1)}`);
    assert.equal(arrow.getAttribute("style"), null, `${label}: ${s.id} arrow has no style attribute`);
    const inline = Object.entries(arrow.style ?? {}).filter(([, v]) => typeof v !== "function");
    assert.deepEqual(inline, [], `${label}: ${s.id} arrow has no inline style`);
  }
}

describe("real map: station overlay, pinning, a11y, attribution (MEM-077)", () => {
  test("first idle: the sketch svg becomes the overlay (class, visible, viewBox = container px)", async () => {
    const r = rig();
    const res = await r.loader.mount(r.svg, r.stations);
    assert.ok(res?.map, "map created");
    assert.ok(!hasClass(r.svg, "route-map-overlay"), "no overlay before the first idle");
    setSize(res.map.getContainer(), 375, 300);
    res.map.emit("load");
    res.map.emit("idle");
    await settle(5);
    assertOverlay(r.svg, res.map);
    assert.deepEqual(viewBoxOf(r.svg), [0, 0, 375, 300], `viewBox ${r.svg.getAttribute("viewBox")}`);
  });

  test("Q1: the overlay is clipped to the map (inside the container; .real-map overflow hidden)", async () => {
    const r = rig();
    const map = await mountIdle(r);
    await moveTo(map, { center: SOUTH_EAST });
    assert.ok(descendantOf(r.svg, map.getContainer()), "overlay inside the map container after a pan");
    const rule = /\.real-map\s*\{([^}]*)\}/.exec(readStatic("./style.css"));
    assert.ok(rule && /overflow\s*:\s*hidden/.test(rule[1]), ".real-map has overflow: hidden");
  });

  test("first idle: every station node and route-line point sits on map.project", async () => {
    const r = rig();
    const map = await mountIdle(r);
    assertOverlay(r.svg, map);
    assertOnProjection(r.svg, map, r.stations, "first idle");
    assertLineOnProjection(r.svg, map, r.stations, "first idle");
  });

  test("criterion 1: within 1 px of map.project after 1 pan (move) and 1 zoom", async () => {
    const r = rig();
    const map = await mountIdle(r);
    assertOverlay(r.svg, map);
    // A small pan, reported by move alone (no moveend yet): positions follow the camera live.
    await moveTo(map, { center: [CENTER[0] + 0.0003, CENTER[1] - 0.0002], end: false });
    assert.deepEqual(offIds(map, r.stations), [], "precondition: every station still on the map");
    assertOnProjection(r.svg, map, r.stations, "after pan (move)");
    assertLineOnProjection(r.svg, map, r.stations, "after pan (move)");
    await moveTo(map, { zoom: 15.4 });
    assertOnProjection(r.svg, map, r.stations, "after zoom");
    assertLineOnProjection(r.svg, map, r.stations, "after zoom");
  });

  test("resize re-projects: viewBox follows the container and stations stay on map.project", async () => {
    const r = rig();
    const map = await mountIdle(r);
    assertOverlay(r.svg, map);
    setSize(map.getContainer(), 768, 400);
    map.emit("resize");
    await settle(5);
    assert.deepEqual(viewBoxOf(r.svg), [0, 0, 768, 400], `viewBox ${r.svg.getAttribute("viewBox")}`);
    assertOnProjection(r.svg, map, r.stations, "after resize");
    assertLineOnProjection(r.svg, map, r.stations, "after resize");
  });

  for (const [label, center, wantOff] of [
    ["west (left edge; st-2 in the inset band, nudged not pinned)", WEST, ["st-1"]],
    ["north (top edge, 48 px inset)", NORTH, ["st-4"]],
    ["south-east (bottom and right edges)", SOUTH_EAST, ["st-1", "st-2", "st-4"]],
    ["far north (every station off the bottom)", FAR_NORTH, IDS],
  ]) {
    test(`Q2: pan ${label} -> off-map stations pinned to the edge inset with a rotated .lm-arrow`, async () => {
      const r = rig();
      const map = await mountIdle(r);
      assertOverlay(r.svg, map);
      await moveTo(map, { center });
      assert.deepEqual(offIds(map, r.stations), wantOff, "precondition: fake camera puts these off the map");
      assertPinning(r.svg, map, r.stations, label);
      // Back on the map: the pin goes away.
      await moveTo(map, { center: CENTER });
      assert.deepEqual(offIds(map, r.stations), [], "precondition: all back on the map");
      for (const id of IDS) assert.ok(!hasClass(nodeFor(r.svg, id), "lm-pinned"), `${id} unpinned after panning back`);
      assertOnProjection(r.svg, map, r.stations, "panned back");
    });
  }

  test("Q2 boundary: a station on the map but inside the top inset band is nudged inward, never pinned", async () => {
    const r = rig();
    const map = await mountIdle(r, [768, 400]);
    await moveTo(map, { center: NORTH });
    assert.deepEqual(offIds(map, r.stations), [], "precondition: st-4 on the map");
    const p4 = map.project(lonLat(r.stations[3]));
    assert.ok(p4.y >= 0 && p4.y < PIN_TOP, `precondition: st-4 spot y ${p4.y} inside the top band`);
    assertOverlay(r.svg, map);
    assertPinning(r.svg, map, r.stations, "768x400 north");
  });

  test("overlay positions are attributes only: no element carries a style attribute", async () => {
    const r = rig();
    const map = await mountIdle(r);
    await moveTo(map, { center: SOUTH_EAST });
    assertOverlay(r.svg, map);
    const styled = findAll(r.svg, (n) => n.getAttribute?.("style") != null);
    assert.deepEqual(styled.map((n) => n.tagName), [], "elements with a style attribute");
  });

  test("renderRouteMap light/finish still mark the station nodes on the overlay", async () => {
    const r = rig();
    const map = await mountIdle(r);
    assertOverlay(r.svg, map);
    const nodes = stationNodes(r.svg);
    assert.ok(r.ctl.nodes.length === 4 && r.ctl.nodes.every((n) => nodes.includes(n)),
      "the controller's nodes are the overlay's station nodes");
    r.ctl.light([true, false, true, false]);
    await moveTo(map, { center: WEST });
    assert.deepEqual(IDS.map((id) => hasClass(nodeFor(r.svg, id), "lit")), [true, false, true, false],
      "lit survives re-projection");
    r.ctl.finish([true, false, false, true]);
    await moveTo(map, { center: CENTER });
    assert.deepEqual(IDS.map((id) => hasClass(nodeFor(r.svg, id), "lit")), [true, false, false, true], "finish lit");
    assert.deepEqual(IDS.map((id) => hasClass(nodeFor(r.svg, id), "missed")), [false, true, true, false],
      "finish missed");
  });

  for (const [w, h] of VIEWPORTS) {
    test(`criterion 2: ${w}x${h} -> marker count == station count after every moveend, never culled`, async () => {
      const r = rig();
      const map = await mountIdle(r, [w, h]);
      assertOverlay(r.svg, map);
      for (const center of [CENTER, WEST, NORTH, SOUTH_EAST, FAR_NORTH, CENTER]) {
        await moveTo(map, { center });
        const nodes = stationNodes(r.svg);
        const at = `${w}x${h} at ${center.join(",")}`;
        assert.equal(nodes.length, r.stations.length, `${at}: station markers`);
        assert.deepEqual(nodes.map((n) => n.getAttribute("data-station-id")).sort(), IDS, `${at}: one per station`);
        assert.ok(nodes.every((n) => !n.hidden && n.getAttribute("hidden") === null), `${at}: none hidden`);
      }
      await moveTo(map, { center: FAR_NORTH });
      assert.deepEqual(offIds(map, r.stations), IDS, "precondition: every station off the map");
      assert.ok(stationNodes(r.svg).every((n) => hasClass(n, "lm-pinned")), `${w}x${h}: all off-map stations pinned`);
    });
  }

  test("criterion 3: the map canvas container is aria-hidden=\"true\"", async () => {
    const r = rig();
    const res = await r.loader.mount(r.svg, r.stations);
    assert.ok(res?.map, "map created");
    assert.equal(res.map.getCanvasContainer().getAttribute("aria-hidden"), "true", "set by the time mount resolves");
    res.map.emit("load");
    res.map.emit("idle");
    await settle(5);
    assert.equal(res.map.getCanvasContainer().getAttribute("aria-hidden"), "true", "still set after idle");
  });

  test("criterion 4: attribution stays visible, uncollapsed, at 375 px", async () => {
    const r = rig();
    const map = await mountIdle(r, [375, 300]);
    const opt = map.opts.attributionControl;
    const added = map.controls.find((c) => c?.options && "compact" in c.options);
    assert.ok((opt && typeof opt === "object" && opt.compact === false) || added?.options.compact === false,
      `attributionControl ${JSON.stringify(opt)}; added ${JSON.stringify(added?.options ?? null)}`);
    for (const theme of ["light", "dark"]) {
      const style = JSON.parse(readStatic(`./map/style-${theme}.json`));
      const text = Object.values(style.sources).map((s) => s.attribution ?? "").join(" ");
      assert.match(text, /OpenStreetMap contributors/, `${theme} attribution`);
      assert.match(text, /Protomaps/, `${theme} attribution`);
    }
    const hiding = [...readStatic("./style.css").matchAll(/([^{}]*maplibregl-ctrl[^{}]*)\{([^}]*)\}/g)]
      .filter(([, , body]) => /display\s*:\s*none|visibility\s*:\s*hidden/.test(body)).map(([, sel]) => sel.trim());
    assert.deepEqual(hiding, [], "no app CSS hides a MapLibre control");
  });

  test("criterion 5: one out-of-bbox station -> sketch, no map, 0 extract fetches", async () => {
    const r = rig({ stations: stationsAt([...KENDALL, LONDON]) });
    const res = await r.loader.mount(r.svg, r.stations);
    assert.equal(res, null);
    assert.equal(r.fetch.calls.length, 0, "no fetch at all");
    assert.equal(r.libs.maps.length, 0, "no map instance");
    assert.ok(!hasClass(r.svg, "route-map-overlay") && !r.svg.hidden, "sketch untouched");
  });

  for (const theme of ["light", "dark"]) {
    test(`criterion 6: ${theme} style -> 0 route layers or sources reach the map`, async () => {
      const r = rig({ theme });
      const map = await mountIdle(r);
      await moveTo(map, { center: WEST });
      assert.deepEqual(map.layersAdded, [], "map.addLayer never called");
      assert.deepEqual(map.sourcesAdded, [], "map.addSource never called");
      const style = JSON.parse(readStatic(`./map/style-${theme}.json`));
      assert.deepEqual(Object.keys(style.sources), ["protomaps"], "basemap source only");
      const routeish = style.layers.filter((l) => /route/i.test(l.id) || (l.source && l.source !== "protomaps"));
      assert.deepEqual(routeish.map((l) => l.id), [], "no route layers in the style");
    });
  }
});

// Covers: MEM-076, MEM-077
// Requirement: reopening a route mounts the real map again on the same sketch svg without stacking maps.
// A repeat mount first releases the previous one: the old map is removed (map.remove()), its .real-map box
// leaves the DOM, and the svg goes back to its sketch place (same index under the route view) with its
// sketch viewBox, no route-map-overlay class, no .lm-arrow and no lm-pinned left over, all before the new
// map's first idle, so the route view shows the sketch, never a blank or doubled map. After the new idle
// the svg is the overlay of the new map only. A newer mount started while an older one is still loading
// wins: the older resolves null and exactly one map and one .real-map box exist.
describe("real map: repeat mount reuses one map box (MEM-076, MEM-077)", () => {
  const boxes = (view) => findAll(view, (n) => hasClass(n, "real-map"));
  const arrows = (svg) => findAll(svg, (n) => hasClass(n, "lm-arrow"));
  const pinned = (svg) => findAll(svg, (n) => hasClass(n, "lm-pinned"));

  test("mount twice: old map removed, svg back in its sketch place before the new idle, one box", async () => {
    const r = rig();
    const sketchViewBox = r.svg.getAttribute("viewBox");
    const sketchIndex = r.view.children.indexOf(r.svg);
    const first = await mountIdle(r);
    await moveTo(first, { center: WEST });
    assert.ok(descendantOf(r.svg, first.getContainer()), "precondition: svg is the first map's overlay");
    assert.ok(pinned(r.svg).length > 0, "precondition: a station is pinned on the first map");

    const second = await r.loader.mount(r.svg, r.stations);
    assert.ok(second?.map, "second mount made a map");
    assert.ok(second.map !== first, "second mount made a new map");
    assert.equal(first.removed, true, "first map's remove() was called");
    assert.equal(r.libs.maps.length, 2, "one new map instance per mount");
    assert.equal(boxes(r.view).length, 1, "exactly one .real-map box under the route view");
    assert.ok(boxes(r.view)[0] === second.map.getContainer(), "the remaining box is the second map's");
    assert.equal(descendantOf(first.getContainer(), r.view), false, "first box left the route view");

    // Before the second map idles: the sketch is back where it was, as the sketch.
    assert.ok(r.svg.parent === r.view, "svg back directly under the route view");
    assert.equal(r.view.children.indexOf(r.svg), sketchIndex, "svg back at its original index");
    assert.equal(r.svg.getAttribute("viewBox"), sketchViewBox, "sketch viewBox restored");
    assert.equal(hasClass(r.svg, "route-map-overlay"), false, "overlay class removed");
    assert.equal(arrows(r.svg).length, 0, "no .lm-arrow left on the sketch");
    assert.equal(pinned(r.svg).length, 0, "no lm-pinned left on the sketch");
    assert.equal(r.svg.hidden, false, "sketch visible while the second map loads");

    setSize(second.map.getContainer(), 375, 300);
    second.map.emit("load");
    second.map.emit("idle");
    await settle(5);
    assert.ok(descendantOf(r.svg, second.map.getContainer()), "svg is the second map's overlay");
    assert.equal(boxes(r.view).length, 1, "still exactly one .real-map box");
    assert.equal(stationNodes(r.svg).length, r.stations.length, "marker count == station count");
    assert.equal(arrows(r.svg).length, r.stations.length, "one .lm-arrow per station, none duplicated");
  });

  test("a newer mount started while the older is still loading wins: older null, one map, one box", async () => {
    const r = rig();
    const older = r.loader.mount(r.svg, r.stations);
    const newer = r.loader.mount(r.svg, r.stations);
    const [a, b] = await Promise.all([older, newer]);
    assert.ok(a === null, "older mount resolves null");
    assert.ok(b?.map, "newer mount made the map");
    assert.equal(r.libs.maps.length, 1, "exactly one map instance");
    assert.equal(boxes(r.view).length, 1, "exactly one .real-map box");
    assert.ok(boxes(r.view)[0] === b.map.getContainer(), "the box is the newer map's");
    b.map.emit("load");
    b.map.emit("idle");
    await settle(5);
    assert.ok(descendantOf(r.svg, b.map.getContainer()), "svg is the newer map's overlay");
  });
});
