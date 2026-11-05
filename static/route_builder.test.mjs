// Covers: MEM-088
// Requirement: "Map a new route" turns a typed start and end into a savable route preview (MEM-088 landing 1).
// static/route_builder.js holds the pure pieces the page uses:
//   distanceLabel(length_m, fallback): under 1000 m the distance rounds to the nearest 50 m ("About 600 m");
//     from 1000 m it is km with one decimal ("About 1.2 km"); the walk time is max(1, round(m / 80)) minutes
//     ("about 8 min walk"); a straight-line fallback appends " (straight line; walking paths unavailable)".
//   pickStations(from, to, cands, max = 8): [start, ...middle, end]; middle = every candidate when there are at
//     most max - 2, else max - 2 evenly sampled at indices round(i * (len - 1) / (k - 1)). Each station is
//     { id (unique string), n (1-based), name, coords: { lat, lon } (lon from lng), address } where address is
//     the place's own address, else the candidate's label; an endpoint with a null address has no address key.
//   missText(phrase, suggestions): 'No match for "<phrase>". Try: A, B.' or, with no suggestions,
//     'No match for "<phrase>".'
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { distanceLabel, missText, pickStations } from "./route_builder.js";

const FALLBACK = " (straight line; walking paths unavailable)";

const FROM = { name: "Kendall/MIT T", lat: 42.36242, lng: -71.08572, address: "300 Main Street" };
const TO = { name: "Meta office", lat: 42.36554, lng: -71.0809, address: "100 Binney St" };

/** n auto_loci-shaped candidates; odd ones carry no address (street-labelled). */
function cands(n) {
  return Array.from({ length: n }, (_, i) => {
    const address = i % 2 === 0 ? `${100 + i} Third St` : null;
    return {
      key: `candidate:osm:node/${i}`, osm_id: `node/${i}`, name: `Spot ${i}`,
      lat: 42.363 + i * 0.0001, lng: -71.084 + i * 0.0001, address, label: address ?? "near Third St",
    };
  });
}
const middleNames = (stations) => stations.slice(1, -1).map((s) => s.name);

describe("distanceLabel: rounded distance and walk time", () => {
  test("612 m -> About 600 m, about 8 min walk", () => {
    assert.equal(distanceLabel(612, false), "About 600 m, about 8 min walk");
  });

  test("1234 m -> About 1.2 km, about 15 min walk", () => {
    assert.equal(distanceLabel(1234, false), "About 1.2 km, about 15 min walk");
  });

  test("1000 m is the first km value, one decimal", () => {
    assert.equal(distanceLabel(1000, false), "About 1.0 km, about 13 min walk");
  });

  test("under 1000 m rounds to the nearest 50 m", () => {
    assert.equal(distanceLabel(724, false), "About 700 m, about 9 min walk");
    assert.equal(distanceLabel(726, false), "About 750 m, about 9 min walk");
  });

  test("a very short walk is still at least 1 min", () => {
    assert.equal(distanceLabel(30, false), "About 50 m, about 1 min walk");
  });

  test("a straight-line fallback says so", () => {
    assert.equal(distanceLabel(612, true), `About 600 m, about 8 min walk${FALLBACK}`);
    assert.equal(distanceLabel(1234, true), `About 1.2 km, about 15 min walk${FALLBACK}`);
  });
});

