// Covers: MEM-137
// Requirement: for a landmark the user has not photographed in person, MemriPal can pull the best Mapillary
// street photo instead of the user going there (Kev, R83). Going there in person stays best: a user photo
// always wins and is never replaced. The pure module static/landmark_pull_photo.js ranks Mapillary
// candidates (closer to the landmark is better; a camera facing the landmark beats one facing away; newer
// and higher-quality break near-ties), asks the existing POST /baseline endpoint for candidates, keeps the
// CC BY-SA 4.0 Mapillary credit of every photo it returns, and remembers the pulled choice per landmark.
// Contract (RED; GREEN implements static/landmark_pull_photo.js):
//   rankCandidates(candidates, { lat, lon }, { now }) -> candidates best first; no-position ones dropped
//   pullPhotos(item, { fetchFn }) -> Promise<{ best, candidates, credit, error? }>, never rejects
//     fetchFn is window.fetch-shaped: fetchFn("/baseline", { method: "POST", body: JSON.stringify({ lat, lon }) })
//     resolves a Response. The /baseline answer carries { candidates: [Candidate] }; an answer without a
//     candidates array but with the legacy single-photo fields { image, author, image_url, licence } is one
//     candidate. Candidate = { image, author, image_url, licence, lat, lon, compass_angle?, captured_at?,
//     quality_score? } (Mapillary Graph API field names; captured_at in epoch ms; image an https: URL or a
//     data:image/jpeg base64 URL). A candidate without a valid credit (street_photo.js creditBlock rules) or
//     with any other image scheme is dropped.
//   createPhotoStore({ storage } = {}) -> { get(key), set(key, choice), clear(key) }, get of an unknown key -> null
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import { jsonResponse } from "./fake_dom_test.mjs";

const moduleUrl = new URL("./landmark_pull_photo.js", import.meta.url);

async function lp() {
  assert.ok(existsSync(moduleUrl), "static/landmark_pull_photo.js missing");
  return import(moduleUrl.href);
}

const PAGE = "https://www.mapillary.com/app/?pKey=";
const LICENCE = "CC BY-SA 4.0";
const LICENCE_URL = "https://creativecommons.org/licenses/by-sa/4.0/";
const NOW = Date.UTC(2026, 10, 4);
const DAY = 86_400_000;

// Landmark and offsets: 1e-5 deg latitude is about 1.11 m; at 42.36 N, 1e-5 deg longitude is about 0.82 m.
const T = { lat: 42.36, lon: -71.09 };
const south = (m) => ({ lat: T.lat - m / 111_195, lon: T.lon });
const north = (m) => ({ lat: T.lat + m / 111_195, lon: T.lon });
const east = (m) => ({ lat: T.lat, lon: T.lon + m / 82_170 });

const cand = (id, pos, over = {}) => ({
  image: `https://scontent.xx.fbcdn.net/m1/${id}.jpg`,
  author: `user_${id}`,
  image_url: `${PAGE}${id}`,
  licence: LICENCE,
  ...pos,
  ...over,
});
const ids = (list) => list.map((c) => c.image_url.slice(PAGE.length));

// Compass angle is degrees clockwise from north (Mapillary compass_angle).
const FACING = cand("facing30", south(30), { compass_angle: 0, captured_at: NOW - 30 * DAY });
const AWAY = cand("away10", south(10), { compass_angle: 180, captured_at: NOW - 30 * DAY });
const SIDE = cand("side60", south(60), { compass_angle: 90, captured_at: NOW - 30 * DAY });

