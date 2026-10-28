// Covers: MEM-022
// Requirement: association records survive a reload. static/palace_store.js is the palace record
// store; IndexedDB sits behind an injected key-value adapter so node --test runs it in memory.
// Contract (RED; GREEN implements, ADR 0021):
//   createPalaceStore(adapter) -> {get(key), put(key, entry), list()}, all async
//     adapter = {get(key) -> value | undefined, put(key, value), list() -> value[]}, all async;
//     the browser wires an IndexedDB-backed adapter, these tests an in-memory Map.
//     put(key, entry) settles only after adapter.put has settled (durable before ack) and rejects
//     a key that is not a non-empty string; get of an unknown key -> null or undefined; list()
//     returns every stored entry (order unpinned).
//   associationKey(item, locusLabel) -> string; the locus short label is part of the key (D3), and
//     distinct (item, label) pairs never collide, even when one field contains separator chars.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import * as palace from "./palace_store.js";

const tick = () => new Promise((r) => setImmediate(r));

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** In-memory stand-in for the IndexedDB adapter; clones like structured-clone storage does. */
function memoryAdapter() {
  const map = new Map();
  const puts = [];
  return {
    map,
    puts,
    async get(key) {
      return map.has(key) ? structuredClone(map.get(key)) : undefined;
    },
    async put(key, value) {
      puts.push(key);
      map.set(key, structuredClone(value));
    },
    async list() {
      return [...map.values()].map((v) => structuredClone(v));
    },
  };
}

const entry = (item, status) => ({ record: { item, visual: `see ${item}` }, status });

// Covers: MEM-022
// Requirement: palace_store.js exports createPalaceStore and associationKey.
describe("palace store exports", () => {
  test("palace_store.js exports createPalaceStore and associationKey", () => {
    assert.equal(typeof palace.createPalaceStore, "function");
    assert.equal(typeof palace.associationKey, "function");
  });
});

// Covers: MEM-022
// Requirement: each association record is saved as soon as it is put, reads back unchanged,
// can be overwritten (an invalid record regenerated to valid), and is still there for a new
// store over the same backing storage (a page reload).
describe("palace store: records persist through the adapter", () => {
  test("put then get returns the same entry", async () => {
    const store = palace.createPalaceStore(memoryAdapter());
    await store.put("k1", entry("milk", "valid"));
    assert.deepEqual(await store.get("k1"), entry("milk", "valid"));
  });

  test("get of a key never put returns nothing", async () => {
    const store = palace.createPalaceStore(memoryAdapter());
    assert.ok((await store.get("missing")) == null);
  });

  test("put on an existing key overwrites it", async () => {
    const store = palace.createPalaceStore(memoryAdapter());
    await store.put("k1", entry("milk", "invalid"));
    await store.put("k1", entry("milk", "valid"));
    assert.equal((await store.get("k1")).status, "valid");
    assert.equal((await store.list()).length, 1);
  });

  test("list returns every stored entry", async () => {
    const store = palace.createPalaceStore(memoryAdapter());
    await store.put("a", entry("milk", "valid"));
    await store.put("b", entry("eggs", "invalid"));
    await store.put("c", entry("bread", "valid"));
    const items = (await store.list()).map((e) => e.record.item).sort();
    assert.deepEqual(items, ["bread", "eggs", "milk"]);
  });

  test("list of an empty store is an empty array", async () => {
    const store = palace.createPalaceStore(memoryAdapter());
    assert.deepEqual(await store.list(), []);
  });

  test("a new store over the same adapter sees earlier records (reload)", async () => {
    const adapter = memoryAdapter();
    await palace.createPalaceStore(adapter).put("k1", entry("milk", "valid"));
    const reloaded = palace.createPalaceStore(adapter);
    assert.deepEqual(await reloaded.get("k1"), entry("milk", "valid"));
  });

  test("put settles only after the adapter's put has settled", async () => {
    const gate = deferred();
    const adapter = memoryAdapter();
    const innerPut = adapter.put;
    adapter.put = async (key, value) => {
      await gate.promise;
      return innerPut(key, value);
    };
    const store = palace.createPalaceStore(adapter);
    let settled = false;
    const p = store.put("k1", entry("milk", "valid")).then(() => {
      settled = true;
    });
    for (let i = 0; i < 5; i++) await tick();
    assert.equal(settled, false, "put acknowledged before the record reached storage");
    gate.resolve();
    await p;
    assert.equal(settled, true);
    assert.equal(adapter.puts.length, 1);
  });

  test("put rejects an empty or non-string key", async () => {
    const store = palace.createPalaceStore(memoryAdapter());
    for (const bad of ["", null, undefined, 7]) {
      await assert.rejects(store.put(bad, entry("milk", "valid")), `key ${String(bad)}`);
    }
    assert.deepEqual(await store.list(), []);
  });
});

