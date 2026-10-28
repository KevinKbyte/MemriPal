// Covers: MEM-039
// Requirement: palaces and rehearsals saved in localStorage before IndexedDB existed show up after
// the switch: on load each prefix's records are copied once into that store's IndexedDB adapter and
// only then cleared from localStorage, without ever losing or overwriting a record.
// Contract (RED; GREEN implements):
//   static/storage_migrate.js (new module) exports migrateLocalStorage(getStorage, prefix, adapter)
//   -> Promise<{copied, skipped, cleared}>, never rejects. getStorage() returns the Storage (it may
//   throw where storage is disabled); adapter = async {get, put}. Keys are the localStorage names
//   minus `prefix`; values are what localStorageAdapter(prefix).get returns (JSON.parse of the raw).
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { deferred, settle } from "./fake_dom_test.mjs";
import { associationKey, localStorageAdapter } from "./palace_store.js";

const mod = await import("./storage_migrate.js").catch((err) => ({ __missing: String(err) }));

function migrate() {
  assert.ok("migrateLocalStorage" in mod, `static/storage_migrate.js must export migrateLocalStorage (${mod.__missing ?? "not exported"})`);
  return mod.migrateLocalStorage;
}

const PALACE = "memripal.palace:";
const REH = "memripal.rehearsal:";
const PLACE_HISTORY = "memripal.placeHistory";

/** localStorage stand-in: insertion-ordered, indices shift on remove like the real one. */
function fakeStorage(entries = {}) {
  const map = new Map(Object.entries(entries));
  const removed = [];
  const writes = [];
  return {
    map,
    removed,
    writes,
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      writes.push(k);
      map.set(k, String(v));
    },
    removeItem: (k) => {
      removed.push(k);
      map.delete(k);
    },
  };
}

/** IndexedDB-adapter stand-in; failGet/failPut(key) -> that call rejects. */
function fakeAdapter({ seed = {}, failGet = () => false, failPut = () => false, putGate = null } = {}) {
  const map = new Map(Object.entries(seed));
  const puts = [];
  return {
    map,
    puts,
    get: async (k) => {
      if (failGet(k)) throw new Error("IndexedDB open failed");
      return map.has(k) ? structuredClone(map.get(k)) : undefined;
    },
    put: async (k, v) => {
      if (putGate) await putGate;
      if (failPut(k)) throw new Error("QuotaExceededError");
      puts.push(k);
      map.set(k, structuredClone(v));
    },
  };
}

const rehearsalJson = (id) =>
  JSON.stringify({ id, palace_id: "demo", timestamp: "2026-10-01T09:00:00.000Z", transcript: "t", points: [] });
const ENTRY = { record: { item: "a", locus: "lamp" }, status: "valid", sig: "s1" };
const ROUTE = [{ n: 1, label: "lamp" }, { n: 2, label: "door" }];
const KEY_A = associationKey("a", "lamp");

/** localStorage exactly as localStorageAdapter(prefix).put would have left it. */
function lsWith(prefix, records, extra = {}) {
  const s = fakeStorage(extra);
  for (const [k, v] of Object.entries(records)) s.map.set(prefix + k, JSON.stringify(v));
  return s;
}

const prefixed = (s, prefix) => [...s.map.keys()].filter((k) => k.startsWith(prefix));

