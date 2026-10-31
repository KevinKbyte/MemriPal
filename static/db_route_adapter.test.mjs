// Covers: MEM-039
// Requirement: routes and their stations persist in on-device SQLite through the same KV adapter
// seam the route store already uses (get/put/delete/list), so route_store.js is unchanged (item 159
// S2). A route reads back exactly as written: optional keys that were absent stay absent, stations
// keep their order, unknown or malformed fields survive, and routes list in creation order (an
// update keeps its place). Photo bytes stay in the photo KV (IndexedDB), never in SQL. A failed
// write leaves the previously stored route intact.
// Soft delete (plan AMENDMENT, Kev 2026-10-31): the adapter never issues SQL DELETE. Deleting a route
// stamps deleted_at on it and its live stations; a station dropped from a re-put route becomes a
// tombstone (deleted_at set, pos NULL). Reads skip deleted rows. Re-putting a deleted route (or a
// dropped station) revives the same row. Routes list by ord; insert and revive set ord = max + 1, so a
// deleted then re-stored route lists last, matching the in-memory Map adapter.
// Contract (RED; GREEN implements in static/db/route_adapter.js):
//   createSqlRouteAdapter(db, photoKv) -> { get(key), put(key, value), delete(key), list() }, async.
//     db = async client shape (static/db/client.js; tests: asClient(syncDb) from node_driver.js)
//     over a database migrated with static/db/schema.js MIGRATIONS.
//     "route:<id>" <-> { type: "route", route }; get of a missing key -> undefined.
//     list() -> live routes as { type: "route", route } ordered by routes.ord.
//     delete("route:<id>") -> routes.deleted_at (and its live stations' deleted_at) set to a TEXT stamp.
//     "photo:<ref>" keys go to photoKv unchanged (same key, same value); other prefixes throw TypeError.
//     A station's photo_ref is stored in stations.photo_id.
//     A key whose value is undefined reads back absent; a null value reads back null.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { openMemoryDb } from "./db/node_driver.js";
import { runMigrations } from "./db/migrations.js";

const drv = await import("./db/node_driver.js");
const schema = await import("./db/schema.js").catch((err) => ({ __missing: String(err) }));
const mod = await import("./db/route_adapter.js").catch((err) => ({ __missing: String(err) }));

/** Photo KV stand-in (IndexedDB in the app), Map-backed. */
function mapPhotoKv() {
  const map = new Map();
  return {
    map,
    get: async (key) => (map.has(key) ? structuredClone(map.get(key)) : undefined),
    put: async (key, v) => void map.set(key, structuredClone(v)),
    delete: async (key) => void map.delete(key),
    list: async () => [...map.values()].map((v) => structuredClone(v)),
  };
}

async function setup() {
  assert.ok("createSqlRouteAdapter" in mod,
    `static/db/route_adapter.js must export createSqlRouteAdapter (${mod.__missing ?? "not exported"})`);
  assert.ok("MIGRATIONS" in schema, `static/db/schema.js must export MIGRATIONS (${schema.__missing ?? "not exported"})`);
  assert.ok("asClient" in drv, "static/db/node_driver.js must export asClient");
  const db = await openMemoryDb();
  await runMigrations(db, schema.MIGRATIONS);
  const photos = mapPhotoKv();
  const kv = mod.createSqlRouteAdapter(drv.asClient(db), photos);
  return { db, photos, kv };
}

function station(i, extra = {}) {
  return {
    id: `s${i}`, n: i, name: `Station ${i}`, photo_ref: `p${i}`, status: "named",
    box: { x1: 1 + i, y1: 2.5, x2: 30, y2: 40.25 },
    profile: { visual: "red door", spatial: "left", conceptual: "entry" },
    taps: { colour: "red" },
    coords: { lat: 51.5074, lon: -0.1278 },
    ...extra,
  };
}

