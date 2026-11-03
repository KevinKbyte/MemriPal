// Covers: MEM-084
// Requirement: route search runs offline (ADR 0046, 0053; plan S2). A typed start and end ("Kendall/MIT T" ->
// "Meta office") resolve through a local geocode (normalized fuzzy match over the POI table plus a hand-kept
// alias table; "meta office" = 42.36554,-71.0809, address "100 Binney St", never OSM's own "Meta" node at
// 1 Broadway), and an in-process A* over the committed walking graph returns the shortest walk as
// { polyline, length_m, fallback }. Endpoints snap to the LARGEST connected component; when no path exists the
// result is an honest straight line between the endpoints with fallback: true. A miss never dead-ends: it
// returns { miss: true, suggestions } with at least one suggestion. Golden on the committed Kendall data: the
// Kendall T -> Meta office walk stays within 40 m of the DEMO_ROUTE polyline and is 600-750 m long, every demo
// phrase resolves, and graph + POI JSON together stay under 1 MiB (1,048,576 bytes).
// Contract (RED; GREEN adds static/walk_route.js and the committed static/data/ files):
//   export function route(graph, from, to) -> { polyline: [[lat, lng], ...], length_m: number, fallback: boolean }
//     graph = { nodes: [[lat, lng], ...], edges: [[i, j, length_m], ...] } (undirected); from/to = { lat, lng }
//   export function geocode(phrase, pois) -> { name, lat, lng, address } | { miss: true, suggestions: [...] }
//     pois = [{ osm_id, name, lat, lng, address: string | null, street: string | null }]
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";

import { route, geocode } from "./walk_route.js";
import { DEMO_ROUTE } from "./demo_route.js";

const GRAPH_URL = new URL("./data/kendall_walk_graph.json", import.meta.url);
const POIS_URL = new URL("./data/kendall_pois.json", import.meta.url);
const MAX_DATA_BYTES = 1024 * 1024;

const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;

