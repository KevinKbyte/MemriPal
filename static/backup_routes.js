// @ts-check
// Backup v2 routes (MEM-054, ADR 0032): what of a walked route leaves the phone, and the import-side
// check of a file's routes. Both sides use the same per-field allowlists, so coordinates, timestamps,
// baselines and any field added to the store later never reach a backup or the store from one.

import { MAX_STATIONS, MIN_SAVE_STATIONS } from "./route_store.js";

const THUMB = { maxSide: 640, quality: 0.7 };
const ROUTE_KEYS = ["id", "name", "kind", "created_at", "stations", "lists"];
const STATION_KEYS = ["id", "n", "name", "status", "box", "profile", "taps", "photo"];
const LIST_KEYS = ["id", "name", "status"];
const BOX_KEYS = ["x1", "y1", "x2", "y2"];
// route_capture.js profileOf; the four sensory taps of a station.
const PROFILE_KEYS = ["visual", "spatial", "conceptual"];
const TAP_KEYS = ["sound", "smell", "feel", "mood"];
const KINDS = ["daily", "occasional"];
const LIST_STATUSES = ["active", "retired"];
const NAME_MAX = 100;
const LINE_MAX = 200; // route_capture.js MAX_LINE
const JPEG_PREFIX = "data:image/jpeg;base64,";
const JPEG_URL_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * @typedef {ReturnType<typeof import("./route_store.js").createRouteStore>} RouteStore
 * @typedef {(photo: any, opts: {maxSide: number, quality: number}) =>
 *   Promise<{bytes: any, width: number, height: number, sourceWidth: number, sourceHeight: number}>} Thumbnail
 * @typedef {(src: string) => Promise<{naturalWidth: number, naturalHeight: number}>} LoadImage
 */

/** @param {unknown} v @returns {v is Record<string, any>} */
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** @param {Record<string, any>} obj @param {string[]} keys exactly these own keys */
const exactKeys = (obj, keys) => {
  const own = Object.keys(obj);
  return own.length === keys.length && keys.every((k) => own.includes(k));
};

/** @param {unknown} v @param {number} max */
const shortText = (v, max) => typeof v === "string" && v.trim() !== "" && v.trim().length <= max;

/** @param {unknown} v */
const finite = (v) => typeof v === "number" && Number.isFinite(v);

/** @param {any} v @returns {Promise<Uint8Array>} */
async function bytesOf(v) {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return new Uint8Array(await v.arrayBuffer());
}

