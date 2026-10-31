// Covers: MEM-039
// Requirement: the on-device SQLite schema upgrades itself safely on every app load. Pending
// migrations are applied in order, each in its own transaction that also bumps PRAGMA user_version,
// so a failing migration never leaves a half-applied schema or a version that lies; a database
// written by a newer app version is refused untouched instead of being corrupted (item 159 S1).
// Contract (RED; GREEN implements in static/db/migrations.js):
//   runMigrations(db, migrations) (returns a Promise; awaited here). db = {exec, query, transaction}
//   (static/db/node_driver.js openMemoryDb() shape; in the app, the worker's synchronous oo1 db).
//   migrations[i] is a SQL string or a SYNC-only function (db) => void; it brings user_version
//   i -> i+1. Reads PRAGMA user_version first.
//   - a function step that returns a thenable (async step) is refused: runMigrations throws an
//     Error naming the sync-only rule (message matches /sync/i), that step's writes and bump roll
//     back, user_version stays at the last good value and later migrations do not run;
//   - each pending migration runs in its own db.transaction together with the user_version bump;
//   - a failing migration rolls back (its writes and its bump) and the error propagates;
//     user_version stays at the last good value and later migrations do not run;
//   - user_version > migrations.length -> throws the exported DbNewerError (name "DbNewerError")
//     without running anything or changing user_version;
//   - user_version == migrations.length (incl. empty list on a fresh db) -> no-op.
// Real in-memory SQLite (vendor-node build), not mocks.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

const mig = await import("./db/migrations.js").catch((err) => ({ __missing: String(err) }));
const drv = await import("./db/node_driver.js").catch((err) => ({ __missing: String(err) }));

function run() {
  assert.ok("runMigrations" in mig, `static/db/migrations.js must export runMigrations (${mig.__missing ?? "not exported"})`);
  return mig.runMigrations;
}

function newerError() {
  assert.ok("DbNewerError" in mig, `static/db/migrations.js must export DbNewerError (${mig.__missing ?? "not exported"})`);
  return mig.DbNewerError;
}

async function open() {
  assert.ok("openMemoryDb" in drv, `static/db/node_driver.js must export openMemoryDb (${drv.__missing ?? "not exported"})`);
  return await drv.openMemoryDb();
}

async function version(db) {
  const rows = await db.query("PRAGMA user_version");
  return rows[0].user_version;
}

async function tables(db) {
  const rows = await db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
  return rows.map((r) => r.name);
}

const THREE = [
  "CREATE TABLE a (id INTEGER PRIMARY KEY)",
  "CREATE TABLE b (id INTEGER PRIMARY KEY)",
  "CREATE TABLE c (id INTEGER PRIMARY KEY)",
];

// Covers: MEM-039
// Requirement: a fresh database gets every migration in order and ends at user_version = count.
describe("runMigrations: applying pending migrations", () => {
  test("fresh db: all SQL migrations applied, user_version = migrations.length", async () => {
    const db = await open();
    await run()(db, THREE);
    assert.equal(await version(db), 3);
    assert.deepEqual(await tables(db), ["a", "b", "c"]);
  });

  test("function migrations receive the db and run in index order", async () => {
    const db = await open();
    await run()(db, [
      (d) => d.exec("CREATE TABLE log (step INTEGER)"),
      (d) => d.exec("INSERT INTO log VALUES (?)", [1]),
      (d) => d.exec("INSERT INTO log VALUES (?)", [2]),
    ]);
    assert.equal(await version(db), 3);
    assert.deepEqual(await db.query("SELECT step FROM log ORDER BY rowid"), [{ step: 1 }, { step: 2 }]);
  });

  test("partially migrated db: only migrations from user_version onward run", async () => {
    const db = await open();
    await db.exec("CREATE TABLE a (id INTEGER PRIMARY KEY)");
    await db.exec("PRAGMA user_version = 1");
    // THREE[0] would fail (table a exists) if it were re-run.
    await run()(db, THREE);
    assert.equal(await version(db), 3);
    assert.deepEqual(await tables(db), ["a", "b", "c"]);
  });

  test("a later migration sees data written by an earlier one", async () => {
    const db = await open();
    await run()(db, [
      "CREATE TABLE routes (id TEXT PRIMARY KEY, name TEXT)",
      "INSERT INTO routes VALUES ('r1', 'Home')",
      "ALTER TABLE routes ADD COLUMN created INTEGER DEFAULT 0",
    ]);
    assert.deepEqual(await db.query("SELECT id, name, created FROM routes"), [{ id: "r1", name: "Home", created: 0 }]);
  });
});

// Covers: MEM-039
// Requirement: running migrations again on an up-to-date database changes nothing.
describe("runMigrations: no-op cases", () => {
  test("empty migrations list on a fresh db: user_version stays 0, no tables", async () => {
    const db = await open();
    await run()(db, []);
    assert.equal(await version(db), 0);
    assert.deepEqual(await tables(db), []);
  });

  test("user_version already current: nothing re-runs", async () => {
    const db = await open();
    const ran = [];
    const migrations = [() => ran.push(0), () => ran.push(1)];
    await db.exec("PRAGMA user_version = 2");
    await run()(db, migrations);
    assert.deepEqual(ran, []);
    assert.equal(await version(db), 2);
  });

  test("idempotent re-run: the second run is a no-op (non-idempotent SQL would fail)", async () => {
    const db = await open();
    await run()(db, THREE);
    await run()(db, THREE);
    assert.equal(await version(db), 3);
    assert.deepEqual(await tables(db), ["a", "b", "c"]);
  });
});

