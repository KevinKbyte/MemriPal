// Covers: MEM-051
// Requirement: a route practice run is recorded as a rehearsal with mode "route" and hits keyed by
// station id (plan B6, D9), so per-station hit rates (MK5) follow the station, not its position: after
// two route rehearsals (6/6, then 3/6) #hit-rates shows one row per station with 100% or 50% as
// recorded, unchanged by an Up/Down swap; ids no longer on the route are ignored. A non-route save keeps
// exactly the MEM-033 record fields.
// Contract (RED; GREEN implements static/rehearsals.js):
//   store.save(palaceId, { transcript, results, mode: "route", hits }) stores mode "route" and hits
//     ({ [stationId]: boolean }) on the record; without mode "route" neither key is stored.
//   routeHitRates(route, records) -> [{ id, name, hits, runs, rate }] in current route order; only
//     mode "route" records count; a station's run counts only when the record's hits has its id.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import * as reh from "./rehearsals.js";

function memoryAdapter() {
  const map = new Map();
  return {
    map,
    async get(k) { return map.get(k); },
    async put(k, v) { map.set(k, v); },
    async delete(k) { map.delete(k); },
    async list() { return [...map.values()]; },
  };
}

function clockAndIds() {
  let t = Date.parse("2026-10-31T08:00:00.000Z");
  let n = 0;
  return { now: () => (t += 1000), newId: () => `reh-${++n}` };
}

const IDS = ["st-1", "st-2", "st-3", "st-4", "st-5", "st-6"];
const NAMES = ["red bench", "old oak", "stone arch", "blue gate", "brick wall", "corner shop"];
const route = () => ({ id: "r1", name: "Commute", kind: "daily", status: "saved", created_at: "2026-10-30T08:00:00.000Z",
  stations: IDS.map((id, i) => ({ id, n: i + 1, name: NAMES[i], photo_ref: `ph-${i}`, status: "named" })), lists: [] });
const results = (gots) => NAMES.map((n, i) => ({ label: n, source_quote: n, got: gots[i], override: false, span: gots[i] ? n : null }));
const hitsOf = (gots) => Object.fromEntries(IDS.map((id, i) => [id, gots[i]]));
const ALL = [true, true, true, true, true, true];
const HALF = [true, false, true, false, true, false];

function rates() {
  assert.equal(typeof reh.routeHitRates, "function", "static/rehearsals.js must export routeHitRates");
  return reh.routeHitRates;
}

describe("rehearsal store: route runs carry mode and hits by station id (criterion 7)", () => {
  test('a route save stores mode "route" and hits keyed by station id', async () => {
    const store = reh.createRehearsalStore(memoryAdapter(), clockAndIds());
    const saved = await store.save("r1", { transcript: "red bench", results: results(HALF), mode: "route", hits: hitsOf(HALF) });
    assert.equal(saved.mode, "route");
    assert.deepEqual(saved.hits, hitsOf(HALF));
    const [listed] = await store.list("r1");
    assert.equal(listed.mode, "route");
    assert.deepEqual(listed.hits, hitsOf(HALF));
  });

  test("a non-route save keeps exactly the MEM-033 fields", async () => {
    const store = reh.createRehearsalStore(memoryAdapter(), clockAndIds());
    const saved = await store.save("demo", { transcript: "x", results: results(HALF), hits: hitsOf(HALF) });
    assert.deepEqual(Object.keys(saved).sort(), ["id", "palace_id", "points", "timestamp", "transcript"]);
  });

  test("hits keep only boolean values for string ids", async () => {
    const store = reh.createRehearsalStore(memoryAdapter(), clockAndIds());
    const saved = await store.save("r1", { transcript: "", results: [], mode: "route",
      hits: { "st-1": true, "st-2": "yes", "st-3": false } });
    assert.deepEqual(saved.hits, { "st-1": true, "st-3": false });
  });
});

describe("per-station hit rates keyed by station id (criterion 12)", () => {
  async function twoRuns() {
    const store = reh.createRehearsalStore(memoryAdapter(), clockAndIds());
    await store.save("r1", { transcript: "", results: results(ALL), mode: "route", hits: hitsOf(ALL) });
    await store.save("r1", { transcript: "", results: results(HALF), mode: "route", hits: hitsOf(HALF) });
    return store.list("r1");
  }

  test("6/6 then 3/6 -> one row per station, 100% or 50%", async () => {
    const rows = rates()(route(), await twoRuns());
    assert.deepEqual(rows.map((r) => r.name), NAMES);
    assert.deepEqual(rows.map((r) => r.rate), [1, 0.5, 1, 0.5, 1, 0.5]);
    assert.deepEqual(rows.map((r) => r.runs), [2, 2, 2, 2, 2, 2]);
  });

  test("an Up/Down swap of stations 2 and 3 moves the rates with the stations", async () => {
    const r = route();
    [r.stations[1], r.stations[2]] = [r.stations[2], r.stations[1]];
    const rows = rates()(r, await twoRuns());
    assert.deepEqual(rows.map((x) => x.id), ["st-1", "st-3", "st-2", "st-4", "st-5", "st-6"]);
    assert.deepEqual(rows.map((x) => x.rate), [1, 1, 0.5, 0.5, 1, 0.5]);
  });

  test("ids no longer on the route are ignored; non-route records do not count", async () => {
    const r = route();
    r.stations.splice(5, 1);
    const listRun = { id: "x", palace_id: "r1", timestamp: "2026-10-31T09:00:00.000Z", transcript: "", points: [] };
    const rows = rates()(r, [...(await twoRuns()), listRun]);
    assert.equal(rows.length, 5);
    assert.ok(!rows.some((x) => x.id === "st-6"));
    assert.deepEqual(rows.map((x) => x.runs), [2, 2, 2, 2, 2]);
  });
});
