// Sync db shape { exec, query, transaction(fn) } over a raw sqlite-wasm oo1.DB: what runMigrations
// needs. Shared by the browser worker (OPFS db) and the node test driver (in-memory db).

function bindOf(params) {
  return params && params.length ? params : undefined;
}

export function wrapOo1(raw) {
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
        // SQLite may already have rolled back by itself (SQLITE_FULL, SQLITE_IOERR); a failing cleanup
        // ROLLBACK then must not mask fn's error, which is the one the caller needs.
        try {
          raw.exec("ROLLBACK");
        } catch {
          // no transaction left to roll back
        }
        throw err;
      }
    },
  };
}
