// Covers: MEM-051
// Requirement: the route map (plan B6, Part A S5/S8) projects a route's stations into a 320x200 viewBox
// in route order (station coords when every station has them, else an evenly spaced index layout), draws
// one polyline plus one node per station into #route-map / #recall-map, lights only counted stations
// (.lit) and marks the rest .missed on Done; coordinates are never rendered as text and JS sets no inline
// style. Route practice matches station names only (the turn cue is shown, never matched), and "Learned
// n/N" counts the latest route rehearsal's hits whose station ids are still on the route, N = the current
// station count, so n never exceeds N.
// Contract (RED; GREEN implements static/route_map.js):
//   projectStations(stations) -> [{ id, x, y }] in route order, every point inside [0,320] x [0,200].
//   renderRouteMap(svg, stations, doc) -> { nodes, light(counted), finish(counted) }: replaces svg's
//     children with one "polyline" (attribute points) and one node per station (attribute
//     data-station-id, numeric cx / cy); light(counted: boolean[]) leaves class "lit" exactly on counted
//     nodes; finish(counted) adds "lit" to counted nodes and "missed" to every other node.
//     SVG children are made with doc.createElementNS("http://www.w3.org/2000/svg", tag).
//   routePracticePoints(route) -> [{ id, label, source_quote }] in route order; label and source_quote
//     are the station name only.
//   learnedCount(route, records) -> { n, N }: latest record (records are oldest first) with
//     mode "route"; n = ids in its hits map set true AND still on the route; N = route.stations.length.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { fakePage, findAll, visibleText } from "./fake_dom_test.mjs";
import { matchTranscript } from "./recall_match.js";

const rmap = await import("./route_map.js").catch((err) => ({ __missing: String(err) }));

function api(name) {
  assert.ok(name in rmap, `static/route_map.js must export ${name} (${rmap.__missing ?? "not exported"})`);
  return rmap[name];
}

const W = 320;
const H = 200;
const NAMES = ["red bench", "red door", "old oak", "stone arch", "blue gate", "brick wall"];
const COORDS = [
  [51.5074, -0.1278], [51.5081, -0.1269], [51.5093, -0.1255], [51.5101, -0.1249], [51.5112, -0.1231],
  [51.5120, -0.1222],
];
const TURNS = ["Left", "Straight", "Right", "Left", "Straight", "Arrive"];

function station(i, { coords = true } = {}) {
  const s = { id: `st-${i + 1}`, n: i + 1, name: NAMES[i], photo_ref: `ph-${i + 1}`, status: "named",
    taps: { turn: TURNS[i] } };
  if (coords) s.coords = { lat: COORDS[i][0], lon: COORDS[i][1] };
  return s;
}
const stations = (k = 6, opts) => Array.from({ length: k }, (_, i) => station(i, opts));
const route = (k = 6) => ({ id: "r1", name: "Commute", kind: "daily", status: "saved",
  created_at: "2026-10-31T08:00:00.000Z", stations: stations(k), lists: [] });

const nodesOf = (svg) => findAll(svg, (n) => n !== svg && n.dataset?.stationId !== undefined);
const has = (n, c) => n.classList.contains(c);

