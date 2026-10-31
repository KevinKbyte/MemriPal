// @ts-check
// Route + station store (MEM-048, plan B3): a walked route and its 0-8 stations persist on the phone
// through the injected KV adapter (idb_adapter.js shape). Stations keep capture order; Finish walk's
// Save enforces 3-8 named stations. Coordinates are rounded to 4 dp (about 11 m) at write.

export { createCaptureSession } from "./route_capture.js";

/**
 * @typedef {{
 *   get: (key: string) => Promise<any>,
 *   put: (key: string, value: any) => Promise<void>,
 *   delete: (key: string) => Promise<void>,
 *   list: () => Promise<any[]>,
 * }} KvAdapter
 * @typedef {{ lat: number, lon: number }} Coords
 * @typedef {{ x1: number, y1: number, x2: number, y2: number }} Box
 * @typedef {{
 *   id: string, n: number, name: string, photo_ref: string, status: "pending" | "named" | "error",
 *   box?: Box, profile?: Record<string, string>, taps?: Record<string, string>, coords?: Coords,
 * }} Station
 * @typedef {{ id: string, name: string, status: "active" | "retired" }} RouteList
 * @typedef {{
 *   id: string, name: string, kind: "daily" | "occasional", status: "draft" | "saved", created_at: string,
 *   stations: Station[], lists: RouteList[],
 * }} Route
 */

export const MAX_STATIONS = 8;
export const MIN_SAVE_STATIONS = 3;
const KINDS = new Set(["daily", "occasional"]);
const ROUTE_KEY = (/** @type {string} */ id) => `route:${id}`;
const PHOTO_KEY = (/** @type {string} */ ref) => `photo:${ref}`;

/**
 * A KV write failed (e.g. quota). The in-memory change is kept; `value` is what the call would have
 * returned, so a caller can carry on with it.
 */
export class StorageError extends Error {
  /** @param {any} value @param {unknown} cause */
  constructor(value, cause) {
    super("could not save on this phone", { cause });
    this.name = "StorageError";
    this.value = value;
  }
}

/** @param {unknown} kind @returns {"daily" | "occasional"} */
function kindOf(kind) {
  if (!KINDS.has(/** @type {string} */ (kind))) throw new TypeError("kind must be daily or occasional");
  return /** @type {"daily" | "occasional"} */ (kind);
}

const round4 = (/** @type {number} */ v) => Math.round(v * 1e4) / 1e4;

/** @param {any} c @returns {Coords | null} null for anything that is not a finite lat/lon pair */
function coordsOf(c) {
  const lat = c?.lat, lon = c?.lon;
  const ok = Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  return ok ? { lat: round4(lat), lon: round4(lon) } : null;
}

/**
 * Finish walk's Save rule.
 * @param {Route} route
 * @returns {string | null} null when the route has 3-8 named stations and none pending, else why not
 */
export function finishSaveError(route) {
  const stations = route?.stations ?? [];
  if (stations.some((s) => s.status === "pending")) return "A station name is still pending. Retry or drop it first.";
  if (stations.some((s) => s.status !== "named")) return "A station could not be named. Drop it first.";
  if (stations.length < MIN_SAVE_STATIONS) return `A route needs at least ${MIN_SAVE_STATIONS} named stations.`;
  if (stations.length > MAX_STATIONS) return `A route holds at most ${MAX_STATIONS} stations.`;
  return null;
}

/**
 * @param {KvAdapter} adapter
 * @param {{ now?: () => number, newId?: () => string }} [opts]
 */
