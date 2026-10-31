// Page-side handle to the SQLite worker. One tab owns the database via the "memripal-db" Web Lock.

function rpc(worker) {
  const pending = new Map();
  let nextId = 1;

  worker.addEventListener("message", ({ data }) => {
    const entry = pending.get(data?.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.ok) entry.resolve(data.rows);
    else entry.reject(new Error(data.error));
  });
  const rejectAll = (err) => {
    for (const entry of pending.values()) entry.reject(err);
    pending.clear();
  };
  worker.addEventListener("error", (ev) => rejectAll(new Error(`db worker error: ${ev?.message ?? "unknown"}`)));
  // An undeserializable reply carries no id, so every in-flight request is failed rather than left hanging.
  worker.addEventListener("messageerror", () => rejectAll(new Error("db worker messageerror: reply could not be deserialized")));

  const send = (msg) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      try {
        worker.postMessage({ id, ...msg });
      } catch (err) {
        pending.delete(id);
        reject(err);
      }
    });

  return {
    exec: (sql, params = []) => send({ op: "exec", sql, params }),
    query: (sql, params = []) => send({ op: "query", sql, params }),
    // Statements, not a callback: a JS function cannot cross postMessage.
    transaction: (stmts) => send({ op: "transaction", stmts }),
  };
}

export function openDb({ locks, createWorker }) {
  return new Promise((resolve, reject) => {
    locks
      .request("memripal-db", { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve({ status: "locked" });
          return undefined;
        }
        resolve({ status: "ready", db: rpc(createWorker()) });
        // Never settles: the lock is held for the page lifetime and released on unload.
        return new Promise(() => {});
      })
      .catch(reject);
  });
}