// Covers: MEM-137
// Requirement: rankCandidates orders Mapillary photos best first by distance to the landmark, whether the
// camera faces it (circular angle, so 355 deg is 5 deg off north), then recency and quality; candidates
// without a valid position are dropped, invalid input or target yields [], ties are deterministic whatever
// the input order, and the input is never mutated.
describe("rankCandidates", () => {
  const rank = async (list, target = T) => (await lp()).rankCandidates(list, target, { now: NOW });

  test("a near photo facing the landmark beats a nearer photo facing away", async () => {
    assert.deepEqual(ids(await rank([AWAY, FACING])), ["facing30", "away10"]);
  });

  test("both facing: the nearer photo wins", async () => {
    const near = cand("near10", south(10), { compass_angle: 0 });
    const far = cand("far40", south(40), { compass_angle: 0 });
    assert.deepEqual(ids(await rank([far, near])), ["near10", "far40"]);
  });

  test("facing is relative to the bearing from photo to landmark (north and east of it)", async () => {
    const nIn = cand("nIn", north(20), { compass_angle: 180 });
    const nOut = cand("nOut", north(20), { compass_angle: 0 });
    assert.deepEqual(ids(await rank([nOut, nIn])), ["nIn", "nOut"]);
    const eIn = cand("eIn", east(20), { compass_angle: 270 });
    const eOut = cand("eOut", east(20), { compass_angle: 90 });
    assert.deepEqual(ids(await rank([eOut, eIn])), ["eIn", "eOut"]);
  });

  test("facing difference wraps around north", async () => {
    const a = cand("c355", south(20), { compass_angle: 355 });
    const b = cand("c30", south(20), { compass_angle: 30 });
    assert.deepEqual(ids(await rank([b, a])), ["c355", "c30"]);
    const c = cand("c5", south(20), { compass_angle: 5 });
    const d = cand("c330", south(20), { compass_angle: 330 });
    assert.deepEqual(ids(await rank([d, c])), ["c5", "c330"]);
  });

  test("unknown compass ranks between facing and facing away", async () => {
    const facing = cand("f", south(20), { compass_angle: 0 });
    const unknown = cand("u", south(20));
    const away = cand("a", south(20), { compass_angle: 180 });
    assert.deepEqual(ids(await rank([away, unknown, facing])), ["f", "u", "a"]);
  });

  test("same place and facing: the newer capture wins", async () => {
    const old = cand("old", south(20), { compass_angle: 0, captured_at: NOW - 3 * 365 * DAY });
    const fresh = cand("fresh", south(20), { compass_angle: 0, captured_at: NOW - 10 * DAY });
    assert.deepEqual(ids(await rank([old, fresh])), ["fresh", "old"]);
  });

  test("same place, facing and date: the higher quality_score wins", async () => {
    const lo = cand("lo", south(20), { compass_angle: 0, captured_at: NOW - DAY, quality_score: 0.2 });
    const hi = cand("hi", south(20), { compass_angle: 0, captured_at: NOW - DAY, quality_score: 0.9 });
    assert.deepEqual(ids(await rank([lo, hi])), ["hi", "lo"]);
  });

  test("the best of the shared fixture is the facing photo", async () => {
    assert.deepEqual(ids(await rank([SIDE, AWAY, FACING])).slice(0, 1), ["facing30"]);
  });

  const NO_POSITION = [
    ["missing lat", { lat: undefined }],
    ["missing lon", { lon: undefined }],
    ["NaN lon", { lon: Number.NaN }],
    ["lat out of range", { lat: 91 }],
    ["lon out of range", { lon: -181 }],
    ["string lat", { lat: "42.36" }],
    ["null lat", { lat: null }],
  ];
  for (const [label, over] of NO_POSITION) {
    test(`a candidate with ${label} is dropped`, async () => {
      const bad = { ...cand("bad", south(5), { compass_angle: 0 }), ...over };
      assert.deepEqual(ids(await rank([bad, FACING])), ["facing30"]);
    });
  }

  for (const input of [[], null, undefined, "x", {}]) {
    test(`input ${JSON.stringify(input) ?? "undefined"} yields []`, async () => {
      assert.deepEqual(await rank(input), []);
    });
  }

  for (const target of [null, undefined, {}, { lat: 42.36 }, { lat: "42.36", lon: -71.09 }, { lat: 95, lon: 0 }]) {
    test(`target ${JSON.stringify(target) ?? "undefined"} yields []`, async () => {
      const { rankCandidates } = await lp();
      assert.deepEqual(rankCandidates([FACING, AWAY], target, { now: NOW }), []);
    });
  }

  test("non-object entries are dropped", async () => {
    assert.deepEqual(ids(await rank([null, 7, "x", FACING])), ["facing30"]);
  });

  test("exact ties come out in the same order whatever the input order", async () => {
    const a = cand("tieA", south(20), { compass_angle: 0 });
    const b = cand("tieB", south(20), { compass_angle: 0 });
    assert.deepEqual(ids(await rank([a, b])), ids(await rank([b, a])));
  });

  // Seeded generator: deterministic, no wall clock, no Math.random.
  function lcg(seed) {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
  }
  function randomSet(rnd, n) {
    return Array.from({ length: n }, (_, i) => {
      const r = rnd();
      const pos = r < 0.15 ? { lat: undefined, lon: T.lon } : { lat: T.lat + (rnd() - 0.5) * 0.002, lon: T.lon + (rnd() - 0.5) * 0.002 };
      const over = {};
      if (rnd() < 0.8) over.compass_angle = Math.floor(rnd() * 360);
      if (rnd() < 0.7) over.captured_at = NOW - Math.floor(rnd() * 2000) * DAY;
      if (rnd() < 0.5) over.quality_score = Math.round(rnd() * 100) / 100;
      return cand(`g${i}`, pos, over);
    });
  }

  test("property: output is exactly the positioned inputs, order-independent, idempotent, input unmutated", async () => {
    const { rankCandidates } = await lp();
    const rnd = lcg(137);
    for (let round = 0; round < 60; round++) {
      const list = randomSet(rnd, 1 + Math.floor(rnd() * 7));
      const before = JSON.stringify(list);
      const out = rankCandidates(list, T, { now: NOW });
      assert.equal(JSON.stringify(list), before, `round ${round}: input mutated`);
      const positioned = list.filter((c) => typeof c.lat === "number").map((c) => c.image_url).sort();
      assert.deepEqual(out.map((c) => c.image_url).sort(), positioned, `round ${round}: wrong members`);
      const reversed = rankCandidates([...list].reverse(), T, { now: NOW });
      assert.deepEqual(ids(reversed), ids(out), `round ${round}: depends on input order`);
      assert.deepEqual(ids(rankCandidates(out, T, { now: NOW })), ids(out), `round ${round}: not idempotent`);
    }
  });
});