export function createRouteStore(adapter, { now = Date.now, newId = () => crypto.randomUUID() } = {}) {
  /** @type {Promise<Map<string, Route>> | null} */
  let loaded = null;
  /** Photos written by this store instance; others are read from the adapter on demand. */
  const photos = new Map();
  /** @type {{ route: Route, photos: Map<string, any> } | null} */
  let lastDeleted = null;
  /** @type {Map<string, { station: Station, index: number, photo: any }>} */
  const lastDrop = new Map();
  /** @type {Promise<void>} */
  let tail = Promise.resolve();

  // The cache answers reads, so a station whose KV write failed is still listed this session.
  const routes = () =>
    (loaded ??= adapter.list().then((values) => {
      const map = new Map();
      for (const v of values) if (v?.type === "route" && v.route?.id) map.set(v.route.id, v.route);
      return map;
    }));

  /**
   * Serialises mutations so each read-modify-write and its KV writes land in call order.
   * @template T @param {() => Promise<T>} fn @returns {Promise<T>}
   */
  const serial = (fn) => {
    const run = tail.then(fn);
    tail = run.then(() => {}, () => {});
    return run;
  };

  /** @template T @param {T} value @param {Array<() => Promise<void>>} writes @returns {Promise<T>} */
  const persist = async (value, writes) => {
    try {
      for (const w of writes) await w();
    } catch (err) {
      throw new StorageError(value, err);
    }
    return value;
  };

  const putRoute = (/** @type {Route} */ r) => () => adapter.put(ROUTE_KEY(r.id), { type: "route", route: r });
  const putPhoto = (/** @type {string} */ ref, /** @type {any} */ bytes) => () => {
    photos.set(ref, bytes);
    return adapter.put(PHOTO_KEY(ref), { type: "photo", bytes });
  };
  const dropPhoto = (/** @type {string} */ ref) => () => {
    photos.delete(ref);
    return adapter.delete(PHOTO_KEY(ref));
  };

  /** @param {string} id @returns {Promise<Route>} */
  const mustGet = async (id) => {
    const r = (await routes()).get(id);
    if (!r) throw new Error(`no route ${id}`);
    return r;
  };

  /** @param {Route} r @param {string} stationId */
  const indexOf = (r, stationId) => {
    const i = r.stations.findIndex((s) => s.id === stationId);
    if (i < 0) throw new Error(`no station ${stationId}`);
    return i;
  };

  const clone = /** @type {<T>(v: T) => T} */ ((v) => structuredClone(v));

  /** @param {string} ref */
  const getPhoto = async (ref) => {
    if (photos.has(ref)) return photos.get(ref);
    return (await adapter.get(PHOTO_KEY(ref)))?.bytes ?? null;
  };

  return {
    /** @param {{ name?: string, kind?: string }} [init] @returns {Promise<Route>} */
    createRoute: ({ name = "", kind = "daily" } = {}) => serial(async () => {
      /** @type {Route} */
      const r = {
        id: newId(), name: String(name).trim(), kind: kindOf(kind), status: "draft",
        created_at: new Date(now()).toISOString(), stations: [], lists: [],
      };
      (await routes()).set(r.id, r);
      return persist(clone(r), [putRoute(r)]);
    }),

    /** @returns {Promise<Route[]>} */
    listRoutes: async () => [...(await routes()).values()].map(clone),

    /** @param {string} id @returns {Promise<Route | null>} */
    getRoute: async (id) => {
      const r = (await routes()).get(id);
      return r ? clone(r) : null;
    },

    /** @param {string} id @param {{ name?: string, kind?: string }} patch */
    updateRoute: (id, { name, kind }) => serial(async () => {
      const r = await mustGet(id);
      if (kind !== undefined) r.kind = kindOf(kind);
      if (name !== undefined) r.name = String(name).trim();
      return persist(clone(r), [putRoute(r)]);
    }),

    /** @param {string} id */
    deleteRoute: (id) => serial(async () => {
      const r = await mustGet(id);
      const held = new Map();
      for (const s of r.stations) held.set(s.photo_ref, await getPhoto(s.photo_ref));
      lastDeleted = { route: r, photos: held };
      (await routes()).delete(id);
      await persist(null, [() => adapter.delete(ROUTE_KEY(id)), ...r.stations.map((s) => dropPhoto(s.photo_ref))]);
    }),

    /** Restores the last deleted route; null when there is nothing to undo. */
    undoDelete: () => serial(async () => {
      if (!lastDeleted) return null;
      const { route: r, photos: held } = lastDeleted;
      lastDeleted = null;
      (await routes()).set(r.id, r);
      const writes = [...held].map(([ref, bytes]) => putPhoto(ref, bytes));
      return persist(clone(r), [...writes, putRoute(r)]);
    }),

    /**
     * Writes the (already re-encoded) photo and a pending station; the 9th station is refused.
     * @param {string} routeId @param {{ photo: any, coords?: unknown }} input @returns {Promise<Station>}
     */
    addStation: (routeId, { photo, coords }) => serial(async () => {
      const r = await mustGet(routeId);
      if (r.stations.length >= MAX_STATIONS) throw new RangeError(`a route holds at most ${MAX_STATIONS} stations`);
      const n = r.stations.reduce((max, s) => Math.max(max, s.n), 0) + 1;
      /** @type {Station} */
      const st = { id: newId(), n, name: "", photo_ref: newId(), status: "pending" };
      const c = coordsOf(coords);
      if (c) st.coords = c;
      r.stations.push(st);
      return persist(clone(st), [putPhoto(st.photo_ref, photo), putRoute(r)]);
    }),

    getPhoto,

    /**
     * @param {string} routeId @param {string} stationId
     * @param {{ name: string, profile?: Record<string, string>, box?: Box, photo?: any }} named
     * @returns {Promise<Station>}
     */
    nameStation: (routeId, stationId, { name, profile, box, photo }) => serial(async () => {
      const r = await mustGet(routeId);
      const st = r.stations[indexOf(r, stationId)];
      st.status = "named";
      st.name = String(name).trim();
      if (profile) st.profile = profile;
      if (box) st.box = box;
      const writes = photo === undefined ? [] : [putPhoto(st.photo_ref, photo)];
      return persist(clone(st), [...writes, putRoute(r)]);
    }),

    /** S3 name edit (MEM-050); the card validates the name first. */
    renameStation: (/** @type {string} */ routeId, /** @type {string} */ stationId, /** @type {string} */ name) =>
      serial(async () => {
        const r = await mustGet(routeId);
        const st = r.stations[indexOf(r, stationId)];
        st.name = String(name).trim();
        return persist(clone(st), [putRoute(r)]);
      }),

    /** S3 quick-taps (MEM-050): replaces the station's taps, one label per group. */
    setStationTaps: (/** @type {string} */ routeId, /** @type {string} */ stationId, /** @type {Record<string, string>} */ taps) =>
      serial(async () => {
        const r = await mustGet(routeId);
        const st = r.stations[indexOf(r, stationId)];
        st.taps = { ...taps };
        return persist(clone(st), [putRoute(r)]);
      }),

    /** @param {string} routeId @param {string} stationId @param {"pending" | "error"} status */
    setStationStatus: (routeId, stationId, status) => serial(async () => {
      if (status !== "pending" && status !== "error") throw new TypeError(`bad station status ${status}`);
      const r = await mustGet(routeId);
      const st = r.stations[indexOf(r, stationId)];
      st.status = status;
      return persist(clone(st), [putRoute(r)]);
    }),

    /** Drops are never refused; undoDrop(routeId) puts the last one back at the same position. */
    dropStation: (/** @type {string} */ routeId, /** @type {string} */ stationId) => serial(async () => {
      const r = await mustGet(routeId);
      const index = indexOf(r, stationId);
      const [station] = r.stations.splice(index, 1);
      lastDrop.set(routeId, { station, index, photo: await getPhoto(station.photo_ref) });
      await persist(null, [putRoute(r), dropPhoto(station.photo_ref)]);
    }),

    /** @param {string} routeId @returns {Promise<Station | null>} */
    undoDrop: (routeId) => serial(async () => {
      const held = lastDrop.get(routeId);
      if (!held) return null;
      const r = await mustGet(routeId);
      if (r.stations.length >= MAX_STATIONS) throw new RangeError(`a route holds at most ${MAX_STATIONS} stations`);
      lastDrop.delete(routeId);
      r.stations.splice(Math.min(held.index, r.stations.length), 0, held.station);
      return persist(clone(held.station), [putPhoto(held.station.photo_ref, held.photo), putRoute(r)]);
    }),

    /** Up (-1) / Down (+1) swaps with the neighbour; a move past either end is a no-op. */
    moveStation: (/** @type {string} */ routeId, /** @type {string} */ stationId, /** @type {number} */ delta) =>
      serial(async () => {
        const r = await mustGet(routeId);
        const i = indexOf(r, stationId);
        const j = i + (delta < 0 ? -1 : 1);
        if (j < 0 || j >= r.stations.length) return clone(r);
        [r.stations[i], r.stations[j]] = [r.stations[j], r.stations[i]];
        return persist(clone(r), [putRoute(r)]);
      }),

    /** @param {string} routeId @param {{ name?: string, kind?: string }} fields */
    finishSave: (routeId, { name, kind }) => serial(async () => {
      const r = await mustGet(routeId);
      const err = finishSaveError(r);
      if (err) throw new Error(err);
      r.kind = kindOf(kind ?? r.kind);
      const trimmed = String(name ?? "").trim();
      if (trimmed) r.name = trimmed;
      r.status = "saved";
      return persist(clone(r), [putRoute(r)]);
    }),
  };
}

/**
 * Finish-walk row drop: Drop arms, Confirm drops, Cancel disarms, Undo restores.
 * @param {ReturnType<typeof createRouteStore>} store
 * @param {string} routeId
 */
export function createFinishReview(store, routeId) {
  /** @type {string | null} */
  let armedId = null;
  let undoable = false;
  return {
    arm: (/** @type {string} */ stationId) => {
      armedId = stationId;
    },
    armed: () => armedId,
    cancel: () => {
      armedId = null;
    },
    confirm: async () => {
      if (armedId === null) return;
      const id = armedId;
      armedId = null;
      await store.dropStation(routeId, id);
      undoable = true;
    },
    undo: async () => {
      if (!undoable) return;
      undoable = false;
      await store.undoDrop(routeId);
    },
    canUndo: () => undoable,
  };
}
