// Covers: MEM-039
// Requirement: node tests exercise the SQLite storage layer against a real in-memory SQLite
// (vendored @sqlite.org/sqlite-wasm node build), not mocks, through the same small db shape the
// browser worker exposes, so schema migrations are proven on the real engine (item 159 S1).
// Contract (RED; GREEN implements in static/db/node_driver.js):
//   openMemoryDb() -> db (or a Promise of it) over sqlite3.oo1.DB(":memory:") loaded from
//     vendor-node/sqlite-wasm/node.mjs. db = {exec(sql, params?), query(sql, params?), transaction(fn)},
//     all synchronous (like oo1 itself) so writes inside a transaction fn land in that transaction.
//     query -> array of plain row objects keyed by column name ([] when no rows; Object prototype,
//     like rows that crossed postMessage, so oo1's null-prototype rows are copied); params bind
//     positionally from an array. exec runs a statement (params optional). Bad SQL throws.
//     transaction(fn) runs fn inside BEGIN/COMMIT and returns fn's return value; when fn throws,
//     every write made inside it is rolled back and the same error is rethrown.
//     Each openMemoryDb() call is an independent database.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

const mod = await import("./db/node_driver.js").catch((err) => ({ __missing: String(err) }));

async function open() {
  assert.ok("openMemoryDb" in mod, `static/db/node_driver.js must export openMemoryDb (${mod.__missing ?? "not exported"})`);
  return await mod.openMemoryDb();
}

// Covers: MEM-039
// Requirement: query/exec run real SQL with positional params and return plain row objects.
describe("node_driver: query + exec", () => {
  test("query returns row objects keyed by column, with positional params", async () => {
    const db = await open();
    assert.deepEqual(await db.query("SELECT ? AS a, ? AS b", [5, "x"]), [{ a: 5, b: "x" }]);
  });

  test("exec with params writes rows that query reads back in order", async () => {
    const db = await open();
    await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
    await db.exec("INSERT INTO t (name) VALUES (?)", ["alpha"]);
    await db.exec("INSERT INTO t (name) VALUES (?)", ["beta"]);
    assert.deepEqual(await db.query("SELECT id, name FROM t ORDER BY id"), [
      { id: 1, name: "alpha" },
      { id: 2, name: "beta" },
    ]);
  });

  test("query on an empty table returns an empty array", async () => {
    const db = await open();
    await db.exec("CREATE TABLE t (a)");
    assert.deepEqual(await db.query("SELECT a FROM t"), []);
  });

  test("a fresh database reports user_version 0", async () => {
    const db = await open();
    assert.deepEqual(await db.query("PRAGMA user_version"), [{ user_version: 0 }]);
  });

  test("bad SQL throws", async () => {
    const db = await open();
    await assert.rejects(async () => db.exec("CREATE TABL nope"));
    await assert.rejects(async () => db.query("SELECT * FROM missing_table"));
  });

  test("two opened databases are independent", async () => {
    const a = await open();
    const b = await open();
    await a.exec("CREATE TABLE only_in_a (x)");
    assert.deepEqual(await b.query("SELECT name FROM sqlite_master WHERE name = 'only_in_a'"), []);
  });
});

// Covers: MEM-039
// Requirement: transaction(fn) is all-or-nothing: commits and returns fn's value on success, and on
// a throw rolls back every write made inside it and rethrows the same error.
describe("node_driver: transaction", () => {
  test("commits writes and returns fn's value", async () => {
    const db = await open();
    db.exec("CREATE TABLE t (a)");
    const out = await db.transaction(() => {
      db.exec("INSERT INTO t VALUES (?)", [1]);
      db.exec("INSERT INTO t VALUES (?)", [2]);
      return "done";
    });
    assert.equal(out, "done");
    assert.deepEqual(await db.query("SELECT a FROM t ORDER BY a"), [{ a: 1 }, { a: 2 }]);
  });

  test("a throw inside fn rolls back its writes and rethrows the same error", async () => {
    const db = await open();
    db.exec("CREATE TABLE t (a)");
    db.exec("INSERT INTO t VALUES (?)", [0]);
    const boom = new Error("boom");
    await assert.rejects(
      async () =>
        db.transaction(() => {
          db.exec("INSERT INTO t VALUES (?)", [1]);
          db.exec("CREATE TABLE created_inside (x)");
          throw boom;
        }),
      (err) => err === boom,
    );
    assert.deepEqual(await db.query("SELECT a FROM t"), [{ a: 0 }]);
    assert.deepEqual(await db.query("SELECT name FROM sqlite_master WHERE name = 'created_inside'"), []);
  });

  test("the database stays usable after a rolled-back transaction", async () => {
    const db = await open();
    db.exec("CREATE TABLE t (a)");
    await assert.rejects(async () =>
      db.transaction(() => {
        db.exec("INSERT INTO t VALUES (1)");
        throw new Error("x");
      }),
    );
    await db.transaction(() => db.exec("INSERT INTO t VALUES (2)"));
    assert.deepEqual(await db.query("SELECT a FROM t"), [{ a: 2 }]);
  });
});
