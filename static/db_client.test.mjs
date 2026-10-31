// Covers: MEM-039
// Requirement: only one MemriPal tab owns the on-device SQLite database at a time. The page asks for
// the "memripal-db" Web Lock without waiting; if another tab holds it the page learns it is locked
// and never starts a database worker, otherwise it starts the worker, keeps the lock for the page's
// lifetime and talks to the database through an async request/response channel (item 159 S1).
// Contract (RED; GREEN implements in static/db/client.js):
//   openDb({ locks, createWorker }) -> Promise; deps injected, no globals.
//     locks.request("memripal-db", { ifAvailable: true, ... }, cb) (Web Locks API shape: cb gets
//     the lock or null; the lock is held until cb's returned promise settles).
//     lock null -> resolves { status: "locked" }; createWorker is never called.
//     lock granted -> createWorker() once -> resolves { status: "ready", db }; cb's promise never
//     settles (lock held for the page lifetime).
//   db = { exec(sql, params?), query(sql, params?), transaction(stmts) }, all returning Promises.
//     exec/query post { id, op: "exec" | "query", sql, params } to the worker; the worker answers
//     { id, ok: true, rows } (query resolves to rows) or { id, ok: false, error } (rejects with an
//     Error whose message is `error`). Ids are unique per request; replies match by id, any order.
//     transaction(stmts), stmts = [{ sql, params }], posts { id, op: "transaction", stmts } and the
//     worker runs them in one SQLite transaction (a JS callback cannot cross postMessage).
//     A worker "error" event rejects every pending request with an Error carrying its message.
//   Worker events are read via onmessage/onerror or addEventListener; the fake supports both.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { deferred, settle } from "./fake_dom_test.mjs";

const mod = await import("./db/client.js").catch((err) => ({ __missing: String(err) }));

function openDb() {
  assert.ok("openDb" in mod, `static/db/client.js must export openDb (${mod.__missing ?? "not exported"})`);
  return mod.openDb;
}

/** Web Locks stand-in. grant: true -> lock object, false -> null, or a deferred to grant later. */
function fakeLocks(grant) {
  const requests = [];
  return {
    requests,
    request(name, opts, cb) {
      const entry = { name, opts, settled: false };
      requests.push(entry);
      const decide = grant && typeof grant === "object" && "promise" in grant ? grant.promise : Promise.resolve(grant);
      const held = decide.then((ok) => cb(ok ? { name, mode: "exclusive" } : null));
      held.then(
        () => (entry.settled = true),
        () => (entry.settled = true),
      );
      return held;
    },
  };
}

class FakeWorker {
  constructor() {
    this.sent = [];
    this.listeners = new Map();
    this.onmessage = null;
    this.onerror = null;
  }
  postMessage(msg) {
    this.sent.push(structuredClone(msg));
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this.listeners.get(type) ?? [];
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }
  terminate() {}
  emit(type, ev) {
    const handler = this["on" + type];
    if (typeof handler === "function") handler.call(this, ev);
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn.call(this, ev);
  }
  reply(data) {
    this.emit("message", { data });
  }
}

function workerFactory() {
  const created = [];
  const createWorker = (...args) => {
    const w = new FakeWorker();
    created.push({ w, args });
    return w;
  };
  return { created, createWorker };
}

async function ready() {
  const locks = fakeLocks(true);
  const { created, createWorker } = workerFactory();
  const out = await openDb()({ locks, createWorker });
  assert.equal(out.status, "ready");
  return { locks, created, worker: created[0].w, db: out.db };
}

// Covers: MEM-039
// Requirement: the page takes the "memripal-db" lock without queueing; a second tab is told it is
// locked and starts no worker.
describe("openDb: single-tab lock", () => {
  test("requests the memripal-db lock with ifAvailable: true", async () => {
    const locks = fakeLocks(true);
    const { createWorker } = workerFactory();
    await openDb()({ locks, createWorker });
    assert.equal(locks.requests.length, 1);
    assert.equal(locks.requests[0].name, "memripal-db");
    assert.equal(locks.requests[0].opts?.ifAvailable, true);
  });

  test("lock denied -> { status: 'locked' } and no worker is created", async () => {
    const locks = fakeLocks(false);
    const { created, createWorker } = workerFactory();
    const out = await openDb()({ locks, createWorker });
    assert.equal(out.status, "locked");
    assert.equal(out.db, undefined);
    await settle();
    assert.equal(created.length, 0);
  });

  test("no worker is created before the lock is granted", async () => {
    const gate = deferred();
    const locks = fakeLocks(gate);
    const { created, createWorker } = workerFactory();
    let resolved = false;
    const pending = openDb()({ locks, createWorker }).then((v) => ((resolved = true), v));
    await settle();
    assert.equal(created.length, 0);
    assert.equal(resolved, false);
    gate.resolve(true);
    const out = await pending;
    assert.equal(out.status, "ready");
    assert.equal(created.length, 1);
  });

  test("lock granted -> one worker and { status: 'ready', db } with exec/query/transaction", async () => {
    const { created, db } = await ready();
    assert.equal(created.length, 1);
    for (const fn of ["exec", "query", "transaction"]) assert.equal(typeof db[fn], "function", fn);
  });

  test("the lock stays held after ready and after database calls (page lifetime)", async () => {
    const { locks, worker, db } = await ready();
    const p = db.query("SELECT 1 AS one");
    await settle();
    worker.reply({ id: worker.sent[0].id, ok: true, rows: [{ one: 1 }] });
    await p;
    await settle();
    assert.equal(locks.requests[0].settled, false, "lock callback promise must never settle");
  });
});