// Covers: MEM-039
// Requirement: every well-formed record under the prefix lands in IndexedDB with exactly the value the
// localStorage fallback served, and only then leaves localStorage; other keys are never touched.
describe("migrateLocalStorage copies then clears", () => {
  test("rehearsal records: each JSON string is put under its key minus the prefix, then removed", async () => {
    const s = lsWith(REH, { r1: rehearsalJson("r1"), r2: rehearsalJson("r2") });
    const want = { r1: await localStorageAdapter(REH, () => s).get("r1"), r2: await localStorageAdapter(REH, () => s).get("r2") };
    const a = fakeAdapter();
    const out = await migrate()(() => s, REH, a);
    assert.equal(typeof out, "object");
    for (const k of ["copied", "skipped", "cleared"]) assert.ok(k in out, `result has ${k}`);
    assert.deepEqual(Object.fromEntries(a.map), want, "IndexedDB holds what the localStorage adapter served");
    assert.equal(typeof a.map.get("r1"), "string", "a rehearsal stays a JSON string");
    assert.deepEqual(prefixed(s, REH), [], "copied keys cleared");
  });

  test("palace records: an association entry and the route array keep their shape", async () => {
    const s = lsWith(PALACE, { [KEY_A]: ENTRY, route: ROUTE });
    const a = fakeAdapter();
    await migrate()(() => s, PALACE, a);
    assert.deepEqual(a.map.get(KEY_A), ENTRY);
    assert.deepEqual(a.map.get("route"), ROUTE);
    assert.deepEqual(prefixed(s, PALACE), []);
  });

  test("many keys: every one is copied and cleared (removal does not skip shifted keys)", async () => {
    const recs = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`r${i}`, rehearsalJson(`r${i}`)]));
    const s = lsWith(REH, recs);
    const a = fakeAdapter();
    await migrate()(() => s, REH, a);
    assert.deepEqual([...a.map.keys()].sort(), Object.keys(recs).sort());
    assert.equal(s.length, 0);
  });

  test("other keys are untouched: placeHistory and the other store's prefix stay, never copied", async () => {
    const history = JSON.stringify([{ title: "Home" }]);
    const s = lsWith(PALACE, { route: ROUTE }, { [PLACE_HISTORY]: history, [`${REH}r1`]: JSON.stringify(rehearsalJson("r1")), other: "x" });
    const a = fakeAdapter();
    await migrate()(() => s, PALACE, a);
    assert.deepEqual([...a.map.keys()], ["route"], "only this prefix is copied");
    assert.equal(s.getItem(PLACE_HISTORY), history);
    assert.equal(s.getItem(`${REH}r1`), JSON.stringify(rehearsalJson("r1")));
    assert.equal(s.getItem("other"), "x");
    assert.deepEqual(s.removed, [`${PALACE}route`], "only the copied key removed");
    assert.deepEqual(s.writes, [], "localStorage is never written");
  });

  test("a record already in IndexedDB wins: nothing written for it, its localStorage copy cleared", async () => {
    const theirs = rehearsalJson("r1-idb");
    const s = lsWith(REH, { r1: rehearsalJson("r1-ls"), r2: rehearsalJson("r2"), r3: rehearsalJson("r3") });
    const a = fakeAdapter({ seed: { r1: theirs, r3: null } });
    await migrate()(() => s, REH, a);
    assert.equal(a.map.get("r1"), theirs, "no overwrite");
    assert.equal(a.map.get("r3"), null, "any stored value other than undefined counts as present");
    assert.deepEqual(a.puts, ["r2"], "only the missing record is written");
    assert.deepEqual(prefixed(s, REH), [], "copied and already-present keys both cleared");
  });

  test("no prefixed keys: resolves with no put and no remove", async () => {
    const s = fakeStorage({ [PLACE_HISTORY]: "[]" });
    const a = fakeAdapter();
    await migrate()(() => s, REH, a);
    assert.deepEqual(a.puts, []);
    assert.deepEqual(s.removed, []);
  });
});

// Covers: MEM-039
// Requirement: a corrupt record never blocks the others and is never lost: it stays in localStorage
// while every well-formed record still moves to IndexedDB.
describe("migrateLocalStorage with malformed JSON", () => {
  test("the malformed key is skipped and kept; the others are copied and cleared", async () => {
    const s = lsWith(REH, { r1: rehearsalJson("r1"), r3: rehearsalJson("r3") });
    s.map.set(`${REH}r2`, "{not json");
    const a = fakeAdapter();
    const out = await migrate()(() => s, REH, a);
    assert.equal(typeof out, "object");
    assert.deepEqual([...a.map.keys()].sort(), ["r1", "r3"]);
    assert.equal(s.getItem(`${REH}r2`), "{not json", "malformed value kept as is");
    assert.deepEqual(prefixed(s, REH), [`${REH}r2`]);
    assert.ok(!s.removed.includes(`${REH}r2`), "never removed");
  });
});

