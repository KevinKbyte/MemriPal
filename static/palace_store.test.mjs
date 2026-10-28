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
