// @ts-check
// One-time localStorage -> IndexedDB move (MEM-039): records a MEM-033 store saved under its
// localStorage prefix before IndexedDB existed are copied into that store's adapter, then cleared.

/**
 * Copy-then-clear. A record already in IndexedDB wins; a malformed value is skipped and kept; the
 * prefix is cleared only once every get/put resolved, so any IndexedDB failure leaves localStorage
 * as it was for the next load to retry. Never rejects: page wiring runs whatever the outcome.
 * @param {() => Storage} getStorage may throw where storage is disabled
 * @param {string} prefix
 * @param {{get: (key: string) => Promise<any>, put: (key: string, value: any) => Promise<void>}} adapter
 * @returns {Promise<{copied: number, skipped: number, cleared: number}>}
 */
export async function migrateLocalStorage(getStorage, prefix, adapter) {
  let copied = 0;
  let skipped = 0;
  /** @type {Storage} */
  let storage;
  /** @type {string[]} names safe to remove: copied or already in IndexedDB */
  const done = [];
  try {
    storage = getStorage();
    const s = storage;
    // Snapshot first: removeItem shifts the indices key(i) walks.
    const names = Array.from({ length: s.length }, (_, i) => s.key(i)).filter(
      /** @returns {k is string} */ (k) => k !== null && k.startsWith(prefix),
    );
    for (const name of names) {
      let value;
      try {
        value = JSON.parse(/** @type {string} */ (s.getItem(name)));
      } catch {
        skipped += 1;
        continue;
      }
      const key = name.slice(prefix.length);
      if ((await adapter.get(key)) === undefined) {
        await adapter.put(key, value);
        copied += 1;
      }
      done.push(name);
    }
  } catch {
    return { copied, skipped, cleared: 0 };
  }
  for (const name of done) storage.removeItem(name);
  return { copied, skipped, cleared: done.length };
}
