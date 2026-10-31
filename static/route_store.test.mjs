// Covers: MEM-048
// Requirement: a walked route and its stations persist on the phone. static/route_store.js keeps
// routes [{id, name, kind daily|occasional, status draft|saved, created_at, stations[{id, n, name,
// photo_ref, status, box?, profile?, taps?, coords?}], lists[]}] through the injected KV adapter
// (idb_adapter.js shape: get/put/delete/list), coords rounded to 4 dp at write, no captured_at field.
// The store accepts 0-8 stations (a walk in progress or a drop is never refused below 8; the 9th is
// refused); Finish walk's Save enforces 3-8 named stations and no pending one. Order = capture order;
// Up/Down swaps persist. A Finish-walk row drop is arm -> Confirm (or Cancel) -> Undo, and Undo puts
// back the same station at the same position.
// Contract (RED; GREEN implements, ADR route store):
//   createRouteStore(adapter) -> {
//     createRoute({name?, kind?}) -> route (status "draft", stations [], lists [])
//     listRoutes() -> route[]; getRoute(id) -> route | null
//     updateRoute(id, {name?, kind?}) -> route
//     deleteRoute(id); undoDelete() restores the last deleted route
//     addStation(routeId, {photo, coords?: {lat, lon}}) -> station (status "pending"); rejects at 9
//     getPhoto(photo_ref) -> bytes (Uint8Array | ArrayBuffer | Blob) | null
//     nameStation(routeId, stationId, {name, profile?, box?, photo}) -> station (status "named")
//     dropStation(routeId, stationId); undoDrop(routeId)
//     moveStation(routeId, stationId, delta -1 | 1)
//     finishSave(routeId, {name, kind}) -> rejects unless finishSaveError(route) is null; then "saved"
//   }, all async; a new store over the same adapter (a reload) reads back the same routes.
//   finishSaveError(route) -> null when 3-8 named stations and none pending, else a message string.
//   createFinishReview(store, routeId) -> {arm(stationId), armed() -> id | null, cancel(),
//     confirm() (async, drops the armed station), undo() (async), canUndo()}.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import * as rs from "./route_store.js";
import { memoryAdapter, toBytes, ENCODED, PIXELATED } from "./route_store_fakes_test.mjs";

const photo = () => ENCODED.slice();

async function routeWith(store, count) {
  const route = await store.createRoute({ name: "Morning loop", kind: "daily" });
  const stations = [];
  for (let i = 0; i < count; i++) stations.push(await store.addStation(route.id, { photo: photo() }));
  return { route, stations };
}

const ids = (route) => route.stations.map((s) => s.id);

// Covers: MEM-048
// Requirement: route_store.js exports the store, the Finish-walk save rule and the row-drop review.
describe("route store exports", () => {
  test("exports createRouteStore, finishSaveError and createFinishReview", () => {
    assert.equal(typeof rs.createRouteStore, "function");
    assert.equal(typeof rs.finishSaveError, "function");
    assert.equal(typeof rs.createFinishReview, "function");
  });
});