const station = (coords) => ({ key: "osm:n1", name: "MIT Dome", photo_ref: null, station: { id: "a1", coords }, poi: null });
const poiItem = (lat, lng) => ({ key: "candidate:osm:n2", name: "Library", photo_ref: null, station: null, poi: { lat, lng } });

function fetchStub(respond) {
  const calls = [];
  const fn = async (path, init) => {
    calls.push({ path, init });
    return respond(path, init);
  };
  return { fn, calls };
}

// Covers: MEM-137
// Requirement: pullPhotos asks POST /baseline (the street_photo.js endpoint and {lat, lon} body) for the
// landmark's station coords {lat, lon}, else its POI {lat, lng}; without coords it makes no call. It returns
// the ranked candidates, the best one, and the best one's full CC BY-SA 4.0 credit; candidates without a valid
// credit or with an unsafe image are dropped. A backend error, rejection or malformed body yields
// { best: null, candidates: [], error } and never rejects; an empty answer is not an error.
describe("pullPhotos", () => {
  const ok = (body) => fetchStub(() => jsonResponse(body));

  test("POSTs the station coords to /baseline as a JSON {lat, lon} body", async () => {
    const { pullPhotos } = await lp();
    const f = ok({ candidates: [FACING] });
    await pullPhotos(station({ lat: T.lat, lon: T.lon }), { fetchFn: f.fn });
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].path, "/baseline");
    assert.equal(f.calls[0].init.method, "POST");
    assert.deepEqual(JSON.parse(f.calls[0].init.body), { lat: T.lat, lon: T.lon });
  });

  test("a candidate item uses its POI lat/lng as {lat, lon}", async () => {
    const { pullPhotos } = await lp();
    const f = ok({ candidates: [FACING] });
    await pullPhotos(poiItem(42.3611, -71.09005), { fetchFn: f.fn });
    assert.deepEqual(JSON.parse(f.calls[0].init.body), { lat: 42.3611, lon: -71.09005 });
  });

  test("station coords win over POI coords", async () => {
    const { pullPhotos } = await lp();
    const f = ok({ candidates: [FACING] });
    await pullPhotos({ ...station({ lat: T.lat, lon: T.lon }), poi: { lat: 1, lng: 2 } }, { fetchFn: f.fn });
    assert.deepEqual(JSON.parse(f.calls[0].init.body), { lat: T.lat, lon: T.lon });
  });

  const NO_COORDS = [
    ["no station and no poi", { key: "k", photo_ref: null, station: null, poi: null }],
    ["station without coords", { key: "k", photo_ref: null, station: { id: "a1", coords: null }, poi: null }],
    ["poi with string lat", poiItem("42.36", -71.09)],
    ["poi with out-of-range lng", poiItem(42.36, 200)],
    ["null item", null],
  ];
  for (const [label, item] of NO_COORDS) {
    test(`${label}: no fetch, empty result`, async () => {
      const { pullPhotos } = await lp();
      const f = ok({ candidates: [FACING] });
      const out = await pullPhotos(item, { fetchFn: f.fn });
      assert.equal(f.calls.length, 0);
      assert.equal(out.best, null);
      assert.deepEqual(out.candidates, []);
    });
  }

  test("returns ranked candidates, the best first, with the best one's full credit", async () => {
    const { pullPhotos } = await lp();
    const out = await pullPhotos(station({ lat: T.lat, lon: T.lon }), { fetchFn: ok({ candidates: [AWAY, SIDE, FACING] }).fn });
    assert.equal(out.best.image_url, FACING.image_url);
    assert.equal(out.best.image, FACING.image);
    assert.deepEqual(ids(out.candidates).slice(0, 1), ["facing30"]);
    assert.equal(out.candidates.length, 3);
    assert.deepEqual(out.credit, {
      author: FACING.author, image_url: FACING.image_url, licence: LICENCE, licence_url: LICENCE_URL, ai_modified: true,
    });
    assert.ok(!out.error);
  });

  const BAD = [
    ["non-SA licence", { licence: "CC BY-NC-SA 4.0" }],
    ["http image page", { image_url: "http://www.mapillary.com/app/?pKey=1" }],
    ["lookalike image page", { image_url: "https://www.mapillary.com.evil.example/app/?pKey=1" }],
    ["blank author", { author: "  " }],
    ["javascript: image", { image: "javascript:alert(1)" }],
    ["http: image", { image: "http://scontent.xx.fbcdn.net/m1/x.jpg" }],
    ["svg data image", { image: "data:image/svg+xml;base64,PHN2Zz4=" }],
  ];
  for (const [label, over] of BAD) {
    test(`a candidate with ${label} is dropped`, async () => {
      const { pullPhotos } = await lp();
      const bad = cand("bad", south(5), { compass_angle: 0, ...over });
      const out = await pullPhotos(station({ lat: T.lat, lon: T.lon }), { fetchFn: ok({ candidates: [bad, FACING] }).fn });
      assert.deepEqual(ids(out.candidates), ["facing30"]);
      assert.equal(out.best.image_url, FACING.image_url);
    });
  }

  test("a legacy single-photo answer is one candidate with its credit", async () => {
    const { pullPhotos } = await lp();
    const legacy = { image: "data:image/jpeg;base64,/9j/AA==", author: "kendall_walker", image_url: `${PAGE}42`, licence: LICENCE };
    const out = await pullPhotos(station({ lat: T.lat, lon: T.lon }), { fetchFn: ok(legacy).fn });
    assert.equal(out.best.image, legacy.image);
    assert.equal(out.candidates.length, 1);
    assert.equal(out.credit.author, "kendall_walker");
  });

  test("an empty candidates list is an empty result, not an error", async () => {
    const { pullPhotos } = await lp();
    const out = await pullPhotos(station({ lat: T.lat, lon: T.lon }), { fetchFn: ok({ candidates: [] }).fn });
    assert.equal(out.best, null);
    assert.deepEqual(out.candidates, []);
    assert.ok(!out.error, "empty is not an error");
  });

  const FAILS = [
    ["404 no_baseline", () => jsonResponse({ error: "no_baseline" }, 404)],
    ["502 upstream", () => jsonResponse({ error: "upstream" }, 502)],
    ["429 budget_exhausted", () => jsonResponse({ error: "budget_exhausted" }, 429)],
    ["malformed JSON body", () => new Response("not json", { status: 200 })],
    ["rejected fetch", () => Promise.reject(new TypeError("network down"))],
    ["fetch throwing synchronously", () => { throw new Error("boom"); }],
  ];
  for (const [label, respond] of FAILS) {
    test(`${label}: { best: null, candidates: [], error }, never rejects`, async () => {
      const { pullPhotos } = await lp();
      const out = await pullPhotos(station({ lat: T.lat, lon: T.lon }), { fetchFn: (p, i) => respond(p, i) });
      assert.equal(out.best, null);
      assert.deepEqual(out.candidates, []);
      assert.ok(out.error, "error is set");
    });
  }
});