// Covers: MEM-039
// Requirement: database calls are proxied to the worker as {id, op, sql, params} and resolve or
// reject from the matching {id, ok, rows|error} reply.
describe("openDb: worker RPC", () => {
  test("query posts { id, op: 'query', sql, params } and resolves to the reply rows", async () => {
    const { worker, db } = await ready();
    const p = db.query("SELECT * FROM routes WHERE id = ?", ["r1"]);
    await settle();
    assert.equal(worker.sent.length, 1);
    const msg = worker.sent[0];
    assert.equal(msg.op, "query");
    assert.equal(msg.sql, "SELECT * FROM routes WHERE id = ?");
    assert.deepEqual(msg.params, ["r1"]);
    assert.notEqual(msg.id, undefined);
    worker.reply({ id: msg.id, ok: true, rows: [{ id: "r1", name: "Home" }] });
    assert.deepEqual(await p, [{ id: "r1", name: "Home" }]);
  });

  test("exec posts op 'exec' with sql and params and resolves on ok", async () => {
    const { worker, db } = await ready();
    const p = db.exec("INSERT INTO routes (id) VALUES (?)", ["r2"]);
    await settle();
    const msg = worker.sent[0];
    assert.equal(msg.op, "exec");
    assert.equal(msg.sql, "INSERT INTO routes (id) VALUES (?)");
    assert.deepEqual(msg.params, ["r2"]);
    worker.reply({ id: msg.id, ok: true, rows: [] });
    await p;
  });

  test("transaction posts op 'transaction' with the statement list and resolves on ok", async () => {
    const { worker, db } = await ready();
    const stmts = [
      { sql: "INSERT INTO routes (id) VALUES (?)", params: ["a"] },
      { sql: "INSERT INTO routes (id) VALUES (?)", params: ["b"] },
    ];
    const p = db.transaction(stmts);
    await settle();
    const msg = worker.sent[0];
    assert.equal(msg.op, "transaction");
    assert.deepEqual(msg.stmts, stmts);
    worker.reply({ id: msg.id, ok: true, rows: [] });
    await p;
  });

  test("an { ok: false, error } reply rejects with that error message", async () => {
    const { worker, db } = await ready();
    const p = db.query("SELECT * FROM nope");
    await settle();
    worker.reply({ id: worker.sent[0].id, ok: false, error: "no such table: nope" });
    await assert.rejects(p, (err) => err instanceof Error && err.message === "no such table: nope");
  });

  test("a failed transaction rejects with the worker's error message", async () => {
    const { worker, db } = await ready();
    const p = db.transaction([{ sql: "INSERT INTO t VALUES (1)", params: [] }]);
    await settle();
    worker.reply({ id: worker.sent[0].id, ok: false, error: "UNIQUE constraint failed: t.a" });
    await assert.rejects(p, (err) => err instanceof Error && err.message === "UNIQUE constraint failed: t.a");
  });

  test("concurrent requests get unique ids and out-of-order replies reach the right caller", async () => {
    const { worker, db } = await ready();
    const p1 = db.query("SELECT 1 AS n");
    const p2 = db.query("SELECT 2 AS n");
    const p3 = db.exec("UPDATE t SET a = 1 WHERE 0");
    await settle();
    assert.equal(worker.sent.length, 3);
    const ids = worker.sent.map((m) => m.id);
    assert.equal(new Set(ids).size, 3, "ids must be unique");
    const bySql = Object.fromEntries(worker.sent.map((m) => [m.sql, m.id]));
    worker.reply({ id: bySql["SELECT 2 AS n"], ok: true, rows: [{ n: 2 }] });
    worker.reply({ id: bySql["UPDATE t SET a = 1 WHERE 0"], ok: false, error: "readonly" });
    worker.reply({ id: bySql["SELECT 1 AS n"], ok: true, rows: [{ n: 1 }] });
    assert.deepEqual(await p1, [{ n: 1 }]);
    assert.deepEqual(await p2, [{ n: 2 }]);
    await assert.rejects(p3, (err) => err.message === "readonly");
  });

  test("a reply with an unknown id is ignored and does not settle pending calls", async () => {
    const { worker, db } = await ready();
    let settled = false;
    const p = db.query("SELECT 1 AS n").finally(() => (settled = true));
    await settle();
    const realId = worker.sent[0].id;
    worker.reply({ id: `${realId}-other`, ok: true, rows: [{ n: 99 }] });
    await settle();
    assert.equal(settled, false);
    worker.reply({ id: realId, ok: true, rows: [{ n: 1 }] });
    assert.deepEqual(await p, [{ n: 1 }]);
  });

  test("a worker error event rejects pending requests with its message", async () => {
    const { worker, db } = await ready();
    const p1 = db.query("SELECT 1");
    const p2 = db.exec("SELECT 2");
    await settle();
    worker.emit("error", { message: "wasm compile failed", preventDefault() {} });
    await assert.rejects(p1, (err) => err instanceof Error && err.message.includes("wasm compile failed"));
    await assert.rejects(p2, (err) => err instanceof Error && err.message.includes("wasm compile failed"));
  });
});
