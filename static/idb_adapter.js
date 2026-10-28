// @ts-check
// IndexedDB key-value adapter (MEM-033): backs static/rehearsals.js and static/palace_store.js so
// records survive a reload. The factory is injected so tests can pass a fake.

/**
 * @param {IDBFactory | null | undefined} indexedDB
 * @param {{ dbName: string, storeName: string }} opts
 */
export function createIdbAdapter(indexedDB, { dbName, storeName }) {
  /** @type {Promise<IDBDatabase> | null} */
  let opened = null;

  // Cached so concurrent first ops share one open request. A throw inside the executor (missing
  // factory) becomes a rejection, so construction itself never throws.
  const open = () =>
    (opened ??= new Promise((resolve, reject) => {
      if (!indexedDB) throw new Error("IndexedDB unavailable");
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(storeName);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));

  /**
   * Resolves with the request's result on transaction complete (not request success), so a write is
   * only acknowledged once committed; a request error aborts the transaction and rejects here.
   * @param {IDBTransactionMode} mode
   * @param {(store: IDBObjectStore) => IDBRequest} op
   * @returns {Promise<any>}
   */
  const run = async (mode, op) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const req = op(tx.objectStore(storeName));
      tx.oncomplete = () => resolve(req.result);
      tx.onabort = () => reject(tx.error ?? req.error);
    });
  };

  return {
    /** @param {string} key */
    get: (key) => run("readonly", (s) => s.get(key)),
    /** @param {string} key @param {any} value @returns {Promise<void>} */
    put: async (key, value) => {
      await run("readwrite", (s) => s.put(value, key));
    },
    /** @param {string} key @returns {Promise<void>} */
    delete: (key) => run("readwrite", (s) => s.delete(key)),
    list: () => run("readonly", (s) => s.getAll()),
  };
}