/** @param {Uint8Array} bytes */
function base64(bytes) {
  let bin = "";
  // Chunked: String.fromCharCode(...all) overflows the argument limit on a photo-sized array.
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * The allowlisted string fields of `v`, or null when it has none of them.
 * @param {unknown} v @param {string[]} keys
 */
function stringsOf(v, keys) {
  if (!isObject(v)) return null;
  const out = Object.fromEntries(keys.filter((k) => typeof v[k] === "string").map((k) => [k, v[k]]));
  return Object.keys(out).length ? out : null;
}

/**
 * Export side: one named station, its stored photo re-encoded to the thumbnail and its box scaled to it.
 * @param {RouteStore} routes @param {Thumbnail} thumbnail @param {any} st
 */
async function stationOut(routes, thumbnail, st) {
  const t = await thumbnail(await routes.getPhoto(st.photo_ref), { ...THUMB });
  const kx = t.width / t.sourceWidth;
  const ky = t.height / t.sourceHeight;
  /** @param {number} v @param {number} k @param {number} max */
  const fit = (v, k, max) => Math.min(max, Math.max(0, Math.round(v * k)));
  const b = st.box;
  const box = isObject(b) && BOX_KEYS.every((k) => finite(b[k]))
    ? { x1: fit(b.x1, kx, t.width), y1: fit(b.y1, ky, t.height), x2: fit(b.x2, kx, t.width), y2: fit(b.y2, ky, t.height) }
    : null;
  return {
    id: st.id,
    n: st.n,
    name: st.name,
    status: "named",
    box,
    profile: stringsOf(st.profile, PROFILE_KEYS),
    taps: stringsOf(st.taps, TAP_KEYS),
    photo: JPEG_PREFIX + base64(await bytesOf(t.bytes)),
  };
}

/**
 * E1 (v2): every saved route, named stations only; pending / error stations and drafts never leave.
 * @param {RouteStore | undefined} routes @param {Thumbnail} thumbnail
 */
export async function exportRoutes(routes, thumbnail) {
  if (!routes) return [];
  const out = [];
  for (const r of await routes.listRoutes()) {
    if (r.status !== "saved") continue;
    const stations = [];
    for (const st of r.stations) if (st.status === "named") stations.push(await stationOut(routes, thumbnail, st));
    const lists = (r.lists ?? []).map((/** @type {any} */ l) => ({ id: l.id, name: l.name, status: l.status }));
    out.push({ id: r.id, name: r.name, kind: r.kind, created_at: r.created_at, lists, stations });
  }
  return out;
}

/** @param {string} t */
function isoRoundTrips(t) {
  const d = new Date(t);
  return !Number.isNaN(d.getTime()) && d.toISOString() === t;
}

/**
 * Import side: an allowlisted string map (profile / taps) or null; throws on anything else.
 * @param {unknown} v @param {string[]} keys @param {string} what
 */
function stringMapIn(v, keys, what) {
  if (v === null) return null;
  const ok = isObject(v) && Object.keys(v).every((k) => keys.includes(k))
    && Object.values(v).every((x) => typeof x === "string" && x.length <= LINE_MAX);
  if (!ok) throw new Error(`bad station ${what}`);
  return Object.fromEntries(keys.filter((k) => k in v).map((k) => [k, v[k]]));
}

/**
 * Import side: one station checked and its photo decoded; the photo comes back as bytes.
 * @param {unknown} st @param {LoadImage} loadImage
 */
async function stationIn(st, loadImage) {
  if (!isObject(st) || !exactKeys(st, STATION_KEYS)) throw new Error("bad station");
  const { id, n, name, status, box, profile, taps, photo } = st;
  if (typeof id !== "string" || !UUID_RE.test(id) || !Number.isInteger(n) || n < 1) throw new Error("bad station");
  if (!shortText(name, NAME_MAX) || status !== "named") throw new Error("bad station");
  // Checked before decode, so no other scheme (javascript:, http:, png) ever reaches loadImage.
  if (typeof photo !== "string" || !JPEG_URL_RE.test(photo)) throw new Error("station photo is not a JPEG");
  /** @type {{naturalWidth: number, naturalHeight: number}} */
  let img;
  try {
    img = await loadImage(photo);
  } catch {
    throw new Error("station photo does not decode");
  }
  let boxOut = null;
  if (box !== null) {
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const ok = isObject(box) && exactKeys(box, BOX_KEYS) && BOX_KEYS.every((k) => finite(box[k]))
      && box.x1 >= 0 && box.y1 >= 0 && box.x1 <= box.x2 && box.y1 <= box.y2 && box.x2 <= w && box.y2 <= h;
    if (!ok) throw new Error("station box is outside its photo");
    boxOut = { x1: box.x1, y1: box.y1, x2: box.x2, y2: box.y2 };
  }
  const bytes = Uint8Array.from(atob(photo.slice(JPEG_PREFIX.length)), (c) => c.charCodeAt(0));
  return {
    id, n, name, box: boxOut,
    profile: stringMapIn(profile, PROFILE_KEYS, "profile"),
    taps: stringMapIn(taps, TAP_KEYS, "taps"),
    photo: bytes,
  };
}

/**
 * Import side: one route checked whole, ready for RouteStore.restoreRoute; throws on any failure.
 * @param {unknown} r @param {LoadImage} loadImage
 */
async function routeIn(r, loadImage) {
  if (!isObject(r) || !exactKeys(r, ROUTE_KEYS)) throw new Error("bad route");
  const { id, name, kind, created_at, stations, lists } = r;
  if (typeof id !== "string" || !UUID_RE.test(id) || typeof name !== "string" || name.length > NAME_MAX) throw new Error("bad route");
  if (!KINDS.includes(kind) || typeof created_at !== "string" || !isoRoundTrips(created_at)) throw new Error("bad route");
  if (!Array.isArray(lists) || !Array.isArray(stations)) throw new Error("bad route");
  const listsOut = lists.map((l) => {
    const ok = isObject(l) && exactKeys(l, LIST_KEYS) && typeof l.id === "string" && UUID_RE.test(l.id)
      && shortText(l.name, NAME_MAX) && LIST_STATUSES.includes(l.status);
    if (!ok) throw new Error("bad route list");
    return { id: l.id, name: l.name, status: l.status };
  });
  if (stations.length < MIN_SAVE_STATIONS || stations.length > MAX_STATIONS) throw new Error("bad route: station count");
  const out = [];
  for (const st of stations) out.push(await stationIn(st, loadImage));
  if (new Set(out.map((s) => s.id)).size !== out.length) throw new Error("bad route: duplicate station");
  return { id, name, kind, created_at, lists: listsOut, stations: out };
}

/**
 * Every route of a file checked before anything is written (whole-file refusal).
 * @param {unknown[]} routes @param {LoadImage} loadImage
 */
export async function importRoutes(routes, loadImage) {
  const out = [];
  for (const r of routes) out.push(await routeIn(r, loadImage));
  return out;
}
