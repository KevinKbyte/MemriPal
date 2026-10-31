// Covers: MEM-039
// Requirement: the on-device SQLite database gets a routes + stations schema on first load (item 159
// S2). Migration 1 (user_version 0 -> 1) creates the routes and stations tables plus the
// stations_photo index; re-running is a no-op; a database from a newer app is refused. Each station
// belongs to one route by id, keyed by (route_id, id) so imported routes keep their station ids, and
// holds a unique position (route_id, pos). Photo bytes never live in SQL: no BLOB column.
// Soft delete (plan AMENDMENT): routes and stations carry deleted_at TEXT (NULL = live), routes carry
// ord (list order), and stations.pos is nullable so removed stations stay as tombstones with pos NULL.
// The browser worker runs the same migrations over its raw oo1 database through wrapOo1.
// Contract (RED; GREEN implements):
//   static/db/schema.js exports MIGRATIONS (array; MIGRATIONS[0] creates routes/stations), for
//     runMigrations (static/db/migrations.js).
//   static/db/oo1.js exports wrapOo1(rawOo1Db) -> sync {exec, query, transaction(fn)} (moved from
//     node_driver.js, which keeps using it).
// Real in-memory SQLite (vendor-node build), not mocks.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import sqlite3InitModule from "../vendor-node/sqlite-wasm/node.mjs";
import { openMemoryDb } from "./db/node_driver.js";
import { runMigrations, DbNewerError } from "./db/migrations.js";

const schema = await import("./db/schema.js").catch((err) => ({ __missing: String(err) }));
const oo1 = await import("./db/oo1.js").catch((err) => ({ __missing: String(err) }));

function migrations() {
  assert.ok("MIGRATIONS" in schema, `static/db/schema.js must export MIGRATIONS (${schema.__missing ?? "not exported"})`);
  assert.ok(Array.isArray(schema.MIGRATIONS) && schema.MIGRATIONS.length >= 1, "MIGRATIONS must be a non-empty array");
  return schema.MIGRATIONS;
}

async function migrated() {
  const db = await openMemoryDb();
  await runMigrations(db, migrations());
  return db;
}

async function version(db) {
  return (await db.query("PRAGMA user_version"))[0].user_version;
}

async function objects(db) {
  const rows = await db.query("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name");
  return rows.map((r) => `${r.type}:${r.name}`);
}

async function columns(db, table) {
  return await db.query(`SELECT name, type FROM pragma_table_info('${table}')`);
}

const insertRoute = (db, id) => db.exec("INSERT INTO routes (id) VALUES (?)", [id]);
const insertStation = (db, routeId, id, pos) =>
  db.exec("INSERT INTO stations (route_id, id, pos) VALUES (?, ?, ?)", [routeId, id, pos]);

// Covers: MEM-039
// Requirement: migration 1 takes a fresh database to user_version 1 with routes, stations and the
// stations_photo index; running the migrations again changes nothing.
describe("db schema: migration 1 creates routes + stations", () => {
  test("fresh db: the first migration alone ends at user_version 1", async () => {
    const db = await openMemoryDb();
    await runMigrations(db, migrations().slice(0, 1));
    assert.equal(await version(db), 1);
  });

  test("fresh db: all MIGRATIONS end at user_version = MIGRATIONS.length", async () => {
    const db = await migrated();
    assert.equal(await version(db), migrations().length);
  });

  test("sqlite_master lists the routes and stations tables and the stations_photo index", async () => {
    const db = await migrated();
    const names = await objects(db);
    for (const want of ["table:routes", "table:stations", "index:stations_photo"]) {
      assert.ok(names.includes(want), `${want} missing from ${JSON.stringify(names)}`);
    }
  });

  test("routes and stations carry the planned columns", async () => {
    const db = await migrated();
    const routeCols = (await columns(db, "routes")).map((c) => c.name);
    for (const c of ["seq", "id", "name", "kind", "status", "created_at", "lists_json", "raw_json", "deleted_at", "ord"]) {
      assert.ok(routeCols.includes(c), `routes.${c} missing (${routeCols})`);
    }
    const stationCols = (await columns(db, "stations")).map((c) => c.name);
    const wanted = ["route_id", "id", "pos", "n", "name", "photo_id", "status", "box_x1", "box_y1", "box_x2", "box_y2",
      "lat", "lon", "profile_json", "taps_json", "raw_json", "deleted_at"];
    for (const c of wanted) assert.ok(stationCols.includes(c), `stations.${c} missing (${stationCols})`);
  });

  test("deleted_at is a TEXT column in routes and stations", async () => {
    const db = await migrated();
    for (const table of ["routes", "stations"]) {
      const col = (await columns(db, table)).find((c) => c.name === "deleted_at");
      assert.ok(col, `${table}.deleted_at missing`);
      assert.equal(col.type.toUpperCase(), "TEXT", `${table}.deleted_at must be TEXT`);
    }
  });

  test("no column in routes or stations is a BLOB (photo bytes stay out of SQL)", async () => {
    const db = await migrated();
    for (const table of ["routes", "stations"]) {
      const blobs = (await columns(db, table)).filter((c) => /blob/i.test(c.type) || c.type === "");
      assert.deepEqual(blobs, [], `${table} has untyped/BLOB columns`);
    }
  });

  test("re-running MIGRATIONS on a migrated db is a no-op", async () => {
    const db = await migrated();
    const before = await objects(db);
    await runMigrations(db, migrations());
    assert.equal(await version(db), migrations().length);
    assert.deepEqual(await objects(db), before);
  });

  test("a db at a newer user_version is refused with DbNewerError and left untouched", async () => {
    const db = await openMemoryDb();
    const newer = migrations().length + 1;
    await db.exec(`PRAGMA user_version = ${newer}`);
    await assert.rejects(async () => runMigrations(db, migrations()), (err) => err instanceof DbNewerError);
    assert.equal(await version(db), newer);
    assert.deepEqual(await objects(db), []);
  });
});

