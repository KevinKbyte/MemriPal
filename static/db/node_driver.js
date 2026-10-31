// Node-only SQLite driver over the vendored sqlite-wasm node build (test-only, never served):
// gives tests a real in-memory engine with the same small db shape the browser worker uses.
import sqlite3InitModule from "../../vendor-node/sqlite-wasm/node.mjs";

let sqlite3Promise = null;

function bindOf(params) {
  return params && params.length ? params : undefined;
}

function wrapOo1(raw) {
  return {
    exec(sql, params) {
      raw.exec({ sql, bind: bindOf(params) });
    },
    // oo1 rows have a null prototype; copy so they compare like rows that crossed postMessage.
    query(sql, params) {
      return raw.selectObjects(sql, bindOf(params)).map((row) => ({ ...row }));
    },
    transaction(fn) {
      raw.exec("BEGIN");
      try {
        const out = fn();
        raw.exec("COMMIT");
        return out;
      } catch (err) {
        raw.exec("ROLLBACK");
        throw err;
      }
    },
  };
}

export async function openMemoryDb() {
  sqlite3Promise ??= sqlite3InitModule();
  const sqlite3 = await sqlite3Promise;
  return wrapOo1(new sqlite3.oo1.DB(":memory:"));
}