// Covers: MEM-048
// Requirement: routes can be created, listed, read, updated and deleted with Undo, and survive a
// reload (a new store over the same KV adapter).
describe("route store: route CRUD with undo (criterion 1)", () => {
  test("createRoute returns a draft route with an id, created_at, no stations and no lists", async () => {
    const store = rs.createRouteStore(memoryAdapter());
    const route = await store.createRoute({ name: "Morning loop", kind: "daily" });
    assert.equal(typeof route.id, "string");
    assert.ok(route.id.length > 0);
    assert.equal(route.name, "Morning loop");
    assert.equal(route.kind, "daily");
    assert.equal(route.status, "draft");
    assert.ok(route.created_at, "created_at is set");
    assert.deepEqual(route.stations, []);
    assert.deepEqual(route.lists, []);
  });

  test("listRoutes and getRoute return created routes; a reload reads the same routes", async () => {
    const kv = memoryAdapter();
    const store = rs.createRouteStore(kv);
    const a = await store.createRoute({ name: "A", kind: "daily" });
    const b = await store.createRoute({ name: "B", kind: "occasional" });
    assert.notEqual(a.id, b.id);
    assert.deepEqual((await store.listRoutes()).map((r) => r.id).sort(), [a.id, b.id].sort());
    const reloaded = rs.createRouteStore(kv);
    assert.deepEqual(await reloaded.getRoute(a.id), a);
    assert.deepEqual(await reloaded.getRoute(b.id), b);
  });

  test("getRoute of an unknown id returns null", async () => {
    const store = rs.createRouteStore(memoryAdapter());
    assert.equal(await store.getRoute("nope"), null);
  });

  test("updateRoute changes name and kind and persists", async () => {
    const kv = memoryAdapter();
    const store = rs.createRouteStore(kv);
    const r = await store.createRoute({ name: "A", kind: "daily" });
    await store.updateRoute(r.id, { name: "Park walk", kind: "occasional" });
    const back = await rs.createRouteStore(kv).getRoute(r.id);
    assert.equal(back.name, "Park walk");
    assert.equal(back.kind, "occasional");
  });

  test("deleteRoute removes the route; undoDelete restores it deep-equal, also after a reload", async () => {
    const kv = memoryAdapter();
    const store = rs.createRouteStore(kv);
    const { route } = await routeWith(store, 2);
    const before = await store.getRoute(route.id);
    await store.deleteRoute(route.id);
    assert.equal(await store.getRoute(route.id), null);
    assert.equal((await store.listRoutes()).length, 0);
    await store.undoDelete();
    assert.deepEqual(await store.getRoute(route.id), before);
    assert.deepEqual(await rs.createRouteStore(kv).getRoute(route.id), before);
  });

  test("no station carries a captured_at field", async () => {
    const store = rs.createRouteStore(memoryAdapter());
    const { route } = await routeWith(store, 1);
    const st = (await store.getRoute(route.id)).stations[0];
    assert.equal("captured_at" in st, false);
  });
});

// Covers: MEM-048
// Requirement: the store accepts 0-8 stations: 1- and 2-station drafts store, a drop from a 3-station
// draft is allowed, and the 9th station is refused without changing the route.
describe("route store: station count 0-8 (criterion 1)", () => {
  for (const n of [1, 2]) {
    test(`a ${n}-station draft is stored and survives a reload`, async () => {
      const kv = memoryAdapter();
      const store = rs.createRouteStore(kv);
      const { route } = await routeWith(store, n);
      const back = await rs.createRouteStore(kv).getRoute(route.id);
      assert.equal(back.stations.length, n);
      assert.equal(back.status, "draft");
      assert.ok(back.stations.every((s) => s.status === "pending"));
    });
  }

  test("dropping a station from a 3-station draft is allowed", async () => {
    const store = rs.createRouteStore(memoryAdapter());
    const { route, stations } = await routeWith(store, 3);
    await store.dropStation(route.id, stations[1].id);
    assert.deepEqual(ids(await store.getRoute(route.id)), [stations[0].id, stations[2].id]);
  });

  test("8 stations are accepted; the 9th is refused and the route keeps 8", async () => {
    const store = rs.createRouteStore(memoryAdapter());
    const { route } = await routeWith(store, 8);
    assert.equal((await store.getRoute(route.id)).stations.length, 8);
    await assert.rejects(store.addStation(route.id, { photo: photo() }));
    assert.equal((await store.getRoute(route.id)).stations.length, 8);
  });
});

const station = (i, status) => ({ id: `s${i}`, n: i + 1, name: status === "named" ? `Stop ${i}` : "", photo_ref: `p${i}`, status });
const routeOf = (named, pending = 0) => ({
  id: "r1",
  name: "Loop",
  kind: "daily",
  status: "draft",
  created_at: "2026-10-31T00:00:00Z",
  stations: [
    ...Array.from({ length: named }, (_, i) => station(i, "named")),
    ...Array.from({ length: pending }, (_, i) => station(named + i, "pending")),
  ],
  lists: [],
});

