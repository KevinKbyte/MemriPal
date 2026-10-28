// Covers: MEM-033
// Requirement: rehearsal records (and palace records) survive a reload because the browser stores
// them in IndexedDB. static/idb_adapter.js wraps an injected IndexedDB factory in the async key-value
// adapter that static/rehearsals.js and static/palace_store.js consume.
// Contract (RED; GREEN implements in static/idb_adapter.js):
//   createIdbAdapter(indexedDB, {dbName, storeName}) -> {get(key), put(key, value), delete(key), list()}
//     all async; never throws synchronously, even when indexedDB is missing.
//     get(key) -> the stored value, or undefined when absent.
//     put(key, value) resolves only once the readwrite transaction completes; rejects when the
//       request errors or the transaction aborts (and nothing is stored).
//     delete(key) removes the entry. list() (no argument) -> every stored value, ascending key order.
//     Every op rejects when indexedDB is missing (undefined/null) or the open request fails.
//     onupgradeneeded creates storeName with out-of-line keys (no keyPath, no autoIncrement).
//     One open request per adapter instance, reused by every op (including concurrent first ops).
//     A new adapter on the same factory + dbName sees earlier writes (reload).
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import * as idb from "./idb_adapter.js";

const tick = () => new Promise((r) => setImmediate(r));
const OPTS = { dbName: "memripal-test", storeName: "rehearsals" };

class FakeTarget {
  constructor() {
    this._listeners = new Map();
  }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this._listeners.get(type) ?? [];
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }
  _fire(type, event) {
    const ev = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...event };
    const handler = this["on" + type];
    if (typeof handler === "function") handler.call(this, ev);
    for (const fn of [...(this._listeners.get(type) ?? [])]) fn.call(this, ev);
    return ev;
  }
}

