// Covers: MEM-039
// Requirement: station capture over the SQLite-backed route store behaves exactly like over the
// IndexedDB store: every capture test (static/route_store_capture.test.mjs, unchanged) passes with
// the SQL KV adapter (static/db/route_adapter.js over real in-memory SQLite) (item 159 S2).
import { setAdapterFactory } from "./route_store_fakes_test.mjs";
import { sqlAdapter } from "./route_store_sql_fakes_test.mjs";

setAdapterFactory(sqlAdapter);
await import("./route_store_capture.test.mjs");
