// Node-only SQLite driver over the vendored sqlite-wasm node build (test-only, never served):
// gives tests a real in-memory engine with the same small db shape the browser worker uses.
import sqlite3InitModule from "../../vendor-node/sqlite-wasm/node.mjs";
import { wrapOo1 } from "./oo1.js";

export { wrapOo1 };

let sqlite3Promise = null;

export async function openMemoryDb() {
  sqlite3Promise ??= sqlite3InitModule();
  const sqlite3 = await sqlite3Promise;
  return wrapOo1(new sqlite3.oo1.DB(":memory:"));
}

/** The async client.js shape (exec/query promises, transaction(stmts)) over a sync db, for tests. */
export function asClient(db) {
  return {
    exec: async (sql, params = []) => {
      db.exec(sql, params);
      return [];
    },
    query: async (sql, params = []) => db.query(sql, params),
    transaction: async (stmts) => {
      db.transaction(() => {
        for (const s of stmts) db.exec(s.sql, s.params);
      });
      return [];
    },
  };
}
