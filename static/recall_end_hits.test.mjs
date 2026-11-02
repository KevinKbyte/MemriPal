// Covers: MEM-033, MEM-051
// Requirement: on a route practice end screen, "Mark got it" on a missed station counts that station as
// learned everywhere the run is read: the rehearsal's hits ({ [stationId]: boolean }, route order, the
// same order as its points) sets that station true, so the route card's "Learned n/N" and the per-station
// hit rates include the override, not only the said-vs-palace row. Every other station's hit is kept, the
// record passed in is not changed, and marking an already-got point or a non-route run (no hits) never
// throws and never invents a hits map.
// Contract (RED; GREEN implements static/recall_end.js):
//   markPointGot(record, i) on a route record whose points[i] is missed returns a record whose hits has the
//     i-th station id (route order) set true; every other hits entry is unchanged; record is not mutated.
//   Already-got point -> hits deep-equal to before. Record without hits -> result has no hits key.
//   learnedCount(route, [marked]).n and routeHitRates(route, [marked]) count the overridden station.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { markPointGot } from "./recall_end.js";
import { createRehearsalStore, routeHitRates } from "./rehearsals.js";
import { learnedCount, routePracticePoints } from "./route_map.js";

function memoryAdapter() {
  const map = new Map();
  return {
    async get(k) { return map.get(k); },
    async put(k, v) { map.set(k, v); },
    async delete(k) { map.delete(k); },
    async list() { return [...map.values()]; },
  };
}

const IDS = ["r1-st-1", "r1-st-2", "r1-st-3", "r1-st-4", "r1-st-5", "r1-st-6"];
const NAMES = ["red bench", "old oak", "stone arch", "blue gate", "brick wall", "corner shop"];
const ROUTE = { id: "r1", name: "Commute", kind: "daily", status: "saved", created_at: "2026-10-30T08:00:00.000Z",
  stations: IDS.map((id, i) => ({ id, n: i + 1, name: NAMES[i], photo_ref: `ph-${i}`, status: "named" })), lists: [] };
const GOTS = [true, true, false, true, false, true];

/** A route run saved the way flow.js endRun saves it: results from the route's practice points, hits by station id. */
async function savedRouteRun(gots = GOTS) {
  let n = 0;
  const store = createRehearsalStore(memoryAdapter(), { now: () => Date.parse("2026-11-01T08:00:00.000Z"), newId: () => `reh-${++n}` });
  const results = routePracticePoints(ROUTE).map((p, i) => ({ ...p, got: gots[i], override: false, span: gots[i] ? p.label : null }));
  const hits = Object.fromEntries(IDS.map((id, i) => [id, gots[i]]));
  return store.save(ROUTE.id, { transcript: "red bench old oak blue gate corner shop", results, mode: "route", hits });
}

describe("markPointGot keeps a route rehearsal's hits in step with the override", () => {
  test("marking missed station r1-st-3 sets its hit true", async () => {
    const record = await savedRouteRun();
    const marked = markPointGot(record, 2);
    assert.equal(marked.points[2].got, true);
    assert.equal(marked.hits?.["r1-st-3"], true, `hits after Mark got it: ${JSON.stringify(marked.hits)}`);
  });

  test("every other station's hit is unchanged", async () => {
    const record = await savedRouteRun();
    const marked = markPointGot(record, 2);
    assert.deepEqual(marked.hits, { ...record.hits, "r1-st-3": true });
  });

  test("two overrides in a row both land in hits (second builds on the first)", async () => {
    const record = await savedRouteRun();
    const marked = markPointGot(markPointGot(record, 2), 4);
    assert.deepEqual(marked.hits, Object.fromEntries(IDS.map((id) => [id, true])));
  });

  test("the record passed in is not mutated", async () => {
    const record = await savedRouteRun();
    const before = structuredClone(record);
    markPointGot(record, 2);
    assert.deepEqual(record, before);
  });

  test("marking an already-got point keeps hits as they were and does not throw", async () => {
    const record = await savedRouteRun();
    const marked = markPointGot(record, 0);
    assert.deepEqual(marked.hits, record.hits);
  });

  test("a non-route record (no hits) does not throw and gains no hits key", async () => {
    let n = 0;
    const store = createRehearsalStore(memoryAdapter(), { now: () => 0, newId: () => `reh-${++n}` });
    const record = await store.save("demo", { transcript: "", results: [{ label: "a", source_quote: "a", got: false }] });
    const marked = markPointGot(record, 0);
    assert.equal(marked.points[0].got, true);
    assert.equal(Object.hasOwn(marked, "hits"), false);
  });
});

describe("route readers count a Mark got it override", () => {
  test("Learned n/N includes the overridden station", async () => {
    const marked = markPointGot(await savedRouteRun(), 2);
    assert.deepEqual(learnedCount(ROUTE, [marked]), { n: 5, N: 6 });
  });

  test("per-station hit rate for the overridden station is 1/1", async () => {
    const marked = markPointGot(await savedRouteRun(), 2);
    const st3 = routeHitRates(ROUTE, [marked]).find((r) => r.id === "r1-st-3");
    assert.deepEqual([st3?.hits, st3?.runs], [1, 1]);
  });
});
