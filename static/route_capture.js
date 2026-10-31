// @ts-check
// Walk capture session (MEM-048, plan B3 D10): a captured station is never lost to a bad network.
// The re-encoded photo is stored as a pending station BEFORE the POST /station upload; success names
// it, a network error / 5xx / 429 keeps it pending for a manual Retry, any other 4xx marks it error
// (Drop offered). One in-flight request per station, no automatic retry.

import { apiUrl } from "./api_base.js";

const MAX_NAME = 40;
const MAX_LINE = 200;
const JPEG_DATA_URL = "data:image/jpeg;base64,";

const MSG = {
  naming: "Naming the landmark...",
  offline: "Saved on this phone. Tap Retry when you are back online.",
  busy: "The naming service is busy. Tap Retry in a moment.",
  rejected: "This photo could not be used. Drop it and capture again.",
  unreadable: "Could not read that photo. Try capturing again.",
  storage: "Could not save this station on the phone (storage is full?). Keep this page open.",
  failed: "Something went wrong. Tap Retry.",
};

/** @param {unknown} v @param {number} max */
const text = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** @param {unknown} v @returns {Uint8Array | null} the decoded JPEG, or null for anything else */
function jpegOf(v) {
  if (typeof v !== "string" || !v.startsWith(JPEG_DATA_URL)) return null;
  try {
    const bin = atob(v.slice(JPEG_DATA_URL.length));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8 ? bytes : null;
  } catch {
    return null;
  }
}

/** @param {any} b */
function boxOf(b) {
  const keys = ["x1", "y1", "x2", "y2"];
  if (!b || !keys.every((k) => Number.isFinite(b[k]))) return undefined;
  return { x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 };
}

/** @param {any} p */
function profileOf(p) {
  if (!p || typeof p !== "object") return undefined;
  return { visual: text(p.visual, MAX_LINE), spatial: text(p.spatial, MAX_LINE), conceptual: text(p.conceptual, MAX_LINE) };
}

/**
 * The server reply is untrusted: only a JPEG data URL and a non-empty name name a station.
 * @param {any} body
 */
function namedOf(body) {
  const photo = jpegOf(body?.image);
  const name = text(body?.name, MAX_NAME);
  if (!photo || !name) return null;
  return { name, photo, profile: profileOf(body.profile), box: boxOf(body.box) };
}

/**
 * @param {{
 *   store: ReturnType<typeof import("./route_store.js").createRouteStore>,
 *   routeId: string,
 *   fetch: typeof fetch,
 *   encode: (file: any) => Promise<any>,
 *   onStatus?: (text: string) => void,
 * }} deps
 */
export function createCaptureSession({ store, routeId, fetch, encode, onStatus = () => {} }) {
  /** @type {Set<string>} */
  const inFlight = new Set();
  let capturing = false;
  /** Once a KV write fails, later "saved on this phone" copy would be untrue. */
  let storageFailed = false;

  /** A KV failure keeps the in-memory result; anything else propagates. */
  const kept = async (/** @type {Promise<any>} */ p) => {
    try {
      return await p;
    } catch (err) {
      if (/** @type {any} */ (err)?.name !== "StorageError") throw err;
      storageFailed = true;
      onStatus(MSG.storage);
      return /** @type {any} */ (err).value;
    }
  };

  const pending = (/** @type {string} */ msg) => onStatus(storageFailed ? MSG.storage : msg);

  /** @param {string} stationId */
  async function upload(stationId) {
    const photo = await store.getPhoto(
      (await store.getRoute(routeId))?.stations.find((s) => s.id === stationId)?.photo_ref ?? "",
    );
    onStatus(MSG.naming);
    let res;
    try {
      res = await fetch(apiUrl("/station"), { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: photo });
    } catch {
      return pending(MSG.offline);
    }
    if (res.status >= 500 || res.status === 429) return pending(MSG.busy);
    if (!res.ok) {
      await kept(store.setStationStatus(routeId, stationId, "error"));
      return onStatus(MSG.rejected);
    }
    const named = namedOf(await res.json().catch(() => null));
    if (!named) return pending(MSG.busy);
    await kept(store.nameStation(routeId, stationId, named));
    if (!storageFailed) onStatus(`Named: ${named.name}`);
  }

  /** @param {string} stationId */
  async function guarded(stationId) {
    if (inFlight.has(stationId)) return;
    inFlight.add(stationId);
    try {
      await upload(stationId);
    } catch {
      onStatus(MSG.failed);
    } finally {
      inFlight.delete(stationId);
    }
  }

  return {
    /** @param {any} file @param {{ coords?: unknown }} [opts] */
    async capture(file, { coords } = {}) {
      if (capturing || inFlight.size > 0) return null;
      capturing = true;
      try {
        let photo;
        try {
          photo = await encode(file);
        } catch {
          onStatus(MSG.unreadable);
          return null;
        }
        const station = await kept(store.addStation(routeId, { photo, coords }));
        const upload = guarded(station.id);
        capturing = false;
        await upload;
        return (await store.getRoute(routeId))?.stations.find((s) => s.id === station.id) ?? station;
      } catch {
        onStatus(MSG.failed);
        return null;
      } finally {
        capturing = false;
      }
    },
    /** @param {string} stationId */
    retry: (stationId) => guarded(stationId),
    busy: () => capturing || inFlight.size > 0,
  };
}
