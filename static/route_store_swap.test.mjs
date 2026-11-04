// Covers: MEM-085
// Requirement: a route's landmark can be swapped for a nearby auto-locus candidate, or a candidate added,
// without ever losing data (ADR 0047): swap exchanges one station and one candidate in place, the outgoing
// station persists whole (photo_ref and photo included) under its candidate key, so swapping it back
// restores it deep-equal; Undo puts the route back as it was; the route never holds more than
// MAX_STATIONS = 8. Candidate keys: candidate:osm:<osm_id> for a map-derived station, candidate:st:<station
// id> for a walked one. Backup v2 is unchanged: an untouched route exports the same, and no address,
// osm_id or coords reach a backup. Precision (ADR 0053): public / seeded / candidate coords at 5 dp, the
// user's own GPS at 4 dp; the 6 demo stations carry a hand-verified street address and 5-dp coords.
// Contract (RED; GREEN adds to static/route_store.js createRouteStore, coordsOf / round4 gain a dp param):
//   swapStation(routeId, stationId, candidate) -> { station, outgoing: { key, station } }
//     candidate: a map candidate {key: "candidate:osm:<osm_id>", osm_id, name, lat, lng, address, label}
//       (static/auto_loci.js) or {key} of a stored candidate. A stored entry under candidate.key wins and
//       comes back whole. A fresh map candidate becomes {id: <new>, n, name, photo_ref: <new>,
//       status: "named", coords: {lat, lon} at 5 dp, address, osm_id}. The incoming station takes the
//       outgoing one's slot and n. The outgoing station is written to KV as is (the value is the station)
//       under candidate:osm:<osm_id> when it has an osm_id, else candidate:st:<station id>; its photo is
//       never deleted. A key outside those two prefixes, an unknown station, or a {key} with nothing
//       stored and no candidate fields rejects and changes nothing.
//   undoSwap(routeId) -> route | null: restores the route and candidate entries as before the last swap;
//     null when there is nothing to undo (single level, like undoDrop).
//   addCandidate(routeId, candidate) -> station appended with n = max n + 1; RangeError at MAX_STATIONS.
//   seedRoute keeps each station's address and stores coords at 5 dp; addStation (GPS) stays 4 dp.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import * as rs from "./route_store.js";
import { exportRoutes, importRoutes } from "./backup_routes.js";
import { DEMO_ROUTE } from "./demo_route.js";
import { fakeLoadImage, fakeThumbnail, makeJpeg } from "./backup_fixtures_test.mjs";
import { mapCandidate, memoryAdapter, toBytes } from "./route_store_fakes_test.mjs";

const BOX = { x1: 10, y1: 20, x2: 110, y2: 220 };
const BACKUP_STATION_KEYS = ["id", "n", "name", "status", "box", "profile", "taps", "photo"];

/** A saved walked route of `count` named stations, each with its own photo and GPS coords. */
async function walkedRoute(store, count = 3, name = "Morning loop") {
  const r = await store.createRoute({ name, kind: "daily" });
  for (let i = 0; i < count; i++) {
    const st = await store.addStation(r.id, { photo: makeJpeg(800, 600), coords: { lat: 42.3624 + i / 1000, lon: -71.0856 } });
    await store.nameStation(r.id, st.id, {
      name: `Stop ${i + 1}`, box: BOX, profile: { visual: `door ${i + 1}` }, photo: makeJpeg(800, 600, { fill: 0x40 + i }),
    });
  }
  if (count >= rs.MIN_SAVE_STATIONS) await store.finishSave(r.id, { name, kind: "daily" });
  return store.getRoute(r.id);
}

const ids = (route) => route.stations.map((s) => s.id);
const photoOf = async (store, ref) => toBytes(await store.getPhoto(ref));

const decimals = (v) => {
  const str = String(v);
  assert.ok(!/e/i.test(str), `coordinate ${str} must not be in exponent form`);
  const dot = str.indexOf(".");
  return dot < 0 ? 0 : str.length - dot - 1;
};