describe("route map: projection into the 320x200 viewBox (criterion 1)", () => {
  test("6 coords -> 6 points inside the viewBox, in route order", () => {
    const pts = api("projectStations")(stations());
    assert.equal(pts.length, 6);
    assert.deepEqual(pts.map((p) => p.id), stations().map((s) => s.id));
    for (const p of pts) {
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), `finite ${JSON.stringify(p)}`);
      assert.ok(p.x >= 0 && p.x <= W && p.y >= 0 && p.y <= H, `inside viewBox ${JSON.stringify(p)}`);
    }
  });

  test("coords drive the layout: distinct coords give distinct points", () => {
    const pts = api("projectStations")(stations());
    assert.equal(new Set(pts.map((p) => `${p.x},${p.y}`)).size, 6);
  });

  test("no coords -> evenly spaced index layout inside the viewBox", () => {
    const pts = api("projectStations")(stations(6, { coords: false }));
    assert.equal(pts.length, 6);
    const gaps = pts.slice(1).map((p, i) => Math.hypot(p.x - pts[i].x, p.y - pts[i].y));
    for (const g of gaps) {
      assert.ok(g > 0, "consecutive points differ");
      assert.ok(Math.abs(g - gaps[0]) < 1e-6, `even spacing: ${gaps.join(", ")}`);
    }
    for (const p of pts) assert.ok(p.x >= 0 && p.x <= W && p.y >= 0 && p.y <= H);
  });

  test("a single station and an empty route project without throwing", () => {
    assert.equal(api("projectStations")(stations(1)).length, 1);
    assert.deepEqual(api("projectStations")([]), []);
  });
});

describe("route map: nodes, lighting and Done (criteria 3, 8, 9)", () => {
  const render = (k = 6) => {
    const page = fakePage(["route-map"]);
    const svg = page.els["route-map"];
    const handle = api("renderRouteMap")(svg, stations(k), page.doc);
    return { page, svg, handle };
  };

  test("one polyline plus one node per station, nodes in route order inside the viewBox", () => {
    const { svg } = render();
    assert.equal(findAll(svg, (n) => n.tagName === "POLYLINE").length, 1, "one polyline");
    const nodes = nodesOf(svg);
    assert.deepEqual(nodes.map((n) => n.dataset.stationId), stations().map((s) => s.id));
    for (const n of nodes) {
      const cx = Number(n.getAttribute("cx"));
      const cy = Number(n.getAttribute("cy"));
      assert.ok(cx >= 0 && cx <= W && cy >= 0 && cy <= H, `node ${n.dataset.stationId} at ${cx},${cy}`);
    }
  });

  test("light(counted) leaves .lit exactly on counted nodes", () => {
    const { svg, handle } = render();
    handle.light([true, true, false, false, false, false]);
    handle.light([true, true, true, false, false, false]);
    assert.deepEqual(nodesOf(svg).map((n) => has(n, "lit")), [true, true, true, false, false, false]);
    handle.light([true, false, true, false, false, false]);
    assert.deepEqual(nodesOf(svg).map((n) => has(n, "lit")), [true, false, true, false, false, false]);
  });

  test("Done with 5/6 counted in order -> exactly 1 .missed node", () => {
    const { svg, handle } = render();
    const counted = [true, true, true, false, true, true];
    handle.finish(counted);
    const nodes = nodesOf(svg);
    assert.equal(nodes.filter((n) => has(n, "missed")).length, 1);
    assert.equal(nodes[3].dataset.stationId, "st-4");
    assert.ok(has(nodes[3], "missed"));
    assert.equal(nodes.filter((n) => has(n, "lit")).length, 5);
  });

  test("re-rendering replaces the previous nodes (no duplicates)", () => {
    const { page, svg } = render();
    api("renderRouteMap")(svg, stations(4), page.doc);
    assert.equal(nodesOf(svg).length, 4);
    assert.equal(findAll(svg, (n) => n.tagName === "POLYLINE").length, 1);
  });

  test("no inline style set by JS (DOM scan) and no innerHTML writes", () => {
    const { page, handle } = render();
    handle.light([true, false, false, false, false, false]);
    handle.finish([true, false, false, false, false, false]);
    for (const e of page.madeByCode()) {
      assert.equal(e.getAttribute("style"), null, `${e.tagName} has a style attribute`);
      const keys = Object.keys(e.style).filter((k) => typeof e.style[k] !== "function");
      assert.deepEqual(keys, [], `${e.tagName} inline style ${keys.join(", ")}`);
    }
    assert.deepEqual(page.htmlWrites, []);
  });

  test("no coordinate digits in rendered text or text attributes", () => {
    const { svg } = render();
    const texts = [visibleText(svg), svg.textContent];
    for (const n of findAll(svg, () => true)) {
      for (const [k, v] of Object.entries(n.attrs)) if (!["cx", "cy", "points", "r", "viewbox"].includes(k)) texts.push(v);
    }
    const blob = texts.join(" ");
    for (const [lat, lon] of COORDS) {
      for (const v of [lat, lon, Math.abs(lon)]) {
        for (const dp of [2, 3, 4]) assert.ok(!blob.includes(v.toFixed(dp)), `coordinate ${v.toFixed(dp)} rendered`);
      }
    }
  });
});