class FakeRequest extends FakeTarget {
  constructor(transaction = null) {
    super();
    this.result = undefined;
    this.error = null;
    this.readyState = "pending";
    this.transaction = transaction;
    this.onsuccess = null;
    this.onerror = null;
  }
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Minimal in-memory IndexedDB factory. Callbacks fire on microtasks, like the real event loop.
 * Knobs: failOpen, failNextRequest (op name), abortNextTransaction, holdCompletes + releaseCompletes().
 */
function fakeIndexedDB() {
  /** name -> {version, stores: Map<storeName, {keyPath, autoIncrement, records: Map}>} */
  const dbs = new Map();
  const held = [];
  const factory = {
    dbs,
    opens: 0,
    failOpen: false,
    failNextRequest: null,
    abortNextTransaction: false,
    holdCompletes: false,
    releaseCompletes() {
      factory.holdCompletes = false;
      for (const commit of held.splice(0)) commit();
    },
    open(name, version) {
      factory.opens += 1;
      const req = new FakeRequest();
      queueMicrotask(() => {
        if (factory.failOpen) {
          req.readyState = "done";
          req.error = new DOMException("open denied", "UnknownError");
          req._fire("error", {});
          return;
        }
        const existing = dbs.get(name);
        const oldVersion = existing ? existing.version : 0;
        const newVersion = version ?? (existing ? existing.version : 1);
        if (existing && newVersion < oldVersion) {
          req.readyState = "done";
          req.error = new DOMException("lower version", "VersionError");
          req._fire("error", {});
          return;
        }
        const schema = existing ?? { version: newVersion, stores: new Map() };
        dbs.set(name, schema);
        const conn = connection(schema);
        req.result = conn;
        if (newVersion > oldVersion) {
          schema.version = newVersion;
          conn._upgrading = true;
          req.readyState = "done";
          req.transaction = { mode: "versionchange", db: conn };
          req._fire("upgradeneeded", { oldVersion, newVersion });
          conn._upgrading = false;
          req.transaction = null;
        }
        queueMicrotask(() => {
          req.readyState = "done";
          req._fire("success", {});
        });
      });
      return req;
    },
  };

  function connection(schema) {
    const conn = new FakeTarget();
    conn._upgrading = false;
    conn.onversionchange = null;
    Object.defineProperty(conn, "version", { get: () => schema.version });
    Object.defineProperty(conn, "objectStoreNames", {
      get: () => {
        const names = [...schema.stores.keys()].sort(cmp);
        return Object.assign([...names], { contains: (n) => names.includes(n), item: (i) => names[i] ?? null });
      },
    });
    conn.createObjectStore = (storeName, opts = {}) => {
      if (!conn._upgrading) throw new DOMException("not in upgrade", "InvalidStateError");
      if (schema.stores.has(storeName)) throw new DOMException("store exists", "ConstraintError");
      schema.stores.set(storeName, {
        keyPath: opts.keyPath ?? null,
        autoIncrement: opts.autoIncrement === true,
        records: new Map(),
      });
      return { name: storeName };
    };
    conn.close = () => {};
    conn.transaction = (names, mode = "readonly") => {
      const list = Array.isArray(names) ? names : [names];
      for (const n of list) if (!schema.stores.has(n)) throw new DOMException(`no store ${n}`, "NotFoundError");
      return transaction(schema, list, mode, conn);
    };
    return conn;
  }

  function transaction(schema, names, mode, db) {
    const tx = new FakeTarget();
    Object.assign(tx, { mode, db, error: null, oncomplete: null, onerror: null, onabort: null });
    const undo = [];
    let pending = 0;
    let finished = false;
    const finish = (type) => {
      finished = true;
      if (type === "abort") for (const fn of undo.reverse()) fn();
      tx._fire(type, {});
    };
    const settle = () => {
      if (finished || pending > 0) return;
      if (factory.abortNextTransaction && mode === "readwrite") {
        factory.abortNextTransaction = false;
        tx.error = new DOMException("quota", "QuotaExceededError");
        finish("abort");
      } else if (factory.holdCompletes && mode === "readwrite") {
        finished = true;
        held.push(() => tx._fire("complete", {}));
      } else {
        finish("complete");
      }
    };
    queueMicrotask(settle);

    const request = (op, run) => {
      if (finished) throw new DOMException("transaction finished", "TransactionInactiveError");
      const req = new FakeRequest(tx);
      pending += 1;
      queueMicrotask(() => {
        req.readyState = "done";
        if (factory.failNextRequest === op) {
          factory.failNextRequest = null;
          req.error = new DOMException(`${op} failed`, "ConstraintError");
          const ev = req._fire("error", {});
          pending -= 1;
          if (!ev.defaultPrevented) {
            tx.error = req.error;
            tx._fire("error", { target: req });
            finish("abort");
          } else queueMicrotask(settle);
          return;
        }
        run(req);
        pending -= 1;
        queueMicrotask(settle);
      });
      return req;
    };

    tx.objectStore = (storeName) => {
      if (!names.includes(storeName)) throw new DOMException(`not in scope ${storeName}`, "NotFoundError");
      const store = schema.stores.get(storeName);
      const writable = () => {
        if (mode === "readonly") throw new DOMException("readonly transaction", "ReadOnlyError");
      };
      const sortedKeys = () => [...store.records.keys()].sort(cmp);
      return {
        name: storeName,
        keyPath: store.keyPath,
        autoIncrement: store.autoIncrement,
        get: (key) =>
          request("get", (req) => {
            req.result = store.records.has(key) ? structuredClone(store.records.get(key)) : undefined;
            req._fire("success", {});
          }),
        put: (value, key) => {
          writable();
          if (store.keyPath === null && key === undefined) throw new DOMException("out-of-line key required", "DataError");
          if (store.keyPath !== null && key !== undefined) throw new DOMException("in-line keys", "DataError");
          const k = key ?? value[store.keyPath];
          const stored = structuredClone(value);
          return request("put", (req) => {
            const had = store.records.has(k);
            const prev = store.records.get(k);
            undo.push(() => (had ? store.records.set(k, prev) : store.records.delete(k)));
            store.records.set(k, stored);
            req.result = k;
            req._fire("success", {});
          });
        },
        delete: (key) => {
          writable();
          return request("delete", (req) => {
            const had = store.records.has(key);
            const prev = store.records.get(key);
            undo.push(() => had && store.records.set(key, prev));
            store.records.delete(key);
            req._fire("success", {});
          });
        },
        getAll: () =>
          request("getAll", (req) => {
            req.result = sortedKeys().map((k) => structuredClone(store.records.get(k)));
            req._fire("success", {});
          }),
        getAllKeys: () =>
          request("getAllKeys", (req) => {
            req.result = sortedKeys();
            req._fire("success", {});
          }),
        openCursor: () => {
          const keys = sortedKeys();
          let i = 0;
          return request("openCursor", (req) => {
            const step = () => {
              if (i >= keys.length) {
                req.result = null;
              } else {
                const k = keys[i];
                req.result = {
                  key: k,
                  primaryKey: k,
                  value: structuredClone(store.records.get(k)),
                  continue: () => {
                    i += 1;
                    pending += 1;
                    queueMicrotask(() => {
                      step();
                      pending -= 1;
                      queueMicrotask(settle);
                    });
                  },
                };
              }
              req._fire("success", {});
            };
            step();
          });
        },
      };
    };
    return tx;
  }

  return factory;
}

const adapterOn = (factory, opts = OPTS) => idb.createIdbAdapter(factory, opts);

// Covers: MEM-033
// Requirement: idb_adapter.js exports createIdbAdapter, which builds the async get/put/delete/list adapter.
describe("idb adapter shape", () => {
  test("createIdbAdapter returns get, put, delete and list functions", () => {
    assert.equal(typeof idb.createIdbAdapter, "function");
    const a = adapterOn(fakeIndexedDB());
    for (const op of ["get", "put", "delete", "list"]) assert.equal(typeof a[op], "function", op);
  });
});

// Covers: MEM-033
// Requirement: values put through the adapter read back unchanged; an absent key reads as undefined;
// a second put overwrites; delete removes; list() returns every value in ascending key order.
describe("idb adapter read/write", () => {
  test("get of a key never stored resolves to undefined", async () => {
    assert.equal(await adapterOn(fakeIndexedDB()).get("nope"), undefined);
  });

  test("put then get round-trips strings and objects unchanged", async () => {
    const a = adapterOn(fakeIndexedDB());
    const record = { id: "r1", points: [{ label: "door", got: true, span: null }] };
    await a.put("s", '{"id":"r0"}');
    await a.put("o", record);
    assert.equal(await a.get("s"), '{"id":"r0"}');
    assert.deepEqual(await a.get("o"), record);
  });

  test("a second put to the same key overwrites, leaving one entry", async () => {
    const a = adapterOn(fakeIndexedDB());
    await a.put("k", "first");
    await a.put("k", "second");
    assert.equal(await a.get("k"), "second");
    assert.deepEqual(await a.list(), ["second"]);
  });

  test("delete removes the entry from get and list; deleting an absent key resolves", async () => {
    const a = adapterOn(fakeIndexedDB());
    await a.put("a", "A");
    await a.put("b", "B");
    await a.delete("a");
    assert.equal(await a.get("a"), undefined);
    assert.deepEqual(await a.list(), ["B"]);
    await a.delete("never-stored");
  });

  test("list() with no argument returns every value in ascending key order", async () => {
    const a = adapterOn(fakeIndexedDB());
    assert.deepEqual(await a.list(), []);
    await a.put("c", "C");
    await a.put("a", "A");
    await a.put("b", "B");
    assert.deepEqual(await a.list(), ["A", "B", "C"]);
  });
});

// Covers: MEM-033
// Requirement: a put is acknowledged only once IndexedDB has durably committed it; a failed write
// rejects instead of silently reporting success.
describe("idb adapter write durability", () => {
  test("put stays pending until the transaction completes", async () => {
    const f = fakeIndexedDB();
    const a = adapterOn(f);
    await a.get("warm-up");
    f.holdCompletes = true;
    let settled = false;
    const p = a.put("k", "v").then(() => (settled = true));
    await tick();
    await tick();
    await tick();
    assert.equal(settled, false, "put resolved before transaction complete");
    f.releaseCompletes();
    await p;
    assert.equal(settled, true);
  });

  test("put rejects when its request errors, and nothing is stored", async () => {
    const f = fakeIndexedDB();
    const a = adapterOn(f);
    f.failNextRequest = "put";
    await assert.rejects(() => a.put("k", "v"), { name: "ConstraintError" });
    assert.equal(await a.get("k"), undefined);
  });

  test("put rejects when the transaction aborts after the request succeeded", async () => {
    const f = fakeIndexedDB();
    const a = adapterOn(f);
    f.abortNextTransaction = true;
    await assert.rejects(() => a.put("k", "v"), { name: "QuotaExceededError" });
    assert.equal(await a.get("k"), undefined);
  });
});

// Covers: MEM-033
// Requirement: when IndexedDB is unavailable (missing, or the database cannot be opened) every adapter
// op rejects, so callers can surface the failure instead of hanging or crashing at construction.
describe("idb adapter unavailable", () => {
  for (const [label, factory] of [
    ["undefined", undefined],
    ["null", null],
  ]) {
    test(`indexedDB ${label}: construction does not throw and every op rejects`, async () => {
      const a = idb.createIdbAdapter(factory, OPTS);
      await assert.rejects(() => a.get("k"));
      await assert.rejects(() => a.put("k", "v"));
      await assert.rejects(() => a.delete("k"));
      await assert.rejects(() => a.list());
    });
  }

  test("open request fails: every op rejects", async () => {
    const f = fakeIndexedDB();
    f.failOpen = true;
    const a = adapterOn(f);
    await assert.rejects(() => a.get("k"));
    await assert.rejects(() => a.put("k", "v"));
    await assert.rejects(() => a.delete("k"));
    await assert.rejects(() => a.list());
  });
});

// Covers: MEM-033
// Requirement: stored rehearsals survive a page reload: the database and store are created on first
// open with out-of-line keys, and a fresh adapter on the same database sees earlier writes.
describe("idb adapter persistence and schema", () => {
  test("first open creates storeName in dbName with out-of-line keys", async () => {
    const f = fakeIndexedDB();
    await adapterOn(f).list();
    const schema = f.dbs.get(OPTS.dbName);
    assert.ok(schema, "database dbName not created");
    const store = schema.stores.get(OPTS.storeName);
    assert.ok(store, "object store storeName not created");
    assert.equal(store.keyPath, null);
    assert.equal(store.autoIncrement, false);
  });

  test("a new adapter on the same factory (reload) reads earlier writes", async () => {
    const f = fakeIndexedDB();
    const before = adapterOn(f);
    await before.put("b", "B");
    await before.put("a", "A");
    await before.delete("b");
    await before.put("c", "C");
    const after = adapterOn(f);
    assert.equal(await after.get("a"), "A");
    assert.equal(await after.get("b"), undefined);
    assert.deepEqual(await after.list(), ["A", "C"]);
  });

  test("dbName and storeName are honoured: a different dbName does not see the data", async () => {
    const f = fakeIndexedDB();
    await adapterOn(f).put("k", "v");
    const other = adapterOn(f, { dbName: "other-db", storeName: "palace" });
    assert.equal(await other.get("k"), undefined);
    assert.deepEqual(await other.list(), []);
    assert.ok(f.dbs.get("other-db")?.stores.has("palace"));
  });
});

// Covers: MEM-033
// Requirement: one adapter opens the database once and reuses that connection for every op, even
// when the first ops are issued concurrently before the open has finished.
describe("idb adapter connection reuse", () => {
  test("sequential ops share a single open", async () => {
    const f = fakeIndexedDB();
    const a = adapterOn(f);
    await a.put("k", "v");
    await a.get("k");
    await a.list();
    await a.delete("k");
    assert.equal(f.opens, 1);
  });

  test("concurrent first ops share a single open", async () => {
    const f = fakeIndexedDB();
    const a = adapterOn(f);
    const [, , got, all] = await Promise.all([a.put("x", "X"), a.put("y", "Y"), a.get("missing"), a.list()]);
    assert.equal(got, undefined);
    assert.ok(Array.isArray(all));
    assert.equal(f.opens, 1);
    assert.deepEqual(await a.list(), ["X", "Y"]);
  });
});
