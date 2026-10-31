// SQL-backed KV adapter fake for the S2 matrix runners (MEM-039). Not a test file itself (no
// describe/test): route_store_sql.test.mjs and route_store_capture_sql.test.mjs install sqlAdapter
// via setAdapterFactory, then re-run the original route store tests over it.
// sqlAdapter() is synchronous (the originals call memoryAdapter() without awaiting): it opens a fresh
// in-memory SQLite (static/db/node_driver.js), applies static/db/schema.js MIGRATIONS, and wraps it in
// createSqlRouteAdapter(asClient(db), photoKv) from static/db/route_adapter.js; every method awaits
// that setup. Photos go to a Map-backed photo KV. state.failPuts makes route and photo puts reject
// with a QuotaExceededError, like the Map fake.
import { openMemoryDb, asClient } from "./db/node_driver.js";
import { runMigrations } from "./db/migrations.js";
import { MIGRATIONS } from "./db/schema.js";
import { createSqlRouteAdapter } from "./db/route_adapter.js";

/** Photo KV backed by a Map; clones like structured-clone storage. */
export function mapPhotoKv() {
  const map = new Map();
  return {
    map,
    async get(key) {
      return map.has(key) ? structuredClone(map.get(key)) : undefined;
    },
    async put(key, value) {
      map.set(key, structuredClone(value));
    },
    async delete(key) {
      map.delete(key);
    },
    async list() {
      return [...map.values()].map((v) => structuredClone(v));
    },
  };
}

function quotaError() {
  const err = new Error("The quota has been exceeded.");
  err.name = "QuotaExceededError";
  return err;
}

export function sqlAdapter() {
  const state = { failPuts: false };
  const ready = (async () => {
    const db = await openMemoryDb();
    await runMigrations(db, MIGRATIONS);
    return createSqlRouteAdapter(asClient(db), mapPhotoKv());
  })();
  // A setup failure surfaces on the first call; this only keeps it from being an unhandled rejection.
  ready.catch(() => {});
  return {
    state,
    async get(key) {
      return (await ready).get(key);
    },
    async put(key, value) {
      const adapter = await ready;
      if (state.failPuts) throw quotaError();
      return adapter.put(key, value);
    },
    async delete(key) {
      return (await ready).delete(key);
    },
    async list() {
      return (await ready).list();
    },
  };
}