describe("route practice: station names only, turn cue never matched (criteria 5, 6)", () => {
  test("points are the station names in route order", () => {
    const pts = api("routePracticePoints")(route());
    assert.deepEqual(pts.map((p) => p.id), stations().map((s) => s.id));
    assert.deepEqual(pts.map((p) => p.label), NAMES);
    assert.deepEqual(pts.map((p) => p.source_quote), NAMES);
  });

  test('"red bench" / "red door", transcript "red bench left" -> exactly 1 hit', () => {
    const r = { ...route(2), stations: [
      { ...station(0), taps: { turn: "Straight" } },
      { ...station(1), taps: { turn: "Left" } },
    ] };
    const results = matchTranscript("red bench left", api("routePracticePoints")(r));
    assert.deepEqual(results.map((x) => x.got), [true, false]);
  });

  test("a 2-of-3-word utterance of a 3-word name matches it (coverage 0.67 >= 0.6)", () => {
    const r = { ...route(1), stations: [{ ...station(0), name: "tall clock tower" }] };
    const results = matchTranscript("um the clock tower", api("routePracticePoints")(r));
    assert.equal(results[0].got, true);
  });
});

describe('route practice: "Learned n/N" (criterion 7)', () => {
  const rec = (ts, hits) => ({ id: `reh-${ts}`, palace_id: "r1", timestamp: ts, transcript: "", points: [],
    mode: "route", hits });
  const FIVE = { "st-1": true, "st-2": true, "st-3": true, "st-4": false, "st-5": true, "st-6": true };

  test("latest route rehearsal 5/6 -> { n: 5, N: 6 }", () => {
    const older = rec("2026-10-30T08:00:00.000Z", { "st-1": true });
    const latest = rec("2026-10-31T08:00:00.000Z", FIVE);
    assert.deepEqual(api("learnedCount")(route(), [older, latest]), { n: 5, N: 6 });
  });

  test("an Up/Down swap of stations 2 and 3 keeps the same stations learned", () => {
    const r = route();
    [r.stations[1], r.stations[2]] = [r.stations[2], r.stations[1]];
    assert.deepEqual(api("learnedCount")(r, [rec("2026-10-31T08:00:00.000Z", FIVE)]), { n: 5, N: 6 });
  });

  test("dropping a learned station -> 4/5; dropping the missed one -> 5/5; never n > N", () => {
    const records = [rec("2026-10-31T08:00:00.000Z", FIVE)];
    const dropLearned = route();
    dropLearned.stations.splice(0, 1);
    assert.deepEqual(api("learnedCount")(dropLearned, records), { n: 4, N: 5 });
    const dropMissed = route();
    dropMissed.stations.splice(3, 1);
    assert.deepEqual(api("learnedCount")(dropMissed, records), { n: 5, N: 5 });
  });

  test("a 4-station route shows /4; no route rehearsal -> 0", () => {
    assert.deepEqual(api("learnedCount")(route(4), []), { n: 0, N: 4 });
    const listRun = { ...rec("2026-10-31T08:00:00.000Z", FIVE), mode: undefined };
    delete listRun.mode;
    assert.deepEqual(api("learnedCount")(route(4), [listRun]), { n: 0, N: 4 });
  });
});