// Covers: MEM-085
// Requirement: swap exchanges a station and a candidate in place and never loses the outgoing station or its photo.
describe("route store: swap a station for a candidate (MEM-085, ADR 0047)", () => {
  test("a fresh map candidate takes the outgoing slot and n as a named station with 5-dp coords, address and osm_id", async () => {
    const kv = memoryAdapter();
    const store = rs.createRouteStore(kv);
    const r = await walkedRoute(store);
    const out = r.stations[1];
    const { station } = await store.swapStation(r.id, out.id, mapCandidate("node/101"));
    assert.notEqual(station.id, out.id);
    assert.equal(station.n, out.n);
    assert.equal(station.name, "Landmark node/101");
    assert.equal(station.status, "named");
    assert.deepEqual(station.coords, { lat: 42.36301, lon: -71.08383 });
    assert.equal(station.address, "245 Third St");
    assert.equal(station.osm_id, "node/101");
    assert.ok(typeof station.photo_ref === "string" && station.photo_ref !== out.photo_ref, "a fresh photo_ref");
    const back = await rs.createRouteStore(kv).getRoute(r.id);
    assert.deepEqual(ids(back), [r.stations[0].id, station.id, r.stations[2].id]);
    assert.deepEqual(back.stations[1], station);
  });

  test("the outgoing walked station persists whole under candidate:st:<station id> and keeps its photo", async () => {
    const kv = memoryAdapter();
    const store = rs.createRouteStore(kv);
    const r = await walkedRoute(store);
    const out = r.stations[1];
    const bytes = await photoOf(store, out.photo_ref);
    const { outgoing } = await store.swapStation(r.id, out.id, mapCandidate("node/101"));
    assert.equal(outgoing.key, `candidate:st:${out.id}`);
    assert.deepEqual(outgoing.station, out);
    assert.deepEqual(await kv.get(`candidate:st:${out.id}`), out, "the KV value is the full station, photo_ref included");
    assert.deepEqual(await photoOf(rs.createRouteStore(kv), out.photo_ref), bytes, "the outgoing photo is not deleted");
  });

  test("swap round-trips photo_ref: swapping the stored candidate back restores the walked station deep-equal", async () => {
    const kv = memoryAdapter();
    const store = rs.createRouteStore(kv);
    const r = await walkedRoute(store);
    const out = r.stations[1];
    const bytes = await photoOf(store, out.photo_ref);
    const { station: incoming } = await store.swapStation(r.id, out.id, mapCandidate("node/101"));
    const { station: back } = await store.swapStation(r.id, incoming.id, { key: `candidate:st:${out.id}` });
    assert.deepEqual(back, out);
    const reloaded = rs.createRouteStore(kv);
    assert.deepEqual((await reloaded.getRoute(r.id)).stations, r.stations);
    assert.deepEqual(await photoOf(reloaded, out.photo_ref), bytes);
  });

  test("a map-derived station swaps out under candidate:osm:<osm_id>; that candidate swapped back in returns it whole", async () => {
    const kv = memoryAdapter();
    const store = rs.createRouteStore(kv);
    const r = await walkedRoute(store);
    const { station: placed } = await store.swapStation(r.id, r.stations[1].id, mapCandidate("node/7"));
    const photo = makeJpeg(640, 480, { fill: 0x77 });
    await store.nameStation(r.id, placed.id, { name: "Brick arch", photo });
    const named = (await store.getRoute(r.id)).stations[1];
    const { station: other, outgoing } = await store.swapStation(r.id, named.id, mapCandidate("node/8"));
    assert.equal(outgoing.key, "candidate:osm:node/7");
    assert.deepEqual(await kv.get("candidate:osm:node/7"), named);
    const { station: again } = await store.swapStation(r.id, other.id, mapCandidate("node/7"));
    assert.deepEqual(again, named, "the stored entry wins over the fresh candidate fields");
    assert.deepEqual(await photoOf(rs.createRouteStore(kv), named.photo_ref), await toBytes(photo));
  });

  test(`a swap on a full route (MAX_STATIONS = ${rs.MAX_STATIONS}) is one-for-one and keeps ${rs.MAX_STATIONS} stations`, async () => {
    assert.equal(rs.MAX_STATIONS, 8);
    const store = rs.createRouteStore(memoryAdapter());
    const r = await walkedRoute(store, 8);
    await store.swapStation(r.id, r.stations[7].id, mapCandidate("node/101"));
    const back = await store.getRoute(r.id);
    assert.equal(back.stations.length, 8);
    assert.deepEqual(ids(back).slice(0, 7), ids(r).slice(0, 7));
  });

  test("swapping an unknown station rejects and leaves the route unchanged", async () => {
    const store = rs.createRouteStore(memoryAdapter());
    const r = await walkedRoute(store);
    await assert.rejects(store.swapStation(r.id, "no-such-station", mapCandidate("node/101")));
    assert.deepEqual(await store.getRoute(r.id), r);
  });

  test("a {key} with nothing stored under it and no candidate fields rejects and leaves the route unchanged", async () => {
    const store = rs.createRouteStore(memoryAdapter());
    const r = await walkedRoute(store);
    await assert.rejects(store.swapStation(r.id, r.stations[0].id, { key: "candidate:st:no-such-station" }));
    assert.deepEqual(await store.getRoute(r.id), r);
  });

  test("a candidate key outside candidate:osm: / candidate:st: is refused and no other record changes", async () => {
    const kv = memoryAdapter();
    const store = rs.createRouteStore(kv);
    const r = await walkedRoute(store);
    const other = await walkedRoute(store, 3, "Park loop");
    const bad = { ...mapCandidate("node/101"), key: `route:${other.id}` };
    await assert.rejects(store.swapStation(r.id, r.stations[0].id, bad));
    const reloaded = rs.createRouteStore(kv);
    assert.deepEqual(await reloaded.getRoute(r.id), r);
    assert.deepEqual(await reloaded.getRoute(other.id), other);
  });
});