// Covers: MEM-039
// Requirement: a failing migration rolls back completely; the version records the last good step.
describe("runMigrations: mid-list failure", () => {
  test("failing SQL migration: error propagates, earlier ones kept, its writes and later ones absent", async () => {
    const db = await open();
    await assert.rejects(async () =>
      run()(db, [
        "CREATE TABLE a (id INTEGER PRIMARY KEY)",
        "CREATE TABLE b (id INTEGER PRIMARY KEY); CREATE TABL broken (x)",
        "CREATE TABLE c (id INTEGER PRIMARY KEY)",
      ]),
    );
    assert.equal(await version(db), 1);
    assert.deepEqual(await tables(db), ["a"]);
  });

  test("throwing function migration: its writes are rolled back and the same error propagates", async () => {
    const db = await open();
    const boom = new Error("migration 1 failed");
    await assert.rejects(
      async () =>
        run()(db, [
          "CREATE TABLE a (v INTEGER)",
          (d) => {
            d.exec("INSERT INTO a VALUES (?)", [42]);
            d.exec("CREATE TABLE half (x)");
            throw boom;
          },
        ]),
      (err) => err === boom,
    );
    assert.equal(await version(db), 1);
    assert.deepEqual(await db.query("SELECT v FROM a"), []);
    assert.deepEqual(await tables(db), ["a"]);
  });

  test("for every failing index k, user_version ends at k and only migrations < k are applied", async () => {
    const n = 4;
    for (let k = 0; k < n; k++) {
      const db = await open();
      const migrations = Array.from({ length: n }, (_, i) =>
        i === k ? `CREATE TABLE t${i} (x); SELECT * FROM no_such_table_${i}` : `CREATE TABLE t${i} (x)`,
      );
      await assert.rejects(async () => run()(db, migrations), Error, `k=${k} must reject`);
      assert.equal(await version(db), k, `k=${k}`);
      assert.deepEqual(await tables(db), Array.from({ length: k }, (_, i) => `t${i}`), `k=${k}`);
    }
  });

  test("after fixing the failing migration, a re-run resumes from the last good version", async () => {
    const db = await open();
    await assert.rejects(async () => run()(db, ["CREATE TABLE a (x)", "CREATE TABL b (x)"]));
    await run()(db, ["CREATE TABLE a (x)", "CREATE TABLE b (x)"]);
    assert.equal(await version(db), 2);
    assert.deepEqual(await tables(db), ["a", "b"]);
  });
});

// Covers: MEM-039
// Requirement: a database from a newer app version is refused with DbNewerError and left untouched.
describe("runMigrations: database newer than the app", () => {
  test("user_version > migrations.length throws DbNewerError and touches nothing", async () => {
    const DbNewerError = newerError();
    const db = await open();
    await db.exec("PRAGMA user_version = 3");
    const ran = [];
    await assert.rejects(
      async () => run()(db, [() => ran.push(0), () => ran.push(1)]),
      (err) => err instanceof DbNewerError && err.name === "DbNewerError",
    );
    assert.deepEqual(ran, []);
    assert.equal(await version(db), 3);
    assert.deepEqual(await tables(db), []);
  });

  test("DbNewerError is an Error subclass", () => {
    const DbNewerError = newerError();
    assert.ok(new DbNewerError("x") instanceof Error);
  });

  test("an empty migrations list on a db at user_version 1 is also refused", async () => {
    const DbNewerError = newerError();
    const db = await open();
    await db.exec("PRAGMA user_version = 1");
    await assert.rejects(async () => run()(db, []), (err) => err instanceof DbNewerError);
    assert.equal(await version(db), 1);
  });
});

// Covers: MEM-039
// Requirement: migrations are synchronous only (they run inside the SQLite worker's single
// transaction); an async migration step is refused with a clear error and rolled back so its work
// can never land outside the transaction or after the version bump.
describe("runMigrations: async steps are refused", () => {
  async function expectRefused(step) {
    const db = await open();
    await assert.rejects(
      async () => run()(db, ["CREATE TABLE a (id INTEGER PRIMARY KEY)", step, "CREATE TABLE c (x)"]),
      (err) => err instanceof Error && /sync/i.test(err.message),
    );
    assert.equal(await version(db), 1, "user_version must stay at the last good step");
    assert.deepEqual(await tables(db), ["a"], "the async step's writes and later steps must be absent");
  }

  test("an async function step throws a sync-only error and its writes roll back", async () => {
    await expectRefused(async (d) => {
      d.exec("CREATE TABLE half (x)");
    });
  });

  test("a function step returning Promise.resolve() is refused the same way", async () => {
    await expectRefused((d) => {
      d.exec("CREATE TABLE half (x)");
      return Promise.resolve();
    });
  });

  test("a function step returning a bare thenable is refused the same way", async () => {
    await expectRefused((d) => {
      d.exec("CREATE TABLE half (x)");
      return {
        then(resolve) {
          resolve();
        },
      };
    });
  });

  test("an async step as the very first migration leaves a fresh db at user_version 0", async () => {
    const db = await open();
    await assert.rejects(
      async () => run()(db, [async (d) => d.exec("CREATE TABLE half (x)")]),
      (err) => err instanceof Error && /sync/i.test(err.message),
    );
    assert.equal(await version(db), 0);
    assert.deepEqual(await tables(db), []);
  });
});