// Covers: MEM-048
// Requirement: Finish walk's Save accepts only 3-8 named stations with none pending.
describe("finish-save rule: 3-8 named, none pending (criterion 2)", () => {
  const cases = [
    { label: "2 named refused", route: routeOf(2), ok: false },
    { label: "9 named refused", route: routeOf(9), ok: false },
    { label: "3 named accepted", route: routeOf(3), ok: true },
    { label: "8 named accepted", route: routeOf(8), ok: true },
    { label: "3 named + 1 pending refused", route: routeOf(3, 1), ok: false },
  ];
  for (const c of cases) {
    test(c.label, () => {
      const err = rs.finishSaveError(c.route);
      if (c.ok) assert.equal(err, null);
      else assert.ok(typeof err === "string" && err.length > 0, `expected a refusal message, got ${err}`);
    });
  }

  test("store.finishSave refuses 2 named stations and the route stays a draft", async () => {
    const store = rs.createRouteStore(memoryAdapter());
    const { route, stations } = await routeWith(store, 2);
    for (const s of stations) await store.nameStation(route.id, s.id, { name: `n${s.id}`, photo: PIXELATED.slice() });
    await assert.rejects(store.finishSave(route.id, { name: "Loop", kind: "daily" }));
    assert.equal((await store.getRoute(route.id)).status, "draft");
  });

  test("store.finishSave refuses a pending station among 3 named", async () => {
    const store = rs.createRouteStore(memoryAdapter());
    const { route, stations } = await routeWith(store, 4);
    for (const s of stations.slice(0, 3)) await store.nameStation(route.id, s.id, { name: `n${s.id}`, photo: PIXELATED.slice() });
    await assert.rejects(store.finishSave(route.id, { name: "Loop", kind: "daily" }));
    assert.equal((await store.getRoute(route.id)).status, "draft");
  });

  test("store.finishSave with 3 named saves the route with its name and kind, persisted", async () => {
    const kv = memoryAdapter();
    const store = rs.createRouteStore(kv);
    const { route, stations } = await routeWith(store, 3);
    for (const s of stations) await store.nameStation(route.id, s.id, { name: `n${s.id}`, photo: PIXELATED.slice() });
    await store.finishSave(route.id, { name: "Park loop", kind: "occasional" });
    const back = await rs.createRouteStore(kv).getRoute(route.id);
    assert.equal(back.status, "saved");
    assert.equal(back.name, "Park loop");
    assert.equal(back.kind, "occasional");
  });
});

/** Deterministic LCG so the property inputs are fixed across runs. */
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const decimals = (v) => {
  const str = String(v);
  assert.ok(!/e/i.test(str), `coordinate ${str} must not be in exponent form`);
  const dot = str.indexOf(".");
  return dot < 0 ? 0 : str.length - dot - 1;
};

// Covers: MEM-048
// Requirement: station coordinates are stored with at most 4 decimals (about 11 m), rounded at write.
describe("route store: coords rounded to 4 dp at write (criterion 3)", () => {
  test("20 generated coordinates are stored with <= 4 decimals and within 0.00005 of the input", async () => {
    const rand = lcg(48);
    const kv = memoryAdapter();
    const store = rs.createRouteStore(kv);
    const inputs = [];
    for (let k = 0; k < 20; k += 1) {
      const lat = -89 + rand() * 178 + rand() * 1e-7;
      const lon = -179 + rand() * 358 + rand() * 1e-7;
      inputs.push({ lat, lon });
    }
    const routes = [];
    for (let k = 0; k < 20; k += 5) {
      const r = await store.createRoute({ name: `r${k}`, kind: "daily" });
      for (const c of inputs.slice(k, k + 5)) await store.addStation(r.id, { photo: photo(), coords: c });
      routes.push(r.id);
    }
    const reloaded = rs.createRouteStore(kv);
    const stored = [];
    for (const id of routes) stored.push(...(await reloaded.getRoute(id)).stations.map((s) => s.coords));
    assert.equal(stored.length, 20);
    stored.forEach((c, i) => {
      assert.ok(decimals(c.lat) <= 4, `lat ${c.lat} has more than 4 decimals`);
      assert.ok(decimals(c.lon) <= 4, `lon ${c.lon} has more than 4 decimals`);
      assert.ok(Math.abs(c.lat - inputs[i].lat) <= 0.00005 + 1e-9, `lat ${c.lat} vs ${inputs[i].lat}`);
      assert.ok(Math.abs(c.lon - inputs[i].lon) <= 0.00005 + 1e-9, `lon ${c.lon} vs ${inputs[i].lon}`);
    });
  });

  test("a station without coords stores no coords", async () => {
    const store = rs.createRouteStore(memoryAdapter());
    const { route } = await routeWith(store, 1);
    assert.equal((await store.getRoute(route.id)).stations[0].coords ?? null, null);
  });
});

