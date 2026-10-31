// Module Worker owning the on-device SQLite database (opfs-sahpool VFS; browser-only).
// Answers client.js requests { id, op, sql, params | stmts } with { id, ok, rows | error }.
import sqlite3InitModule from "../vendor/sqlite-wasm/sqlite3.js";
import { runMigrations } from "./migrations.js";
import { wrapOo1 } from "./oo1.js";
import { MIGRATIONS } from "./schema.js";

const DB_FILE = "/memripal.sqlite3";

const bindOf = (params) => (params && params.length ? params : undefined);

async function open() {
  const sqlite3 = await sqlite3InitModule();
  const pool = await sqlite3.installOpfsSAHPoolVfs({ name: "memripal-sahpool" });
  const db = new pool.OpfsSAHPoolDb(DB_FILE);
  // A DbNewerError (db from a newer app) rejects dbPromise, so every request fails instead of using it.
  await runMigrations(wrapOo1(db), MIGRATIONS);
  return db;
}

const dbPromise = open();
// Open failures surface per request via the handler below; this only silences the unhandled rejection.
dbPromise.catch(() => {});

function handle(db, msg) {
  switch (msg.op) {
    case "exec":
      db.exec({ sql: msg.sql, bind: bindOf(msg.params) });
      return [];
    case "query":
      return db.selectObjects(msg.sql, bindOf(msg.params));
    case "transaction":
      db.transaction(() => {
        for (const s of msg.stmts) db.exec({ sql: s.sql, bind: bindOf(s.params) });
      });
      return [];
    default:
      throw new Error(`unknown op: ${msg.op}`);
  }
}

self.addEventListener("message", async ({ data }) => {
  try {
    const db = await dbPromise;
    self.postMessage({ id: data.id, ok: true, rows: handle(db, data) });
  } catch (err) {
    self.postMessage({ id: data.id, ok: false, error: String(err?.message ?? err) });
  }
});