// Covers: MEM-039
// Requirement: the schema keeps station identity and order sound: a route id is unique, a station id
// is unique within its route (the same id may appear in another route), and two stations of one
// route can never share a position; removed stations stay as tombstones with no position.
describe("db schema: keys and constraints", () => {
  test("a duplicate (route_id, pos) is rejected", async () => {
    const db = await migrated();
    await insertRoute(db, "r1");
    await insertStation(db, "r1", "s1", 0);
    await assert.rejects(async () => insertStation(db, "r1", "s2", 0));
    assert.deepEqual(await db.query("SELECT id FROM stations"), [{ id: "s1" }]);
  });

  test("several tombstoned stations (pos NULL) in one route are all kept", async () => {
    const db = await migrated();
    await insertRoute(db, "r1");
    await insertStation(db, "r1", "s1", 0);
    await insertStation(db, "r1", "s2", null);
    await insertStation(db, "r1", "s3", null);
    assert.deepEqual(await db.query("SELECT id, pos FROM stations ORDER BY id"),
      [{ id: "s1", pos: 0 }, { id: "s2", pos: null }, { id: "s3", pos: null }]);
  });

  test("a row inserted without deleted_at is live (deleted_at NULL)", async () => {
    const db = await migrated();
    await insertRoute(db, "r1");
    await insertStation(db, "r1", "s1", 0);
    assert.deepEqual(await db.query("SELECT deleted_at FROM routes"), [{ deleted_at: null }]);
    assert.deepEqual(await db.query("SELECT deleted_at FROM stations"), [{ deleted_at: null }]);
  });

  test("a duplicate (route_id, id) is rejected", async () => {
    const db = await migrated();
    await insertRoute(db, "r1");
    await insertStation(db, "r1", "s1", 0);
    await assert.rejects(async () => insertStation(db, "r1", "s1", 1));
  });

  test("the same station id and pos in two different routes are both kept", async () => {
    const db = await migrated();
    await insertRoute(db, "r1");
    await insertRoute(db, "r2");
    await insertStation(db, "r1", "s1", 0);
    await insertStation(db, "r2", "s1", 0);
    assert.deepEqual(await db.query("SELECT route_id FROM stations ORDER BY route_id"), [{ route_id: "r1" }, { route_id: "r2" }]);
  });

  test("a duplicate route id is rejected", async () => {
    const db = await migrated();
    await insertRoute(db, "r1");
    await assert.rejects(async () => insertRoute(db, "r1"));
  });

  test("raw_json defaults to '{}' when a row is inserted without it", async () => {
    const db = await migrated();
    await insertRoute(db, "r1");
    await insertStation(db, "r1", "s1", 0);
    assert.deepEqual(await db.query("SELECT raw_json FROM routes"), [{ raw_json: "{}" }]);
    assert.deepEqual(await db.query("SELECT raw_json FROM stations"), [{ raw_json: "{}" }]);
  });
});

// Covers: MEM-039
// Requirement: the browser worker migrates its raw oo1 database on open; wrapOo1 (static/db/oo1.js)
// gives runMigrations the sync db shape it needs over a raw sqlite3.oo1.DB.
describe("db schema: worker path (runMigrations over wrapOo1)", () => {
  test("runMigrations(wrapOo1(raw oo1 DB), MIGRATIONS) ends at user_version 1+ with routes and stations", async () => {
    assert.ok("wrapOo1" in oo1, `static/db/oo1.js must export wrapOo1 (${oo1.__missing ?? "not exported"})`);
    const sqlite3 = await sqlite3InitModule();
    const raw = new sqlite3.oo1.DB(":memory:");
    try {
      const db = oo1.wrapOo1(raw);
      await runMigrations(db, migrations());
      assert.equal(await version(db), migrations().length);
      const names = await objects(db);
      assert.ok(names.includes("table:routes") && names.includes("table:stations"), JSON.stringify(names));
    } finally {
      raw.close();
    }
  });
});
