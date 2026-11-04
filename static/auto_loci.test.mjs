// Covers: MEM-085
// Requirement: a routed walk gets landmarks without a walk (ADR 0047, 0053). candidates(polyline, pois,
// existingStations = []) is pure and deterministic; it lists the POIs worth standing at along the route:
//   - eligible = within 50 m of the route polyline (ADR 0047's outer radius; POIs nearer than 30 m qualify
//     too, 30 vs 50 m tuning is undecided), with an address or a street to label it, not within 15 m of an
//     existing station (seeded stations have no osm_id, so proximity is the dedupe), first of its name and
//     of its osm_id (dupes dropped);
//   - even spacing rule: consecutive candidates are at least 40 m apart measured along the route (each POI's
//     position = route distance to its nearest point on the polyline); of eligible POIs closer than that,
//     at most one is kept;
//   - ordered by that along-route position, start to end;
//   - each carries the POI's 5-dp lat/lng and address, and label = address, else "near <street>" (never a
//     made-up number).
// The Kendall walk (Kendall/MIT -> Meta office, 100 Binney St) yields >= 6 candidates.
// Contract (RED; GREEN adds static/auto_loci.js):
//   export function candidates(polyline, pois, existingStations = [])
//     polyline: [[lat, lng], ...] (static/walk_route.js route().polyline shape, ADR 0046)
//     pois: [{ osm_id, name, lat, lng, address: string|null, street: string|null }] (kendall_pois.json shape)
//     existingStations: route_store Station[] ({ coords?: { lat, lon } }; coords may be absent after import)
//     -> [{ key: "candidate:osm:<osm_id>", osm_id, name, lat, lng, address, label }]
// Fixture static/fixtures/kendall_pois_fixture.json stands in for S2's static/data/kendall_pois.json; the
// polyline and stations below are the DEMO_ROUTE (static/demo_route.js) seed coords, frozen here so the
// slice's 5-dp re-seed cannot shift the fixture geometry.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { candidates } from "./auto_loci.js";

const POIS = Object.freeze(
  JSON.parse(readFileSync(new URL("./fixtures/kendall_pois_fixture.json", import.meta.url), "utf8")),
);

const STATION_COORDS = [
  [42.36238, -71.0856],
  [42.36265, -71.08441],
  [42.36385, -71.08347],
  [42.36509, -71.08277],
  [42.36573, -71.08237],
  [42.36554, -71.0809],
];
const POLYLINE = STATION_COORDS.map(([lat, lng]) => [lat, lng]);
const STATIONS = STATION_COORDS.map(([lat, lon], i) => ({ id: `st-${i + 1}`, n: i + 1, name: `S${i + 1}`, coords: { lat, lon } }));

const R = 6371008.8;
const RAD = Math.PI / 180;
/** Local equirectangular metres of b relative to a (sub-metre accurate at walk scale). */
function xy(a, b) {
  return [(b[1] - a[1]) * RAD * R * Math.cos(a[0] * RAD), (b[0] - a[0]) * RAD * R];
}
function metres(a, b) {
  const [x, y] = xy(a, b);
  return Math.hypot(x, y);
}
/** Distance from p to the polyline and the along-route position of the nearest point. */
function project(p, line) {
  let best = { dist: Infinity, along: 0 };
  let walked = 0;
  for (let i = 0; i + 1 < line.length; i++) {
    const [bx, by] = xy(line[i], line[i + 1]);
    const [px, py] = xy(line[i], p);
    const len = Math.hypot(bx, by);
    const t = len === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / (len * len)));
    const dist = Math.hypot(px - t * bx, py - t * by);
    if (dist < best.dist) best = { dist, along: walked + t * len };
    walked += len;
  }
  return best;
}
const poiById = (id) => POIS.find((p) => p.osm_id === id);
const ids = (list) => list.map((c) => c.osm_id);