// Covers: MEM-048
// Requirement: stations are listed in capture order; Up/Down swaps a station with its neighbour and
// the new order survives a reload.
describe("route store: capture order and Up/Down (criterion 4)", () => {
  test("stations are listed in capture order with increasing capture index n", async () => {
    const store = rs.createRouteStore(memoryAdapter());
    const { route, stations } = await routeWith(store, 4);
    const back = await store.getRoute(route.id);
    assert.deepEqual(ids(back), stations.map((s) => s.id));
    for (let i = 1; i < back.stations.length; i++) assert.ok(back.stations[i].n > back.stations[i - 1].n);
  });

  test("Down then Up swaps persist across a reload", async () => {
    const kv = memoryAdapter();
    const store = rs.createRouteStore(kv);
    const { route, stations } = await routeWith(store, 3);
    const [a, b, c] = stations.map((s) => s.id);
    await store.moveStation(route.id, a, 1);
    assert.deepEqual(ids(await rs.createRouteStore(kv).getRoute(route.id)), [b, a, c]);
    await store.moveStation(route.id, c, -1);
    assert.deepEqual(ids(await rs.createRouteStore(kv).getRoute(route.id)), [b, c, a]);
  });

  test("Up on the first or Down on the last station leaves the order unchanged", async () => {
    const store = rs.createRouteStore(memoryAdapter());
    const { route, stations } = await routeWith(store, 3);
    const order = stations.map((s) => s.id);
    await store.moveStation(route.id, order[0], -1).catch(() => {});
    await store.moveStation(route.id, order[2], 1).catch(() => {});
    assert.deepEqual(ids(await store.getRoute(route.id)), order);
  });
});

// Covers: MEM-048
// Requirement: dropping a Finish-walk row is arm -> Confirm (Cancel restores) -> Undo, and Undo
// restores the same station (deep-equal, same id) at the same position.
describe("finish review: row drop arm/cancel/confirm/undo (criterion 10)", () => {
  test("first click arms (confirm visible) without removing anything", async () => {
    const store = rs.createRouteStore(memoryAdapter());
    const { route, stations } = await routeWith(store, 4);
    const review = rs.createFinishReview(store, route.id);
    review.arm(stations[1].id);
    assert.equal(review.armed(), stations[1].id);
    assert.equal((await store.getRoute(route.id)).stations.length, 4);
  });

  test("Cancel disarms and keeps every station", async () => {
    const store = rs.createRouteStore(memoryAdapter());
    const { route, stations } = await routeWith(store, 4);
    const review = rs.createFinishReview(store, route.id);
    review.arm(stations[1].id);
    review.cancel();
    assert.equal(review.armed(), null);
    assert.deepEqual(ids(await store.getRoute(route.id)), stations.map((s) => s.id));
    assert.equal(review.canUndo(), false);
  });

  test("Confirm removes the armed station; Undo restores it deep-equal at the same position", async () => {
    const kv = memoryAdapter();
    const store = rs.createRouteStore(kv);
    const { route, stations } = await routeWith(store, 4);
    await store.nameStation(route.id, stations[2].id, { name: "Red door", profile: { visual: "red" }, photo: PIXELATED.slice() });
    const before = await store.getRoute(route.id);
    const review = rs.createFinishReview(store, route.id);
    review.arm(stations[2].id);
    await review.confirm();
    assert.equal(review.armed(), null);
    const dropped = await rs.createRouteStore(kv).getRoute(route.id);
    assert.deepEqual(ids(dropped), [stations[0].id, stations[1].id, stations[3].id]);
    assert.equal(review.canUndo(), true);
    await review.undo();
    const restored = await rs.createRouteStore(kv).getRoute(route.id);
    assert.deepEqual(restored.stations, before.stations);
    assert.equal(restored.stations[2].id, stations[2].id);
    assert.equal(review.canUndo(), false);
  });

  test("Confirm with nothing armed removes nothing", async () => {
    const store = rs.createRouteStore(memoryAdapter());
    const { route } = await routeWith(store, 3);
    const review = rs.createFinishReview(store, route.id);
    await review.confirm();
    assert.equal((await store.getRoute(route.id)).stations.length, 3);
  });

  test("a dropped station's photo is still readable after Undo", async () => {
    const store = rs.createRouteStore(memoryAdapter());
    const { route, stations } = await routeWith(store, 3);
    const review = rs.createFinishReview(store, route.id);
    review.arm(stations[0].id);
    await review.confirm();
    await review.undo();
    const st = (await store.getRoute(route.id)).stations[0];
    assert.deepEqual(await toBytes(await store.getPhoto(st.photo_ref)), ENCODED);
  });
});