describe("pickStations: start, sampled landmarks, end", () => {
  test("no candidates -> start and end only, numbered 1 and 2", () => {
    const out = pickStations(FROM, TO, []);
    assert.deepEqual(out.map((s) => [s.n, s.name]), [[1, "Kendall/MIT T"], [2, "Meta office"]]);
  });

  test("endpoints: coords { lat, lon } from lat/lng and the place's own address", () => {
    const [start, end] = pickStations(FROM, TO, []);
    assert.deepEqual({ name: start.name, coords: start.coords, address: start.address },
      { name: "Kendall/MIT T", coords: { lat: 42.36242, lon: -71.08572 }, address: "300 Main Street" });
    assert.deepEqual({ name: end.name, coords: end.coords, address: end.address },
      { name: "Meta office", coords: { lat: 42.36554, lon: -71.0809 }, address: "100 Binney St" });
  });

  test("an endpoint with a null address carries no address key", () => {
    const park = { name: "Toomey Park", lat: 42.36601, lng: -71.08069, address: null };
    const [, end] = pickStations(FROM, park, []);
    assert.equal(end.name, "Toomey Park");
    assert.ok(!("address" in end), `end station has address ${JSON.stringify(end.address)}`);
  });

  test("candidates within max - 2 are all kept, in order, between the endpoints", () => {
    const out = pickStations(FROM, TO, cands(3));
    assert.equal(out.length, 5);
    assert.deepEqual(middleNames(out), ["Spot 0", "Spot 1", "Spot 2"]);
    assert.equal(out[0].name, "Kendall/MIT T");
    assert.equal(out[4].name, "Meta office");
  });

  test("exactly max - 2 candidates are all kept (boundary)", () => {
    const out = pickStations(FROM, TO, cands(6));
    assert.equal(out.length, 8);
    assert.deepEqual(middleNames(out), ["Spot 0", "Spot 1", "Spot 2", "Spot 3", "Spot 4", "Spot 5"]);
  });

  test("one over max - 2 is sampled to max - 2 at round(i * (len - 1) / (k - 1))", () => {
    const out = pickStations(FROM, TO, cands(7));
    assert.equal(out.length, 8);
    assert.deepEqual(middleNames(out), ["Spot 0", "Spot 1", "Spot 2", "Spot 4", "Spot 5", "Spot 6"]);
  });

  test("10 candidates, default max 8 -> indices 0, 2, 4, 5, 7, 9", () => {
    const out = pickStations(FROM, TO, cands(10));
    assert.equal(out.length, 8);
    assert.deepEqual(middleNames(out), ["Spot 0", "Spot 2", "Spot 4", "Spot 5", "Spot 7", "Spot 9"]);
  });

  test("a smaller max: max 4 over 10 candidates keeps the first and last", () => {
    const out = pickStations(FROM, TO, cands(10), 4);
    assert.deepEqual(out.map((s) => s.name), ["Kendall/MIT T", "Spot 0", "Spot 9", "Meta office"]);
  });

  test("candidate stations: coords from lat/lng, address = POI address else its label", () => {
    const list = cands(2);
    const [, a, b] = pickStations(FROM, TO, list);
    assert.deepEqual({ name: a.name, coords: a.coords, address: a.address },
      { name: "Spot 0", coords: { lat: list[0].lat, lon: list[0].lng }, address: "100 Third St" });
    assert.deepEqual({ name: b.name, coords: b.coords, address: b.address },
      { name: "Spot 1", coords: { lat: list[1].lat, lon: list[1].lng }, address: "near Third St" });
  });

  test("n runs 1..N and every id is a unique string", () => {
    const out = pickStations(FROM, TO, cands(10));
    assert.deepEqual(out.map((s) => s.n), [1, 2, 3, 4, 5, 6, 7, 8]);
    for (const s of out) assert.equal(typeof s.id, "string", `station ${s.n} id`);
    assert.equal(new Set(out.map((s) => s.id)).size, out.length, "ids are unique");
  });

  test("leaves its inputs untouched", () => {
    const list = cands(10);
    const before = structuredClone([FROM, TO, list]);
    pickStations(FROM, TO, list);
    assert.deepEqual([FROM, TO, list], before);
  });
});

describe("missText: a geocode miss never dead-ends", () => {
  test("names the phrase and lists the suggestions", () => {
    const text = missText("zzqx", [{ name: "Meta office" }, { name: "Kendall/MIT T" }]);
    assert.equal(text, 'No match for "zzqx". Try: Meta office, Kendall/MIT T.');
  });

  test("no suggestions -> just the miss", () => {
    assert.equal(missText("zzqx", []), 'No match for "zzqx".');
  });
});

// Covers: MEM-144
// Requirement: a landmark POI's category and OSM tags feed its emoji pick, so a POI with an unhelpful name but
// category "cafe" (or tag amenity=cafe) gets the coffee cup, not the pushpin. pickStations passes
// { name, category, tags } of each place into emojiFor.
describe("MEM-144 pickStations passes POI category and tags into emojiFor", () => {
  const COFFEE = "\u{2615}";
  const poi = (extra) => ({ name: "Xyzzy", lat: 42.363, lng: -71.084, address: null, label: "near Third St", ...extra });

  test("category cafe -> coffee", () => {
    const [, mid] = pickStations(FROM, TO, [poi({ category: "cafe" })]);
    assert.equal(mid.emoji, COFFEE);
  });

  test("tags amenity=cafe -> coffee", () => {
    const [, mid] = pickStations(FROM, TO, [poi({ tags: { amenity: "cafe" } })]);
    assert.equal(mid.emoji, COFFEE);
  });
});
