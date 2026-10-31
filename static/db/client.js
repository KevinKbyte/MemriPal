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
  worker.addEventListener("error", (ev) => {
    const err = new Error(`db worker error: ${ev?.message ?? "unknown"}`);
    for (const entry of pending.values()) entry.reject(err);
    pending.clear();
  });

  const send = (msg) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, ...msg });
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
