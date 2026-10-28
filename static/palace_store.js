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

// Not a JSON array, so no associationKey(item, label) can ever equal it.
const ROUTE_KEY = "route";

/**
 * Browser key-value adapter over localStorage, a stand-in until the IndexedDB adapter lands. Values
 * are JSON-encoded under `prefix`, so palace and rehearsal records share the origin without colliding.
 * Storage is read lazily: merely touching window.localStorage throws where storage is disabled.
 * @param {string} prefix
 * @param {() => Storage} [storage]
 */
export function localStorageAdapter(prefix, storage = () => localStorage) {
  return {
    /** @param {string} key */
    get: async (key) => {
      const raw = storage().getItem(prefix + key);
      return raw === null ? undefined : JSON.parse(raw);
    },
    /** @param {string} key @param {any} value */
    put: async (key, value) => storage().setItem(prefix + key, JSON.stringify(value)),
    /** @param {string} key */
    delete: async (key) => storage().removeItem(prefix + key),
    list: async () => {
      const s = storage();
      const keys = Array.from({ length: s.length }, (_, i) => s.key(i)).filter((k) => k !== null && k.startsWith(prefix));
      return keys.map((k) => JSON.parse(/** @type {string} */ (s.getItem(/** @type {string} */ (k)))));
    },
  };
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
    /**
     * The reviewed route order (MEM-030), so a reload walks the same route.
     * @param {any[]} loci
     */
    async saveRoute(loci) {
      if (!Array.isArray(loci)) throw new TypeError("route must be an array of loci");
      await adapter.put(ROUTE_KEY, loci);
    },
    /** @returns {Promise<any[] | null>} the saved route, or null when none was saved */
    async loadRoute() {
      const loci = await adapter.get(ROUTE_KEY);
      return Array.isArray(loci) ? loci : null;
    },
  };
}