function route(id, stations = [station(1), station(2), station(3)], extra = {}) {
  return {
    id, name: `Route ${id}`, kind: "daily", status: "saved", created_at: "2026-10-01T08:00:00.000Z",
    stations, lists: [{ id: "l1", name: "Shopping", status: "active" }],
    ...extra,
  };
}

const value = (r) => ({ type: "route", route: r });
const listed = async (kv) => (await kv.list()).filter((v) => v?.type === "route").map((v) => v.route.id);

// Covers: MEM-039
// Requirement: a route written through the adapter reads back deep-equal, absent optional keys absent.
describe("sql route adapter: round trip", () => {
  test("a full route with stations reads back deep-equal", async () => {
    const { kv } = await setup();
    const r = route("r1");
    await kv.put("route:r1", value(r));
    assert.deepEqual(await kv.get("route:r1"), value(r));
  });

  test("a pending station without box/profile/taps/coords reads back without those keys", async () => {
    const { kv } = await setup();
    const bare = { id: "s1", n: 1, name: "", photo_ref: "p1", status: "pending" };
    const r = route("r1", [bare], { status: "draft", lists: [] });
    await kv.put("route:r1", value(r));
    const back = (await kv.get("route:r1")).route;
    assert.deepEqual(back, r);
    for (const k of ["box", "profile", "taps", "coords"]) assert.ok(!(k in back.stations[0]), `${k} must stay absent`);
  });

  test("a route with no stations and empty lists round-trips", async () => {
    const { kv } = await setup();
    const r = route("r1", [], { lists: [] });
    await kv.put("route:r1", value(r));
    assert.deepEqual(await kv.get("route:r1"), value(r));
  });

  test("stations come back in written order, not id or n order", async () => {
    const { kv } = await setup();
    const r = route("r1", [station(3), station(1), station(2, { n: 9 })]);
    await kv.put("route:r1", value(r));
    assert.deepEqual((await kv.get("route:r1")).route.stations.map((s) => s.id), ["s3", "s1", "s2"]);
  });

  test("re-putting a route replaces its stations (reorder, drop)", async () => {
    const { kv } = await setup();
    await kv.put("route:r1", value(route("r1")));
    const next = route("r1", [station(3), station(1)], { name: "Renamed" });
    await kv.put("route:r1", value(next));
    assert.deepEqual(await kv.get("route:r1"), value(next));
  });

  test("get of a missing route is undefined", async () => {
    const { kv } = await setup();
    assert.equal(await kv.get("route:nope"), undefined);
  });

  test("the same station id in two routes is kept in both (imported routes keep station ids)", async () => {
    const { kv } = await setup();
    await kv.put("route:a", value(route("a")));
    await kv.put("route:b", value(route("b")));
    assert.deepEqual(await kv.get("route:a"), value(route("a")));
    assert.deepEqual(await kv.get("route:b"), value(route("b")));
  });

  test("a key whose value is undefined reads back absent; a null value reads back null", async () => {
    const { kv } = await setup();
    const r = route("r1", [station(1, { box: null, coords: undefined })], { note: undefined });
    await kv.put("route:r1", value(r));
    const back = (await kv.get("route:r1")).route;
    assert.ok(!("note" in back), "undefined route key must read back absent");
    assert.ok(!("coords" in back.stations[0]), "undefined station key must read back absent");
    assert.equal(back.stations[0].box, null);
  });
});

