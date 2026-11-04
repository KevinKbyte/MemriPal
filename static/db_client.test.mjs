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
//     If worker.postMessage throws (e.g. DataCloneError) the call's Promise rejects with that error
//     (no synchronous throw) and later calls are unaffected. A worker "messageerror" event (a reply
//     that could not be deserialized) rejects every pending request instead of leaving it hanging.
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
    this.postError = null;
  }
  postMessage(msg) {
    if (this.postError) {
      const err = this.postError;
      this.postError = null;
      throw err;
    }
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

/** Settles p within ms or reports "hung"; the timer is always cleared so the test never leaks it. */
async function within(p, ms = 250) {
  let timer;
  const hung = new Promise((resolve) => {
    timer = setTimeout(() => resolve("hung"), ms);
  });
  try {
    return await Promise.race([p.then((v) => ({ resolved: v }), (err) => ({ rejected: err })), hung]);
  } finally {
    clearTimeout(timer);
  }
}

// Covers: MEM-039
// Requirement: a request the page cannot even send to the worker (e.g. un-cloneable params) fails
// that one call cleanly and leaves the channel usable for every later call.
describe("openDb: postMessage failure", () => {
  for (const op of ["exec", "query", "transaction"]) {
    test(`${op}: a throwing postMessage rejects the returned promise with that error`, async () => {
      const { worker, db } = await ready();
      const cloneErr = new DOMException("could not be cloned", "DataCloneError");
      worker.postError = cloneErr;
      let p;
      assert.doesNotThrow(() => {
        p = op === "transaction" ? db.transaction([{ sql: "SELECT 1", params: [] }]) : db[op]("SELECT 1", []);
      }, "the failure must surface as a rejection, not a synchronous throw");
      await assert.rejects(p, (err) => err === cloneErr);
    });
  }

  test("after a failed send, the next call is sent and resolves from its own reply", async () => {
    const { worker, db } = await ready();
    worker.postError = new DOMException("could not be cloned", "DataCloneError");
    await assert.rejects(db.query("SELECT ?", [() => {}]));
    const p = db.query("SELECT 2 AS n");
    await settle();
    assert.equal(worker.sent.length, 1);
    worker.reply({ id: worker.sent[0].id, ok: true, rows: [{ n: 2 }] });
    assert.deepEqual(await within(p), { resolved: [{ n: 2 }] });
  });

  test("after a failed send, a worker error event still rejects the live request", async () => {
    const { worker, db } = await ready();
    worker.postError = new DOMException("could not be cloned", "DataCloneError");
    await assert.rejects(db.exec("SELECT 1"));
    const live = db.query("SELECT 3 AS n");
    await settle();
    worker.emit("error", { message: "boom", preventDefault() {} });
    const out = await within(live);
    assert.ok(out.rejected instanceof Error && out.rejected.message.includes("boom"));
  });
});

// Covers: MEM-039
// Requirement: if the worker's reply cannot be deserialized (messageerror), every in-flight
// database call fails instead of hanging forever.
describe("openDb: worker messageerror", () => {
  test("a messageerror event rejects every in-flight request", async () => {
    const { worker, db } = await ready();
    const p1 = db.query("SELECT 1");
    const p2 = db.exec("SELECT 2");
    const p3 = db.transaction([{ sql: "SELECT 3", params: [] }]);
    await settle();
    worker.emit("messageerror", { data: undefined });
    for (const [name, p] of [
      ["query", p1],
      ["exec", p2],
      ["transaction", p3],
    ]) {
      const out = await within(p);
      assert.notEqual(out, "hung", `${name} must not hang after messageerror`);
      assert.ok(out.rejected instanceof Error, `${name} must reject with an Error`);
    }
  });

  test("a call made after the messageerror is still answered normally", async () => {
    const { worker, db } = await ready();
    const before = db.query("SELECT 1");
    await settle();
    worker.emit("messageerror", { data: undefined });
    await within(before);
    const after = db.query("SELECT 4 AS n");
    await settle();
    const msg = worker.sent.at(-1);
    worker.reply({ id: msg.id, ok: true, rows: [{ n: 4 }] });
    assert.deepEqual(await within(after), { resolved: [{ n: 4 }] });
  });
});

// Covers: MEM-099
// Requirement: every MemriPal module on a page (the Pal bubble now, MEM-088 later) shares one database
// open, so a page never asks for the "memripal-db" lock or starts a worker twice. A failed open is not
// remembered, so a later caller retries.
// Contract (RED; GREEN implements in static/db/client.js):
//   createSharedOpen(open) -> sharedOpen(deps); open has openDb's shape and is injected so calls can be counted.
//     The first call runs open(deps) and returns its promise; later calls return that same promise and do not
//     call open again (their deps are ignored), including calls made while the first is still pending.
//     A rejected open is dropped: the next call runs open(deps) again.
//     A resolved non-"ready" status ("locked": another tab owns the db) is also dropped once it settles, so a
//     later caller retries (the other tab may have closed); a "ready" result stays cached for the page lifetime.
//   sharedOpenDb = createSharedOpen(openDb): the page-wide instance.
function createSharedOpen() {
  assert.equal(typeof mod.createSharedOpen, "function", `static/db/client.js must export createSharedOpen (${mod.__missing ?? "not exported"})`);
  return mod.createSharedOpen;
}

function countingOpen(results) {
  const calls = [];
  const open = (deps) => {
    calls.push(deps);
    const next = results[Math.min(calls.length - 1, results.length - 1)];
    return typeof next === "function" ? next() : next;
  };
  return { calls, open };
}

describe("createSharedOpen: one open per page", () => {
  test("two calls return the same promise and invoke open once", async () => {
    const { calls, open } = countingOpen([Promise.resolve({ status: "ready", db: {} })]);
    const shared = createSharedOpen()(open);
    const a = shared({ locks: "L1" });
    const b = shared({ locks: "L2" });
    assert.equal(a, b);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { locks: "L1" });
    assert.equal((await a).status, "ready");
  });

  test("a ready result stays cached after it settles", async () => {
    const { calls, open } = countingOpen([Promise.resolve({ status: "ready", db: {} })]);
    const shared = createSharedOpen()(open);
    const a = shared({});
    await a;
    await settle();
    assert.equal(shared({}), a);
    assert.equal(calls.length, 1);
  });

  test("calls made while the open is pending share it", async () => {
    const gate = deferred();
    const { calls, open } = countingOpen([gate.promise]);
    const shared = createSharedOpen()(open);
    const a = shared({});
    const b = shared({});
    gate.resolve({ status: "ready", db: {} });
    assert.equal(a, b);
    assert.equal(calls.length, 1);
    await a;
  });

  test("a rejected open is not cached: the next call retries", async () => {
    const { calls, open } = countingOpen([() => Promise.reject(new Error("no OPFS")), () => Promise.resolve({ status: "ready", db: {} })]);
    const shared = createSharedOpen()(open);
    const first = shared({});
    await assert.rejects(first, /no OPFS/);
    await settle();
    const second = shared({});
    assert.notEqual(second, first);
    assert.equal(calls.length, 2);
    assert.equal((await second).status, "ready");
  });

  test("a locked result is not cached: the next call retries", async () => {
    const { calls, open } = countingOpen([() => Promise.resolve({ status: "locked" }), () => Promise.resolve({ status: "ready", db: {} })]);
    const shared = createSharedOpen()(open);
    assert.equal((await shared({})).status, "locked");
    await settle();
    assert.equal((await shared({})).status, "ready");
    assert.equal(calls.length, 2);
  });

  test("sharedOpenDb wraps openDb: two calls take the lock and start the worker once", async () => {
    assert.equal(typeof mod.sharedOpenDb, "function", "static/db/client.js must export sharedOpenDb");
    const locks = fakeLocks(true);
    const { created, createWorker } = workerFactory();
    const a = mod.sharedOpenDb({ locks, createWorker });
    const b = mod.sharedOpenDb({ locks, createWorker });
    assert.equal(a, b);
    assert.equal((await a).status, "ready");
    assert.equal(locks.requests.length, 1);
    assert.equal(created.length, 1);
  });
});
