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

// One database open per page, shared by every module (the Pal bubble, MEM-088): the lock is asked for and the
// worker started once. `open` is injected so tests can count calls. Only a "ready" result is kept for the page
// lifetime. A rejection is dropped so the next caller retries, and so is a resolved non-"ready" status
// ("locked": another tab owns the db), because that tab may close and a later ifAvailable request then succeeds;
// retrying a locked open is cheap (no wait, no worker). Callers sharing an in-flight open get the same promise.
export function createSharedOpen(open) {
  let cached = null;
  return function sharedOpen(deps) {
    if (cached) return cached;
    // open runs now (not a microtask later); a synchronous throw becomes a rejection, dropped like any failure.
    let p;
    try {
      p = Promise.resolve(open(deps));
    } catch (err) {
      p = Promise.reject(err);
    }
    cached = p;
    const drop = () => {
      if (cached === p) cached = null;
    };
    p.then((opened) => {
      if (opened?.status !== "ready") drop();
    }, drop);
    return p;
  };
}

export const sharedOpenDb = createSharedOpen(openDb);