// Covers: MEM-039
// Requirement: localStorage is cleared only once IndexedDB has durably taken every record of that
// prefix; any IndexedDB failure (open or write) leaves localStorage exactly as it was, so the next
// load retries, and the page still loads (the migration never rejects).
describe("migrateLocalStorage clears only after every copy succeeded", () => {
  test("one put fails: resolves, and no key of that prefix is removed (not even copied ones)", async () => {
    const s = lsWith(REH, { r1: rehearsalJson("r1"), r2: rehearsalJson("r2"), r3: rehearsalJson("r3") });
    const before = [...s.map.entries()];
    const a = fakeAdapter({ failPut: (k) => k === "r2" });
    await assert.doesNotReject(migrate()(() => s, REH, a));
    assert.deepEqual(s.removed, []);
    assert.deepEqual([...s.map.entries()], before);
  });

  test("every put fails: resolves, nothing removed", async () => {
    const s = lsWith(PALACE, { [KEY_A]: ENTRY, route: ROUTE });
    const a = fakeAdapter({ failPut: () => true });
    await assert.doesNotReject(migrate()(() => s, PALACE, a));
    assert.deepEqual(s.removed, []);
    assert.equal(prefixed(s, PALACE).length, 2);
  });

  test("get fails (IndexedDB cannot open): resolves, nothing removed", async () => {
    const s = lsWith(REH, { r1: rehearsalJson("r1"), r2: rehearsalJson("r2") });
    const a = fakeAdapter({ failGet: () => true });
    await assert.doesNotReject(migrate()(() => s, REH, a));
    assert.deepEqual(s.removed, []);
    assert.equal(prefixed(s, REH).length, 2);
  });

  test("a failed run is retried on the next load and then clears", async () => {
    const s = lsWith(REH, { r1: rehearsalJson("r1"), r2: rehearsalJson("r2") });
    const a = fakeAdapter({ failPut: (k) => k === "r2" });
    await migrate()(() => s, REH, a);
    assert.equal(prefixed(s, REH).length, 2, "first load clears nothing");
    const healthy = fakeAdapter({ seed: Object.fromEntries(a.map) });
    await migrate()(() => s, REH, healthy);
    assert.deepEqual(healthy.puts, ["r2"], "only the record that never landed is written");
    assert.deepEqual(prefixed(s, REH), []);
  });

  test("nothing is removed while a put is still pending (removal waits for transaction complete)", async () => {
    const gate = deferred();
    const s = lsWith(REH, { r1: rehearsalJson("r1") });
    const a = fakeAdapter({ putGate: gate.promise });
    const run = migrate()(() => s, REH, a);
    await settle(30);
    assert.deepEqual(s.removed, [], "still in localStorage before the write completes");
    gate.resolve();
    await run;
    assert.deepEqual(prefixed(s, REH), []);
  });

  test("storage unreadable (getStorage throws): resolves, adapter never touched", async () => {
    const a = fakeAdapter();
    let gets = 0;
    const counting = { ...a, get: async (k) => (gets++, a.get(k)) };
    const blocked = () => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    };
    await assert.doesNotReject(migrate()(blocked, REH, counting));
    assert.equal(gets, 0);
    assert.deepEqual(a.puts, []);
  });
});

// Covers: MEM-039
// Requirement: the migration runs on every load but only does work once: a second load finds nothing
// to copy (or only the kept malformed record) and writes or removes nothing.
describe("migrateLocalStorage is idempotent", () => {
  test("second run after a clean migration: no put, no remove", async () => {
    const s = lsWith(PALACE, { [KEY_A]: ENTRY, route: ROUTE }, { [PLACE_HISTORY]: "[]" });
    const a = fakeAdapter();
    await migrate()(() => s, PALACE, a);
    const puts = a.puts.length;
    const removed = s.removed.length;
    await migrate()(() => s, PALACE, a);
    assert.equal(a.puts.length, puts, "no put on the second load");
    assert.equal(s.removed.length, removed, "no remove on the second load");
    assert.equal(s.getItem(PLACE_HISTORY), "[]");
  });

  test("second run with only a kept malformed key: no put, no remove, the key still kept", async () => {
    const s = lsWith(REH, { r1: rehearsalJson("r1") });
    s.map.set(`${REH}bad`, "nope{");
    const a = fakeAdapter();
    await migrate()(() => s, REH, a);
    const puts = a.puts.length;
    const removed = s.removed.length;
    await migrate()(() => s, REH, a);
    assert.equal(a.puts.length, puts);
    assert.equal(s.removed.length, removed);
    assert.equal(s.getItem(`${REH}bad`), "nope{");
  });
});