// Covers: MEM-085
// Requirement: Undo after a swap puts the route and the candidate entries back as they were.
describe("route store: undoSwap (MEM-085)", () => {
  test("undoSwap with nothing to undo returns null", async () => {
    const store = rs.createRouteStore(memoryAdapter());
    const r = await walkedRoute(store);
    assert.equal(await store.undoSwap(r.id), null);
  });

  test("undoSwap restores the route deep-equal with the outgoing photo, survives a reload, and is single-level", async () => {
    const kv = memoryAdapter();
    const store = rs.createRouteStore(kv);
    const r = await walkedRoute(store);
    const out = r.stations[1];
    const bytes = await photoOf(store, out.photo_ref);
    await store.swapStation(r.id, out.id, mapCandidate("node/101"));
    const undone = await store.undoSwap(r.id);
    assert.deepEqual(undone, r);
    const reloaded = rs.createRouteStore(kv);
    assert.deepEqual(await reloaded.getRoute(r.id), r);
    assert.deepEqual(await photoOf(reloaded, out.photo_ref), bytes);
    assert.equal(await store.undoSwap(r.id), null, "a second undo with no new swap is a no-op");
  });

  test("undoing a swap-back restores the stored candidate, so it can be swapped in again", async () => {
    const store = rs.createRouteStore(memoryAdapter());
    const r = await walkedRoute(store);
    const out = r.stations[1];
    const { station: incoming } = await store.swapStation(r.id, out.id, mapCandidate("node/101"));
    const mid = await store.getRoute(r.id);
    await store.swapStation(r.id, incoming.id, { key: `candidate:st:${out.id}` });
    assert.deepEqual(await store.undoSwap(r.id), mid);
    const { station: back } = await store.swapStation(r.id, incoming.id, { key: `candidate:st:${out.id}` });
    assert.deepEqual(back, out);
    assert.deepEqual((await store.getRoute(r.id)).stations, r.stations);
  });
});

