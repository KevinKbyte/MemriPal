// Shared fakes for the route store tests (MEM-048). Not a test file itself (no describe/test); the
// route_store*.test.mjs files import it.

let adapterFactory = null;

/**
 * Swaps what memoryAdapter() returns (S2 matrix runners re-run the route store tests over the SQL
 * adapter). f: () => KvAdapter with a `state.failPuts` flag; null restores the Map-backed fake.
 */
export function setAdapterFactory(f) {
  adapterFactory = f;
}

/** Key-value adapter shaped like idb_adapter.js, backed by a Map; clones like structured-clone storage. */
export function memoryAdapter() {
  if (adapterFactory) return adapterFactory();
  const map = new Map();
  const state = { failPuts: false };
  return {
    map,
    state,
    async get(key) {
      return map.has(key) ? structuredClone(map.get(key)) : undefined;
    },
    async put(key, value) {
      if (state.failPuts) {
        const err = new Error("The quota has been exceeded.");
        err.name = "QuotaExceededError";
        throw err;
      }
      map.set(key, structuredClone(value));
    },
    async delete(key) {
      map.delete(key);
    },
    async list() {
      return [...map.values()].map((v) => structuredClone(v));
    },
  };
}

export const tick = () => new Promise((r) => setImmediate(r));

export async function flush(n = 10) {
  for (let i = 0; i < n; i++) await tick();
}

export function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Normalises whatever the store hands back for a photo (Uint8Array, ArrayBuffer, Blob) to bytes. */
export async function toBytes(photo) {
  if (photo == null) return null;
  if (photo instanceof Uint8Array) return photo;
  if (photo instanceof ArrayBuffer) return new Uint8Array(photo);
  if (typeof photo.arrayBuffer === "function") return new Uint8Array(await photo.arrayBuffer());
  throw new TypeError(`unexpected photo value ${Object.prototype.toString.call(photo)}`);
}

/** True when the bytes carry an EXIF APP1 segment (0xFFE1 marker or the "Exif\0\0" header). */
export function hasExif(bytes) {
  for (let i = 0; i + 1 < bytes.length; i++) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0xe1) return true;
  }
  const ascii = Buffer.from(bytes).toString("latin1");
  return ascii.includes("Exif\0\0");
}

const ascii = (s) => [...s].map((c) => c.charCodeAt(0));

/** A camera JPEG: SOI, an APP1 EXIF segment with a GPS tag name, then a tiny body and EOI. */
export const RAW_CAMERA = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe1, 0x00, 0x18, ...ascii("Exif\0\0"), ...ascii("GPSLatitude!"), 0xff, 0xdb, 0x01,
  0xff, 0xd9,
]);
/** What the canvas re-encode produces: no APP1 segment. */
export const ENCODED = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x03, 0x07, 0xff, 0xd9]);
/** The server's pixelated JPEG. */
export const PIXELATED = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x03, 0x42, 0x42, 0xff, 0xd9]);

/** Fake re-encode (stands in for app.js reencodeJpeg): drops EXIF. Records what it was given. */
export function fakeEncode() {
  const seen = [];
  const encode = async (raw) => {
    seen.push(raw);
    return ENCODED.slice();
  };
  return { encode, seen };
}

export const rawFile = () => ({ name: "station.jpg", type: "image/jpeg", bytes: RAW_CAMERA.slice() });

export function stationOk(name = "Red door") {
  return new Response(
    JSON.stringify({
      image: "data:image/jpeg;base64," + Buffer.from(PIXELATED).toString("base64"),
      width: 800,
      height: 600,
      photo_sha: "a".repeat(64),
      name,
      profile: { visual: "a red door", spatial: "left of the path", conceptual: "entry" },
      box: { x1: 10, y1: 20, x2: 110, y2: 220 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

export function stationError(status, code) {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * fetch spy: every call is recorded; each call is answered by the next responder in `plan` (a
 * function returning a Response or a promise; throwing rejects like a network error).
 */
export function fetchSpy(plan) {
  const calls = [];
  const queue = [...plan];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), method: String(init.method ?? "GET").toUpperCase(), init });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected fetch #${calls.length} to ${url}`);
    return next();
  };
  return { fn, calls };
}