// Covers: MEM-030
// Requirement: the reviewed route order persists and reloads: saveRoute(loci) then loadRoute()
// on a new store over the same adapter returns the same order; nothing saved -> null/undefined;
// association records and the route never overwrite each other; a non-array route is rejected.
describe("palace store: route order", () => {
  const route = [
    { n: 2, label: "door", box: { x1: 1, y1: 1, x2: 9, y2: 9 } },
    { n: 1, label: "lamp", box: { x1: 10, y1: 1, x2: 19, y2: 9 } },
  ];

  test("saveRoute then loadRoute on a reloaded store returns the same order", async () => {
    const adapter = memoryAdapter();
    await palace.createPalaceStore(adapter).saveRoute(route);
    assert.deepEqual(await palace.createPalaceStore(adapter).loadRoute(), route);
  });

  test("loadRoute before any save returns nothing; a second save overwrites", async () => {
    const store = palace.createPalaceStore(memoryAdapter());
    assert.ok((await store.loadRoute()) == null);
    await store.saveRoute(route);
    await store.saveRoute([route[1]]);
    assert.deepEqual(await store.loadRoute(), [route[1]]);
  });

  test("route and association records never overwrite each other", async () => {
    const store = palace.createPalaceStore(memoryAdapter());
    const key = palace.associationKey("milk", "lamp");
    await store.put(key, entry("milk", "valid"));
    await store.saveRoute(route);
    assert.deepEqual(await store.get(key), entry("milk", "valid"));
    await store.put(palace.associationKey("route", "route"), entry("route", "valid"));
    assert.deepEqual(await store.loadRoute(), route);
  });

  test("saveRoute rejects a non-array route", async () => {
    const store = palace.createPalaceStore(memoryAdapter());
    assert.equal(typeof store.saveRoute, "function", "store.saveRoute missing");
    for (const bad of [null, undefined, "lamp", { label: "lamp" }]) {
      await assert.rejects(Promise.resolve().then(() => store.saveRoute(bad)), String(bad));
    }
  });
});

// Covers: MEM-022
// Requirement: an association is keyed by item AND locus short label (D3), so moving an item to
// another locus is a different record, and no two distinct (item, label) pairs share a key.
describe("palace store: associationKey", () => {
  test("is a deterministic string", () => {
    const k = palace.associationKey("milk", "lamp");
    assert.equal(typeof k, "string");
    assert.ok(k.length > 0);
    assert.equal(palace.associationKey("milk", "lamp"), k);
  });

  test("differs when only the locus label differs", () => {
    assert.notEqual(palace.associationKey("milk", "lamp"), palace.associationKey("milk", "door"));
  });

  test("differs when only the item differs", () => {
    assert.notEqual(palace.associationKey("milk", "lamp"), palace.associationKey("eggs", "lamp"));
  });

  test("separator characters inside a field never make two pairs collide", () => {
    const seps = ["|", ":", "/", "::", " ", "\t", "\n", "\u0000", "\\", "\"", ","];
    const seen = new Map();
    for (const s of seps) {
      for (const [item, label] of [
        [`a${s}b`, "c"],
        ["a", `b${s}c`],
        [`a${s}`, "bc"],
        ["a", `${s}bc`],
        ["ab", `${s}c`],
      ]) {
        const k = palace.associationKey(item, label);
        const prev = seen.get(k);
        if (prev) {
          assert.deepEqual(prev, [item, label], `collision: ${JSON.stringify(prev)} vs ${JSON.stringify([item, label])}`);
        }
        seen.set(k, [item, label]);
      }
    }
  });
});