// Covers: MEM-085
// Requirement: adding a candidate appends a named station and is refused past MAX_STATIONS = 8.
describe("route store: addCandidate respects MAX_STATIONS (MEM-085)", () => {
  test("adds the candidate at the end as a named station: n = max n + 1, 5-dp coords, address, osm_id; persisted", async () => {
    const kv = memoryAdapter();
    const store = rs.createRouteStore(kv);
    const r = await walkedRoute(store);
    const st = await store.addCandidate(r.id, mapCandidate("way/55", { address: null, label: "near Binney St" }));
    assert.equal(st.n, Math.max(...r.stations.map((s) => s.n)) + 1);
    assert.equal(st.name, "Landmark way/55");
    assert.equal(st.status, "named");
    assert.equal(st.osm_id, "way/55");
    assert.deepEqual(st.coords, { lat: 42.36301, lon: -71.08383 });
    assert.equal(st.address ?? null, null, "no address is never invented from the label");
    const back = await rs.createRouteStore(kv).getRoute(r.id);
    assert.deepEqual(ids(back), [...ids(r), st.id]);
  });

  test(`the ${rs.MAX_STATIONS + 1}th station is refused with a RangeError and the route keeps its ${rs.MAX_STATIONS}`, async () => {
    const store = rs.createRouteStore(memoryAdapter());
    const r = await walkedRoute(store, 8);
    await assert.rejects(store.addCandidate(r.id, mapCandidate("node/101")), RangeError);
    assert.deepEqual(await store.getRoute(r.id), r);
  });
});

// Covers: MEM-085
// Requirement: swaps and candidates leave backup v2 export unchanged; no address, osm_id or coords leave the phone.
describe("backup v2 unchanged by swaps and candidates (MEM-085, ADR 0033 / 0047)", () => {
  test("an untouched route exports the same before and after swap, add and undo on another route", async () => {
    const store = rs.createRouteStore(memoryAdapter());
    const touched = await walkedRoute(store);
    const untouched = await walkedRoute(store, 3, "Park loop");
    const entry = async () => (await exportRoutes(store, fakeThumbnail)).find((x) => x.id === untouched.id);
    const before = await entry();
    assert.ok(before, "the untouched route is exported");
    await store.swapStation(touched.id, touched.stations[0].id, mapCandidate("node/101"));
    await store.addCandidate(touched.id, mapCandidate("node/102"));
    await store.swapStation(touched.id, touched.stations[2].id, mapCandidate("node/103"));
    await store.undoSwap(touched.id);
    assert.deepEqual(await entry(), before);
  });

  test("a swapped route exports only backup v2 station keys (no address, osm_id or coords) and re-imports", async () => {
    const store = rs.createRouteStore(memoryAdapter());
    const r = await walkedRoute(store);
    await store.swapStation(r.id, r.stations[1].id, mapCandidate("node/101"));
    await store.addCandidate(r.id, mapCandidate("node/102"));
    const exported = await exportRoutes(store, fakeThumbnail);
    const mine = exported.find((x) => x.id === r.id);
    assert.equal(mine.stations.length, 4);
    for (const s of mine.stations) {
      const extra = Object.keys(s).filter((k) => !BACKUP_STATION_KEYS.includes(k));
      assert.deepEqual(extra, [], `station ${s.n} exports only backup v2 keys`);
    }
    const imported = await importRoutes(exported, fakeLoadImage);
    assert.equal(imported.length, exported.length);
  });
});