describe("auto_loci candidates: Kendall walk", () => {
  const out = candidates(POLYLINE, POIS, STATIONS);

  test("yields >= 6 candidates", () => {
    assert.ok(Array.isArray(out), "candidates() returns an array");
    assert.ok(out.length >= 6, `expected >= 6 candidates, got ${out.length}: ${ids(out).join(", ")}`);
  });

  test("every candidate is within 50 m of the route; POIs farther out never appear", () => {
    for (const c of out) {
      const { dist } = project([c.lat, c.lng], POLYLINE);
      assert.ok(dist <= 50, `${c.osm_id} ${c.name} is ${dist.toFixed(1)} m from the route`);
    }
    for (const far of ["node/1012", "node/1013", "way/2001", "way/2002"]) {
      assert.ok(project([poiById(far).lat, poiById(far).lng], POLYLINE).dist > 50, `fixture: ${far} is outside 50 m`);
      assert.ok(!ids(out).includes(far), `${far} (> 50 m from the route) must not be a candidate`);
    }
  });

  test("isolated eligible POIs both nearer than 30 m and in the 30-50 m ring are kept", () => {
    // node/1001 ~10 m, node/1011 ~25 m, node/1009 ~34 m, node/1005 ~40 m, node/1008 ~46 m; none has an
    // eligible neighbour within 40 m along the route.
    for (const id of ["node/1001", "node/1005", "node/1008", "node/1009", "node/1011"]) {
      assert.ok(ids(out).includes(id), `${id} ${poiById(id).name} should be a candidate; got ${ids(out).join(", ")}`);
    }
  });

  test("candidates come in route order, start to end", () => {
    const along = out.map((c) => project([c.lat, c.lng], POLYLINE).along);
    for (let i = 1; i < along.length; i++) {
      assert.ok(along[i] > along[i - 1], `candidate ${i} (${out[i].name}) at ${along[i].toFixed(0)} m comes before ${out[i - 1].name} at ${along[i - 1].toFixed(0)} m`);
    }
  });

  test("even spacing: consecutive candidates are >= 40 m apart along the route", () => {
    const along = out.map((c) => project([c.lat, c.lng], POLYLINE).along);
    for (let i = 1; i < along.length; i++) {
      const gap = along[i] - along[i - 1];
      assert.ok(gap >= 40, `${out[i - 1].name} -> ${out[i].name} only ${gap.toFixed(1)} m apart along the route`);
    }
    const pair = ids(out).filter((id) => id === "node/1003" || id === "node/1004");
    assert.equal(pair.length, 1, "of Blue Bottle Coffee / Flour Bakery (10 m apart along the route) exactly one is kept");
  });

  test("dedupe: each osm_id and each name appears at most once", () => {
    assert.equal(new Set(ids(out)).size, out.length, `duplicate osm_id in ${ids(out).join(", ")}`);
    const names = out.map((c) => c.name);
    assert.equal(new Set(names).size, names.length, `duplicate name in ${names.join(", ")}`);
    assert.equal(names.filter((n) => n === "Dunkin'").length, 1, "the two Dunkin' POIs collapse to one candidate");
    assert.equal(ids(out).filter((id) => id === "node/1011").length, 1, "the repeated node/1011 row is one candidate");
  });

  test("no candidate within 15 m of an existing station", () => {
    for (const c of out) {
      for (const s of STATIONS) {
        const d = metres([s.coords.lat, s.coords.lon], [c.lat, c.lng]);
        assert.ok(d > 15, `${c.name} is ${d.toFixed(1)} m from station ${s.n}`);
      }
    }
    assert.ok(!ids(out).includes("node/1002"), "One Broadway (~8 m from station 2) is deduped against the station");
  });

  test("shape: key, POI lat/lng and address, label = address or near <street>", () => {
    for (const c of out) {
      const poi = poiById(c.osm_id);
      assert.ok(poi, `${c.osm_id} is a fixture POI`);
      assert.deepEqual(
        { key: c.key, osm_id: c.osm_id, name: c.name, lat: c.lat, lng: c.lng, address: c.address },
        { key: `candidate:osm:${poi.osm_id}`, osm_id: poi.osm_id, name: poi.name, lat: poi.lat, lng: poi.lng, address: poi.address },
      );
      const want = poi.address !== null ? poi.address : `near ${poi.street}`;
      assert.equal(c.label, want, `${c.name} label`);
      assert.doesNotMatch(c.label, /null|undefined/);
    }
    assert.equal(out.find((c) => c.osm_id === "node/1009").label, "350 Third St");
    assert.equal(out.find((c) => c.osm_id === "node/1005").label, "near Third St");
  });

  test("a POI with neither address nor street is not a candidate", () => {
    assert.ok(!ids(out).includes("node/1007"), "Bench Plaque has nothing to label it with");
  });
});

describe("auto_loci candidates: inputs and edges", () => {
  test("existingStations defaults to none: the POI next to station 2 is then a candidate", () => {
    const out = candidates(POLYLINE, POIS);
    assert.ok(ids(out).includes("node/1002"), `One Broadway expected without stations; got ${ids(out).join(", ")}`);
  });

  test("stations without coords (imported from a backup) are ignored, not a crash", () => {
    const withBare = [...STATIONS, { id: "st-bare", n: 7, name: "imported" }];
    assert.deepEqual(candidates(POLYLINE, POIS, withBare), candidates(POLYLINE, POIS, STATIONS));
  });

  test("pure: deterministic across calls and leaves its inputs untouched", () => {
    const pois = structuredClone(POIS);
    const line = structuredClone(POLYLINE);
    const stations = structuredClone(STATIONS);
    const a = candidates(line, pois, stations);
    const b = candidates(line, pois, stations);
    assert.deepEqual(a, b);
    assert.deepEqual(pois, POIS);
    assert.deepEqual(line, POLYLINE);
    assert.deepEqual(stations, STATIONS);
  });

  test("no POIs or no route -> no candidates", () => {
    assert.deepEqual(candidates(POLYLINE, []), []);
    assert.deepEqual(candidates([], POIS), []);
  });
});

