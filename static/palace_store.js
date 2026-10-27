// @ts-check
// Palace record store (MEM-022): association records keyed by item + locus label, persisted through
// an injected key-value adapter (IndexedDB in the browser, an in-memory Map under node --test).

/**
 * @typedef {{
 *   get: (key: string) => Promise<any>,
 *   put: (key: string, value: any) => Promise<void>,
 *   list: () => Promise<any[]>,
 * }} PalaceAdapter
 */

/**
 * D3: the locus short label is part of the key. JSON array encoding escapes every separator, so
 * distinct (item, label) pairs can never collide.
 * @param {string} item
 * @param {string} locusLabel
 * @returns {string}
 */
export function associationKey(item, locusLabel) {
  return JSON.stringify([item, locusLabel]);
}

/**
 * @param {PalaceAdapter} adapter
 */
export function createPalaceStore(adapter) {
  return {
    /** @param {string} key */
    async get(key) {
      return adapter.get(key);
    },
    /**
     * Settles only once the adapter has stored the entry, so an ack means the record is durable.
     * @param {string} key
     * @param {any} entry
     */
    async put(key, entry) {
      if (typeof key !== "string" || key === "") throw new TypeError("palace key must be a non-empty string");
      await adapter.put(key, entry);
    },
    async list() {
      return adapter.list();
    },
  };
}