// Covers: MEM-085
// Requirement: seeded and candidate coords keep 5 dp, GPS stays 4 dp; demo stations carry a street address.
describe("coords precision and demo addresses (MEM-085, ADR 0053)", () => {
  test("each of the 6 demo stations carries a hand-verified street address (non-empty, <= 100 chars)", () => {
    assert.equal(DEMO_ROUTE.stations.length, 6);
    for (const s of DEMO_ROUTE.stations) {
      assert.ok(typeof s.address === "string" && s.address.trim() !== "", `station ${s.n} has an address, got ${s.address}`);
      assert.ok(s.address.length <= 100, `station ${s.n} address is at most 100 chars`);
    }
  });

  test("each demo station's coords are pinned to 5 dp", () => {
    for (const s of DEMO_ROUTE.stations) {
      for (const v of [s.coords.lat, s.coords.lon]) {
        assert.ok(decimals(v) <= 5 && Number(v.toFixed(5)) === v, `station ${s.n} coord ${v} is a 5-dp value`);
      }
      // A trailing 0 drops from a JS number, so a 5-dp pair shows 5 decimals on at least one side.
      assert.ok(decimals(s.coords.lat) === 5 || decimals(s.coords.lon) === 5, `station ${s.n} coords ${JSON.stringify(s.coords)} are 5 dp`);
    }
  });

  test("seedRoute(DEMO_ROUTE) stores each station's address and its 5-dp coords unrounded", async () => {
    const kv = memoryAdapter();
    const store = rs.createRouteStore(kv);
    await store.seedRoute(DEMO_ROUTE);
    const back = await rs.createRouteStore(kv).getRoute(DEMO_ROUTE.id);
    back.stations.forEach((s, i) => {
      const want = DEMO_ROUTE.stations[i];
      assert.deepEqual(s.coords, want.coords, `station ${want.n} coords`);
      assert.equal(s.address, want.address, `station ${want.n} address`);
    });
  });

  test("seedRoute rounds seeded coords to 5 dp (about 1 m), not 4", async () => {
    const store = rs.createRouteStore(memoryAdapter());
    const seeded = await store.seedRoute({
      id: "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", name: "Seed", kind: "daily",
      stations: [{ id: "8b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e", n: 1, name: "Corner", coords: { lat: 42.3623849, lon: -71.0856123 } }],
    });
    assert.deepEqual(seeded.stations[0].coords, { lat: 42.36238, lon: -71.08561 });
  });

  test("a GPS-captured station (addStation) stays at 4 dp", async () => {
    const store = rs.createRouteStore(memoryAdapter());
    const r = await store.createRoute({ name: "Walk", kind: "daily" });
    const st = await store.addStation(r.id, { photo: makeJpeg(800, 600), coords: { lat: 42.362384, lon: -71.085612 } });
    assert.deepEqual(st.coords, { lat: 42.3624, lon: -71.0856 });
  });
});

// Covers: MEM-100
// Requirement: "Load demo" keeps each demo station's landmark emoji, so the live map shows it instead of the
// default pushpin after the seeded route is read back from storage; a seeded station given no emoji stores none
// (the map then falls back to U+1F4CD). Contract (RED; GREEN: static/route_store.js seedRoute copies s.emoji
// onto the stored station when present, like address).
describe("seedRoute keeps each demo station's emoji (MEM-100)", () => {
  test("seedRoute(DEMO_ROUTE) persists each station's emoji, read back through a fresh store", async () => {
    const kv = memoryAdapter();
    await rs.createRouteStore(kv).seedRoute(DEMO_ROUTE);
    const back = await rs.createRouteStore(kv).getRoute(DEMO_ROUTE.id);
    assert.equal(back.stations.length, DEMO_ROUTE.stations.length);
    back.stations.forEach((s, i) => {
      const want = DEMO_ROUTE.stations[i];
      assert.ok(want.emoji, `precondition: demo station ${want.n} has an emoji, got ${want.emoji}`);
      assert.equal(s.emoji, want.emoji, `station ${want.n} emoji`);
    });
  });

  test("a seeded station given no emoji has no emoji key", async () => {
    const kv = memoryAdapter();
    await rs.createRouteStore(kv).seedRoute({
      id: "9c3d4e5f-6a7b-4c8d-8e9f-1a2b3c4d5e6f", name: "Seed", kind: "daily",
      stations: [{ id: "ad4e5f6a-7b8c-4d9e-9f0a-2b3c4d5e6f7a", n: 1, name: "Corner", coords: { lat: 42.36238, lon: -71.0856 } }],
    });
    const back = await rs.createRouteStore(kv).getRoute("9c3d4e5f-6a7b-4c8d-8e9f-1a2b3c4d5e6f");
    assert.equal(back.stations.length, 1);
    assert.ok(!("emoji" in back.stations[0]), `no emoji key, got ${JSON.stringify(back.stations[0])}`);
  });
});