// Covers: MEM-088
// Requirement: one building is one landmark (MEM-088). candidates() skips a POI whose normalized address
// (lowercase, non-alphanumerics collapsed to one space, trimmed, "street" == "st", "avenue" == "ave") equals an
// earlier ELIGIBLE candidate's address or an existing station's `address` (a station with or without coords).
// POIs with a null address (labelled by street) are never address-deduped; a POI beyond 50 m of the route is not
// eligible, so it cannot dedupe a later one.
describe("auto_loci candidates: same-address dedupe (MEM-088)", () => {
  const BASE = [42.36, -71.09];
  /** [lat, lng] at `alongM` metres east of BASE and `offsetM` metres north of the line. */
  const at = (alongM, offsetM = 0) => [
    BASE[0] + offsetM / (RAD * R),
    BASE[1] + alongM / (RAD * R * Math.cos(BASE[0] * RAD)),
  ];
  const LINE = [at(0), at(1000)];
  let seq = 0;
  const poi = (name, address, alongM, offsetM = 5, street = "Binney Street") => {
    const [lat, lng] = at(alongM, offsetM);
    seq += 1;
    return { osm_id: `node/${9000 + seq}`, name, lat, lng, address, street };
  };
  const names = (list) => list.map((c) => c.name);

  test("'100 Binney Street' then '100 binney st.' (>= 40 m apart) -> only the first", () => {
    const a = poi("Lab One", "100 Binney Street", 100);
    const b = poi("Lab Two", "100 binney st.", 300);
    assert.deepEqual(names(candidates(LINE, [a, b])), ["Lab One"]);
  });

  test("'5 Main Ave' then '5 Main Avenue' -> only the first", () => {
    const a = poi("Shop One", "5 Main Ave", 100);
    const b = poi("Shop Two", "5 Main Avenue", 300);
    assert.deepEqual(names(candidates(LINE, [a, b])), ["Shop One"]);
  });

  test("different addresses on the same street are both kept", () => {
    const a = poi("Lab One", "100 Binney Street", 100);
    const b = poi("Lab Two", "102 Binney Street", 300);
    assert.deepEqual(names(candidates(LINE, [a, b])), ["Lab One", "Lab Two"]);
  });

  test("null-address POIs (street label) are never address-deduped", () => {
    const a = poi("Bench", null, 100, 5, "Third St");
    const b = poi("Statue", null, 300, 5, "Third St");
    const out = candidates(LINE, [a, b]);
    assert.deepEqual(names(out), ["Bench", "Statue"]);
    assert.deepEqual(out.map((c) => c.label), ["near Third St", "near Third St"]);
  });

  test("a station's address dedupes a POI more than 15 m from it, with or without coords", () => {
    const a = poi("Lab One", "100 Binney Street", 100);
    const keep = poi("Other", "7 Elm St", 500);
    const withCoords = { id: "st-1", n: 1, name: "S1", address: "100 binney st", coords: { lat: at(300)[0], lon: at(300)[1] } };
    const bare = { id: "st-2", n: 2, name: "S2", address: "100 Binney St." };
    assert.ok(metres(at(100, 5), [withCoords.coords.lat, withCoords.coords.lon]) > 15, "fixture: POI is > 15 m from the station");
    assert.deepEqual(names(candidates(LINE, [a, keep], [withCoords])), ["Other"]);
    assert.deepEqual(names(candidates(LINE, [a, keep], [bare])), ["Other"]);
  });

  test("a station without a matching address does not dedupe", () => {
    const a = poi("Lab One", "100 Binney Street", 100);
    const st = { id: "st-3", n: 3, name: "S3", address: "9 Elm St", coords: { lat: at(700)[0], lon: at(700)[1] } };
    const none = { id: "st-4", n: 4, name: "S4" };
    assert.deepEqual(names(candidates(LINE, [a], [st, none])), ["Lab One"]);
  });

  test("an earlier POI that is not eligible (> 50 m off the route) does not dedupe a later one", () => {
    const far = poi("Far Lab", "9 Elm Street", 100, 80);
    const near = poi("Near Lab", "9 elm st", 300, 5);
    assert.ok(project(at(100, 80), LINE).dist > 50, "fixture: the earlier POI is outside 50 m");
    assert.deepEqual(names(candidates(LINE, [far, near])), ["Near Lab"]);
  });
});