/** Great-circle distance in metres between [lat, lng] pairs. */
function dist(a, b) {
  const dLat = rad(b[0] - a[0]);
  const dLng = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Distance in metres from point p to segment a-b, local equirectangular projection (fine at <1 km). */
function distToSegment(p, a, b) {
  const k = Math.cos(rad(p[0]));
  const xy = (q) => [rad(q[1]) * k * R, rad(q[0]) * R];
  const [px, py] = xy(p);
  const [ax, ay] = xy(a);
  const [bx, by] = xy(b);
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function distToPolyline(p, line) {
  let best = Infinity;
  for (let i = 0; i + 1 < line.length; i += 1) best = Math.min(best, distToSegment(p, line[i], line[i + 1]));
  return best;
}

/** Build a graph from nodes and index pairs; edge lengths are the true haversine lengths. */
function graphOf(nodes, pairs) {
  return { nodes, edges: pairs.map(([i, j]) => [i, j, dist(nodes[i], nodes[j])]) };
}

const at = (node) => ({ lat: node[0], lng: node[1] });
const sameVertex = (v, n) => dist(v, n) < 0.5;

function loadJson(url) {
  return JSON.parse(readFileSync(url, "utf8"));
}

// A (west) and D (east) joined two ways: a short dip south through C, a long detour north through B.
const A = [42.36, -71.09];
const B = [42.37, -71.085];
const C = [42.3595, -71.085];
const D = [42.36, -71.08];
const DIAMOND = graphOf([A, B, C, D], [[0, 1], [1, 3], [0, 2], [2, 3]]);
const VIA_C = dist(A, C) + dist(C, D);

const INLINE_POIS = [
  { osm_id: "node/1", name: "Toomey Park", lat: 42.36601, lng: -71.08069, address: null, street: "Binney Street" },
  { osm_id: "node/2", name: "Kendall Building", lat: 42.36573, lng: -71.08237, address: "238 Main St", street: "Main Street" },
  { osm_id: "node/3", name: "Meta", lat: 42.36263, lng: -71.08366, address: "1 Broadway", street: "Broadway" },
];

describe("route: A* over an inline graph", () => {
  test("takes the shortest path, not the fewest-hop or first-listed one", () => {
    const r = route(DIAMOND, at(A), at(D));
    assert.equal(r.fallback, false);
    assert.ok(Math.abs(r.length_m - VIA_C) < 1, `length_m ${r.length_m} != shortest ${VIA_C}`);
    assert.ok(r.polyline.some((v) => sameVertex(v, C)), "polyline passes through C");
    assert.ok(!r.polyline.some((v) => sameVertex(v, B)), "polyline avoids the long detour through B");
  });

  test("polyline is [[lat, lng], ...] running from the start to the end", () => {
    const r = route(DIAMOND, at(A), at(D));
    assert.ok(Array.isArray(r.polyline) && r.polyline.length >= 3);
    for (const v of r.polyline) {
      assert.ok(Array.isArray(v) && v.length === 2 && v.every(Number.isFinite), `vertex ${JSON.stringify(v)}`);
    }
    assert.ok(sameVertex(r.polyline[0], A), "starts at A");
    assert.ok(sameVertex(r.polyline[r.polyline.length - 1], D), "ends at D");
  });

  test("edges are undirected: the reverse walk has the same length", () => {
    const r = route(DIAMOND, at(D), at(A));
    assert.equal(r.fallback, false);
    assert.ok(Math.abs(r.length_m - VIA_C) < 1, `reverse length_m ${r.length_m} != ${VIA_C}`);
    assert.ok(sameVertex(r.polyline[0], D) && sameVertex(r.polyline[r.polyline.length - 1], A));
  });

  test("start equal to end is a zero-length routed result", () => {
    const r = route(DIAMOND, at(C), at(C));
    assert.equal(r.fallback, false);
    assert.ok(r.length_m < 1, `length_m ${r.length_m}`);
    assert.ok(r.polyline.length >= 1);
  });

  test("endpoints snap to the largest component, never a closer island", () => {
    // Island: two nodes right beside the start, unconnected to the 4-node main component.
    const I1 = [42.36001, -71.09001];
    const I2 = [42.36002, -71.08002];
    const g = graphOf([A, B, C, D, I1, I2], [[0, 1], [1, 3], [0, 2], [2, 3], [4, 5]]);
    const from = { lat: 42.36001, lng: -71.09002 };
    const to = { lat: 42.36002, lng: -71.08003 };
    const r = route(g, from, to);
    assert.equal(r.fallback, false, "routable inside the largest component");
    assert.ok(!r.polyline.some((v) => sameVertex(v, I1) || sameVertex(v, I2)), "no island vertex in the walk");
    assert.ok(r.polyline.some((v) => sameVertex(v, C)), "walks the main component's shortest path via C");
  });

  test("no path: a straight line between the endpoints, flagged fallback", () => {
    const from = at(A);
    const to = at(D);
    const r = route({ nodes: [], edges: [] }, from, to);
    assert.equal(r.fallback, true);
    assert.equal(r.polyline.length, 2);
    assert.ok(sameVertex(r.polyline[0], A) && sameVertex(r.polyline[1], D), "polyline is [from, to]");
    const straight = dist(A, D);
    assert.ok(Math.abs(r.length_m - straight) < straight * 0.01, `length_m ${r.length_m} != ${straight}`);
  });
});

describe("geocode: aliases and normalized fuzzy match over inline POIs", () => {
  test("'meta office' is the 100 Binney St alias, not OSM's Meta node at 1 Broadway", () => {
    for (const phrase of ["meta office", "Meta office", "  META   Office  "]) {
      const g = geocode(phrase, INLINE_POIS);
      assert.ok(!g.miss, `${phrase} resolves`);
      assert.ok(Math.abs(g.lat - 42.36554) < 1e-5 && Math.abs(g.lng - -71.0809) < 1e-5, `${phrase} coords`);
      assert.equal(g.address, "100 Binney St");
      assert.equal(typeof g.name, "string");
    }
  });

  test("POI name match ignores case, punctuation and spacing, and returns the POI's fields", () => {
    for (const phrase of ["Toomey Park", "toomey park", "TOOMEY  park!"]) {
      const g = geocode(phrase, INLINE_POIS);
      assert.ok(!g.miss, `${phrase} resolves`);
      assert.equal(g.name, "Toomey Park");
      assert.equal(g.lat, 42.36601);
      assert.equal(g.lng, -71.08069);
      assert.equal(g.address, null);
    }
  });

  test("a partial name resolves to the one POI containing it, with its own address", () => {
    const g = geocode("kendall building", INLINE_POIS);
    assert.ok(!g.miss);
    assert.equal(g.name, "Kendall Building");
    assert.equal(g.address, "238 Main St");
    const p = geocode("toomey", INLINE_POIS);
    assert.ok(!p.miss);
    assert.equal(p.name, "Toomey Park");
  });

  test("a miss returns { miss: true } with at least one named suggestion", () => {
    const g = geocode("zzqx nowhere plaza", INLINE_POIS);
    assert.equal(g.miss, true);
    assert.ok(Array.isArray(g.suggestions) && g.suggestions.length >= 1, "suggestions >= 1");
    for (const s of g.suggestions) assert.equal(typeof s.name, "string");
  });

  test("a blank phrase is a miss, never a silent hit", () => {
    assert.equal(geocode("   ", INLINE_POIS).miss, true);
  });
});

const DEMO_PHRASES = ["Kendall/MIT T", "kendall/mit t", "Kendall T", "Meta office", "meta office", "100 Binney", "100 Binney St"];

describe("golden: committed Kendall walk graph + POI table", () => {
  test("graph + POI JSON together stay under 1 MiB", () => {
    const bytes = statSync(GRAPH_URL).size + statSync(POIS_URL).size;
    assert.ok(bytes < MAX_DATA_BYTES, `graph + POI JSON is ${bytes} bytes`);
  });

  test("every demo phrase resolves", () => {
    const pois = loadJson(POIS_URL);
    for (const phrase of DEMO_PHRASES) {
      const g = geocode(phrase, pois);
      assert.ok(!g.miss, `${phrase} resolves`);
      assert.ok(Number.isFinite(g.lat) && Number.isFinite(g.lng), `${phrase} has coords`);
    }
  });

  test("Kendall T resolves to the station, beside DEMO_ROUTE stop 1", () => {
    const pois = loadJson(POIS_URL);
    const s1 = DEMO_ROUTE.stations[0].coords;
    for (const phrase of ["Kendall/MIT T", "Kendall T"]) {
      const g = geocode(phrase, pois);
      assert.ok(!g.miss, `${phrase} resolves`);
      const d = dist([g.lat, g.lng], [s1.lat, s1.lon]);
      assert.ok(d < 150, `${phrase} is ${d.toFixed(0)} m from DEMO_ROUTE stop 1`);
    }
  });

  test("'100 Binney' resolves with address '100 Binney St' at the Meta office", () => {
    const pois = loadJson(POIS_URL);
    const g = geocode("100 Binney", pois);
    assert.ok(!g.miss);
    assert.equal(g.address, "100 Binney St");
    const d = dist([g.lat, g.lng], [42.36554, -71.0809]);
    assert.ok(d < 50, `100 Binney is ${d.toFixed(0)} m from 42.36554,-71.0809`);
  });

  test("a miss on the real POI table still offers suggestions", () => {
    const g = geocode("zzqx nowhere plaza", loadJson(POIS_URL));
    assert.equal(g.miss, true);
    assert.ok(Array.isArray(g.suggestions) && g.suggestions.length >= 1);
  });

  test("Kendall T -> Meta office is routed, 600-750 m, within 40 m of the DEMO_ROUTE polyline", () => {
    const graph = loadJson(GRAPH_URL);
    const pois = loadJson(POIS_URL);
    const from = geocode("Kendall/MIT T", pois);
    const to = geocode("Meta office", pois);
    assert.ok(!from.miss && !to.miss);
    const r = route(graph, from, to);
    assert.equal(r.fallback, false, "a real walk, not the straight-line fallback");
    assert.ok(r.length_m >= 600 && r.length_m <= 750, `length_m ${r.length_m}`);
    const demoLine = DEMO_ROUTE.stations.map((s) => [s.coords.lat, s.coords.lon]);
    let worst = 0;
    for (const v of r.polyline) worst = Math.max(worst, distToPolyline(v, demoLine));
    assert.ok(worst <= 40, `walk strays ${worst.toFixed(1)} m from the DEMO_ROUTE polyline`);
  });
});