/** In-memory Web Storage stand-in: getItem -> null when missing, values stored as strings. */
function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
  };
}

// Covers: MEM-033
// Requirement: palace and rehearsal records persist in the browser's localStorage until the
// IndexedDB adapter lands. localStorageAdapter(prefix, storage?) -> {get, put, delete, list}, all
// async: values are JSON-encoded under prefix + key, a missing key reads back undefined, list()
// returns only this prefix's values (two prefixes on one origin never see each other; order
// unpinned), and storage is only touched on use, so a page with storage disabled still loads.
describe("palace store: localStorageAdapter", () => {
  test("get of a key never put returns undefined", async () => {
    const s = fakeStorage();
    const a = palace.localStorageAdapter("p:", () => s);
    assert.equal(await a.get("missing"), undefined);
  });

  test("put then get round-trips JSON values, across a new adapter on the same storage", async () => {
    const s = fakeStorage();
    const a = palace.localStorageAdapter("p:", () => s);
    const values = { obj: entry("milk", "valid"), arr: [1, "two", { three: 3 }], str: "lamp", num: 0, nul: null, f: false };
    for (const [k, v] of Object.entries(values)) await a.put(k, v);
    const reloaded = palace.localStorageAdapter("p:", () => s);
    for (const [k, v] of Object.entries(values)) assert.deepEqual(await reloaded.get(k), v, k);
    assert.equal(s.getItem("p:obj"), JSON.stringify(values.obj), "stored JSON-encoded under prefix + key");
  });

  test("put on an existing key overwrites it", async () => {
    const s = fakeStorage();
    const a = palace.localStorageAdapter("p:", () => s);
    await a.put("k", entry("milk", "invalid"));
    await a.put("k", entry("milk", "valid"));
    assert.deepEqual(await a.get("k"), entry("milk", "valid"));
    assert.equal((await a.list()).length, 1);
  });

  test("delete removes only that key", async () => {
    const s = fakeStorage();
    const a = palace.localStorageAdapter("p:", () => s);
    await a.put("gone", entry("milk", "valid"));
    await a.put("kept", entry("eggs", "valid"));
    await a.delete("gone");
    assert.equal(await a.get("gone"), undefined);
    assert.deepEqual(await a.get("kept"), entry("eggs", "valid"));
    assert.deepEqual(await a.list(), [entry("eggs", "valid")]);
  });

  test("list returns only this prefix's values; two prefixes are isolated", async () => {
    const s = fakeStorage({ unrelated: JSON.stringify("other app"), "q": JSON.stringify("bare prefix") });
    const palaceA = palace.localStorageAdapter("memripal.palace:", () => s);
    const rehearsalA = palace.localStorageAdapter("memripal.rehearsal:", () => s);
    assert.deepEqual(await palaceA.list(), []);
    await palaceA.put("b", "palace-b");
    await rehearsalA.put("a", "rehearsal-a");
    await palaceA.put("a", "palace-a");
    assert.deepEqual((await palaceA.list()).sort(), ["palace-a", "palace-b"]);
    assert.deepEqual(await rehearsalA.list(), ["rehearsal-a"]);
    assert.equal(await rehearsalA.get("b"), undefined, "a key put under one prefix is invisible to the other");
  });

  test("constructing touches no storage; use surfaces a storage failure as a rejection", async () => {
    let touched = 0;
    const broken = () => {
      touched++;
      throw new Error("storage disabled");
    };
    const a = palace.localStorageAdapter("p:", broken);
    assert.equal(touched, 0, "storage touched at construction");
    assert.doesNotThrow(() => palace.localStorageAdapter("p:"));
    await assert.rejects(a.get("k"), /storage disabled/);
    await assert.rejects(a.list(), /storage disabled/);
  });
});
