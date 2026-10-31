// Covers: MEM-039
// Requirement: routes and stations kept in on-device SQLite behave exactly like the IndexedDB store:
// every route store test (static/route_store.test.mjs, unchanged) passes with the SQL KV adapter
// (static/db/route_adapter.js over real in-memory SQLite) in place of the Map fake (item 159 S2).
import { setAdapterFactory } from "./route_store_fakes_test.mjs";
import { sqlAdapter } from "./route_store_sql_fakes_test.mjs";

setAdapterFactory(sqlAdapter);
await import("./route_store.test.mjs");