// Covers: MEM-039
// Requirement: routes list in the order they were first stored; updating a route keeps its place;
// a deleted then re-stored route goes to the end; delete hides the route and its stations from reads.
describe("sql route adapter: list order and delete", () => {
  test("list returns routes in insertion order and an update keeps the position", async () => {
    const { kv } = await setup();
    for (const id of ["c", "a", "b"]) await kv.put(`route:${id}`, value(route(id)));
    await kv.put("route:c", value(route("c", [station(5)], { name: "Updated" })));
    assert.deepEqual(await listed(kv), ["c", "a", "b"]);
    const entry = (await kv.list()).find((v) => v?.route?.id === "c");
    assert.deepEqual(entry, value(route("c", [station(5)], { name: "Updated" })));
  });

  test("list on an empty database returns no routes", async () => {
    const { kv } = await setup();
    assert.deepEqual(await listed(kv), []);
  });

  test("delete hides the route and its stations; re-storing it lists it last", async () => {
    const { kv } = await setup();
    for (const id of ["a", "b", "c"]) await kv.put(`route:${id}`, value(route(id)));
    await kv.delete("route:a");
    assert.equal(await kv.get("route:a"), undefined);
    assert.deepEqual(await listed(kv), ["b", "c"]);
    await kv.put("route:a", value(route("a")));
    assert.deepEqual(await listed(kv), ["b", "c", "a"]);
    assert.deepEqual(await kv.get("route:a"), value(route("a")));
  });

  test("deleting a missing route does not throw", async () => {
    const { kv } = await setup();
    await kv.delete("route:nope");
    assert.deepEqual(await listed(kv), []);
  });
});

// Covers: MEM-039
// Requirement: nothing is hard-deleted (Kev 2026-10-31; full purge is a later Settings feature):
// deleting a route keeps its rows stamped deleted_at, a station dropped from a route stays as a
// tombstone with no position, and re-storing either revives the same row at the end of the list.
describe("sql route adapter: soft delete keeps rows", () => {
  const live = (db, table, where) =>
    db.query(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where} AND deleted_at IS NULL`);
  const dead = (db, table, where) =>
    db.query(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where} AND deleted_at IS NOT NULL`);

  test("delete keeps the route row and its station rows, stamped with a TEXT deleted_at", async () => {
    const { db, kv } = await setup();
    await kv.put("route:a", value(route("a")));
    await kv.delete("route:a");
    assert.deepEqual(await dead(db, "routes", "id = 'a'"), [{ n: 1 }]);
    assert.deepEqual(await dead(db, "stations", "route_id = 'a'"), [{ n: 3 }]);
    assert.deepEqual(await live(db, "stations", "route_id = 'a'"), [{ n: 0 }]);
    const stamps = await db.query("SELECT deleted_at FROM routes WHERE id = 'a'");
    assert.equal(typeof stamps[0].deleted_at, "string");
  });

  test("a station dropped by a re-put stays as a tombstone with pos NULL and is not read back", async () => {
    const { db, kv } = await setup();
    await kv.put("route:r1", value(route("r1")));
    const next = route("r1", [station(3), station(1)]);
    await kv.put("route:r1", value(next));
    assert.deepEqual(await db.query(
      "SELECT pos, deleted_at IS NOT NULL AS gone FROM stations WHERE route_id = 'r1' AND id = 's2'"),
    [{ pos: null, gone: 1 }]);
    assert.deepEqual(await db.query(
      "SELECT id, pos FROM stations WHERE route_id = 'r1' AND deleted_at IS NULL ORDER BY pos"),
    [{ id: "s3", pos: 0 }, { id: "s1", pos: 1 }]);
    assert.deepEqual(await kv.get("route:r1"), value(next));
  });

  test("re-adding a tombstoned station revives the same row with its new position", async () => {
    const { db, kv } = await setup();
    await kv.put("route:r1", value(route("r1")));
    await kv.put("route:r1", value(route("r1", [station(1), station(3)])));
    const back = route("r1", [station(2, { name: "Back" }), station(1), station(3)]);
    await kv.put("route:r1", value(back));
    assert.deepEqual(await kv.get("route:r1"), value(back));
    assert.deepEqual(await db.query("SELECT pos, deleted_at FROM stations WHERE route_id = 'r1' AND id = 's2'"),
      [{ pos: 0, deleted_at: null }]);
  });

  test("reviving a deleted route reuses its row (seq unchanged) and leaves unlisted stations deleted", async () => {
    const { db, kv } = await setup();
    await kv.put("route:a", value(route("a")));
    const [{ seq }] = await db.query("SELECT seq FROM routes WHERE id = 'a'");
    await kv.delete("route:a");
    const revived = route("a", [station(2)]);
    await kv.put("route:a", value(revived));
    assert.deepEqual(await db.query("SELECT seq, deleted_at FROM routes WHERE id = 'a'"), [{ seq, deleted_at: null }]);
    assert.deepEqual(await kv.get("route:a"), value(revived));
    assert.deepEqual(await live(db, "stations", "route_id = 'a'"), [{ n: 1 }]);
    assert.deepEqual(await dead(db, "stations", "route_id = 'a'"), [{ n: 2 }]);
  });

  test("ord follows list order: insert and revive take max(ord) + 1, an update keeps ord", async () => {
    const { db, kv } = await setup();
    const ords = async () => Object.fromEntries(
      (await db.query("SELECT id, ord FROM routes")).map((r) => [r.id, r.ord]));
    for (const id of ["c", "a", "b"]) await kv.put(`route:${id}`, value(route(id)));
    const first = await ords();
    assert.ok(first.c < first.a && first.a < first.b, JSON.stringify(first));
    await kv.put("route:c", value(route("c", [], { name: "Updated" })));
    assert.equal((await ords()).c, first.c);
    await kv.delete("route:c");
    await kv.put("route:c", value(route("c")));
    const after = await ords();
    assert.ok(after.c > after.b, JSON.stringify(after));
    assert.deepEqual(await listed(kv), ["a", "b", "c"]);
  });

  test("deleted routes never appear in list, even interleaved with live ones", async () => {
    const { kv } = await setup();
    for (const id of ["a", "b", "c", "d"]) await kv.put(`route:${id}`, value(route(id)));
    await kv.delete("route:b");
    await kv.delete("route:d");
    assert.deepEqual(await listed(kv), ["a", "c"]);
  });

  test("static/db/route_adapter.js contains no hard-delete SQL statement", () => {
    const src = readFileSync(new URL("./db/route_adapter.js", import.meta.url), "utf8");
    const hardDelete = new RegExp(["\\bdelete", "\\s+", "from\\b"].join(""), "i");
    assert.doesNotMatch(src, hardDelete, "route_adapter.js must soft-delete (UPDATE ... SET deleted_at) only");
  });
});