function fakeStorage({ throws = false } = {}) {
  const map = new Map();
  const guard = () => {
    if (throws) throw new Error("SecurityError");
  };
  return {
    map,
    getItem: (k) => (guard(), map.has(k) ? map.get(k) : null),
    setItem: (k, v) => (guard(), map.set(k, String(v))),
    removeItem: (k) => (guard(), map.delete(k)),
  };
}

// Covers: MEM-137
// Requirement: the pulled photo choice is remembered per landmark (item.key) so reopening the detail dialog
// shows it again: get/set/clear in memory, persisted through an optional localStorage-shaped storage; a
// throwing or corrupted storage never breaks the store.
describe("createPhotoStore", () => {
  test("get of an unknown key is null; set then get round-trips; clear forgets only that key", async () => {
    const { createPhotoStore } = await lp();
    const s = createPhotoStore();
    assert.equal(s.get("osm:n1"), null);
    s.set("osm:n1", FACING);
    s.set("osm:n2", AWAY);
    assert.deepEqual(s.get("osm:n1"), FACING);
    s.clear("osm:n1");
    assert.equal(s.get("osm:n1"), null);
    assert.deepEqual(s.get("osm:n2"), AWAY);
  });

  test("a second store on the same storage sees the choice (dialog reopen / reload)", async () => {
    const { createPhotoStore } = await lp();
    const storage = fakeStorage();
    createPhotoStore({ storage }).set("osm:n1", FACING);
    const again = createPhotoStore({ storage });
    assert.deepEqual(again.get("osm:n1"), FACING);
    again.clear("osm:n1");
    assert.equal(createPhotoStore({ storage }).get("osm:n1"), null);
  });

  test("a throwing storage never throws and the store still works in memory", async () => {
    const { createPhotoStore } = await lp();
    const s = createPhotoStore({ storage: fakeStorage({ throws: true }) });
    s.set("osm:n1", FACING);
    assert.deepEqual(s.get("osm:n1"), FACING);
    s.clear("osm:n1");
    assert.equal(s.get("osm:n1"), null);
  });

  test("a corrupted stored value reads as null", async () => {
    const { createPhotoStore } = await lp();
    const storage = fakeStorage();
    createPhotoStore({ storage }).set("osm:n1", FACING);
    for (const k of storage.map.keys()) storage.map.set(k, "{not json");
    assert.equal(createPhotoStore({ storage }).get("osm:n1"), null);
  });
});