// Covers: MEM-039
// Requirement: fields the schema does not map, or values of the wrong type, survive a round trip.
describe("sql route adapter: unmapped and malformed fields survive", () => {
  test("an extra route key and an extra station key round-trip", async () => {
    const { kv } = await setup();
    const r = route("r1", [station(1, { mood: { calm: true } })], { note: "rainy", version: 3 });
    await kv.put("route:r1", value(r));
    assert.deepEqual(await kv.get("route:r1"), value(r));
  });

  test("kind 'weird', string box/coords values and n 1.5 round-trip unchanged", async () => {
    const { kv } = await setup();
    const odd = station(1, { n: 1.5, box: { x1: "a", y1: 2, x2: 3, y2: 4 } });
    const r = route("r1", [odd, station(2, { coords: { lat: "51.5", lon: 2 } })], { kind: "weird" });
    await kv.put("route:r1", structuredClone(value(r)));
    const back = await kv.get("route:r1");
    assert.deepEqual(back.route.kind, "weird");
    assert.deepEqual(back.route.stations[0], odd);
    assert.deepEqual(back, value(r));
  });

  test("a profile holding a non-string value round-trips", async () => {
    const { kv } = await setup();
    const r = route("r1", [station(1, { profile: { visual: "door", score: 7 } })]);
    await kv.put("route:r1", value(r));
    assert.deepEqual(await kv.get("route:r1"), value(r));
  });
});

// Covers: MEM-039
// Requirement: photo bytes go to the photo KV, never into SQL; the station row records its photo id.
describe("sql route adapter: photos stay out of SQL", () => {
  test("photo: keys reach photoKv with the same key and value and add no SQL rows", async () => {
    const { db, photos, kv } = await setup();
    const bytes = new Uint8Array([0xff, 0xd8, 0x01, 0xff, 0xd9]);
    await kv.put("photo:p1", { type: "photo", bytes });
    assert.deepEqual(photos.map.get("photo:p1"), { type: "photo", bytes });
    assert.deepEqual(await kv.get("photo:p1"), { type: "photo", bytes });
    assert.deepEqual(await db.query("SELECT (SELECT COUNT(*) FROM routes) AS r, (SELECT COUNT(*) FROM stations) AS s"), [{ r: 0, s: 0 }]);
    await kv.delete("photo:p1");
    assert.equal(photos.map.has("photo:p1"), false);
  });

  test("a stored station's photo_ref is in stations.photo_id", async () => {
    const { db, kv } = await setup();
    await kv.put("route:r1", value(route("r1")));
    assert.deepEqual(await db.query("SELECT photo_id FROM stations WHERE route_id = 'r1' ORDER BY pos"),
      [{ photo_id: "p1" }, { photo_id: "p2" }, { photo_id: "p3" }]);
  });

  test("a key with an unknown prefix throws TypeError", async () => {
    const { kv } = await setup();
    await assert.rejects(async () => kv.put("misc:1", { type: "misc" }), TypeError);
    await assert.rejects(async () => kv.get("misc:1"), TypeError);
    await assert.rejects(async () => kv.delete("misc:1"), TypeError);
  });
});

// Covers: MEM-039
// Requirement: a route write is all-or-nothing: a write that fails part-way leaves the previously
// stored route (or no route, for a new one) exactly as it was.
describe("sql route adapter: failed write leaves the old route intact", () => {
  test("re-putting with a duplicate station id rejects and keeps the old route and stations", async () => {
    const { db, kv } = await setup();
    const old = route("r1");
    await kv.put("route:r1", value(old));
    const broken = route("r1", [station(1), station(1, { name: "dup" })], { name: "Broken" });
    await assert.rejects(async () => kv.put("route:r1", value(broken)));
    assert.deepEqual(await kv.get("route:r1"), value(old));
    assert.deepEqual(await db.query("SELECT COUNT(*) AS n FROM stations WHERE route_id = 'r1'"), [{ n: 3 }]);
  });

  test("a write that fails mid-transaction leaves old stations live at their old positions, no tombstones", async () => {
    const { db, kv } = await setup();
    const old = route("r1");
    await kv.put("route:r1", value(old));
    for (const ev of ["INSERT", "UPDATE"]) {
      await db.exec(`CREATE TRIGGER fail_${ev} BEFORE ${ev} ON stations WHEN NEW.id = 'boom'
        BEGIN SELECT RAISE(ABORT, 'forced failure'); END`);
    }
    const boom = { ...station(9), id: "boom" };
    await assert.rejects(async () => kv.put("route:r1", value(route("r1", [station(1), boom], { name: "X" }))));
    assert.deepEqual(await kv.get("route:r1"), value(old));
    assert.deepEqual(await db.query("SELECT id, pos, deleted_at FROM stations WHERE route_id = 'r1' ORDER BY id"),
      [{ id: "s1", pos: 0, deleted_at: null }, { id: "s2", pos: 1, deleted_at: null }, { id: "s3", pos: 2, deleted_at: null }]);
  });

  test("a new route whose write fails is not stored", async () => {
    const { kv } = await setup();
    await assert.rejects(async () => kv.put("route:r2", value(route("r2", [station(1), station(1)]))));
    assert.equal(await kv.get("route:r2"), undefined);
    assert.deepEqual(await listed(kv), []);
  });
});

// Covers: MEM-039
// Requirement: S2 adds the SQL adapter with no production caller: the app still stores routes in
// IndexedDB until the S4 cutover, so app.js and flow.js do not import db/route_adapter.js.
describe("sql route adapter: not wired into the app yet", () => {
  test("static/app.js and static/flow.js do not import db/route_adapter.js", () => {
    for (const f of ["app.js", "flow.js"]) {
      const src = readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
      assert.doesNotMatch(src, /db\/route_adapter\.js/, `${f} must not import db/route_adapter.js before S4`);
    }
  });
});
