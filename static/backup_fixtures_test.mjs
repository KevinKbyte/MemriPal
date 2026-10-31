// Shared fixtures for the MEM-042 / MEM-054 palace backup tests (palace_export*.test.mjs). Not a
// test file itself (no describe/test); the *.test.mjs files import it.

import { associationKey, createPalaceStore } from "./palace_store.js";
import { createRehearsalStore } from "./rehearsals.js";
import { createRouteStore } from "./route_store.js";
import { toBytes } from "./route_store_fakes_test.mjs";

/** The 15 associate.py FIELDS, restated independently of the code under test. */
export const FIELDS = [
  "item", "locus",
  "kinesthetic", "auditory", "visual", "emotional", "conceptual", "olfactory", "gustatory", "spatial",
  "scene_prompt_details", "walk_cue", "reencode_hint", "question", "answer",
];

export const SIG = "ab".repeat(32);

/** A record with exactly the 15 FIELDS, every one a non-blank string. */
export function fullRecord(item, locus, overrides = {}) {
  const r = {};
  for (const f of FIELDS) r[f] = `${f} of ${item} at ${locus}`;
  r.item = item;
  r.locus = locus;
  return { ...r, ...overrides };
}

export function entry(item, locus, extra = {}) {
  return { record: fullRecord(item, locus), status: "valid", sig: SIG, ...extra };
}

/** One /loci locus with exactly the app.py _locus_json keys. */
export function locus(n, label) {
  return {
    n,
    label,
    phrase: `the ${label} by the wall`,
    box: { x1: 10 * n, y1: 20, x2: 10 * n + 50, y2: 120.5 },
    outline: [[10 * n, 20], [10 * n + 50, 20], [10 * n + 50, 120.5]],
  };
}

export const POINT = { label: "Lamp point", source_quote: "Quote one", got: true, override: false, span: "said one" };

let seq = 0;
/** A lowercase UUID, deterministic per call. */
export function uuid() {
  seq += 1;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
}

export function rehearsal(extra = {}) {
  return {
    id: uuid(),
    palace_id: "demo",
    timestamp: new Date(Date.UTC(2026, 9, 28, 9, 0, seq)).toISOString(),
    transcript: "the lamp point",
    points: [{ ...POINT }],
    ...extra,
  };
}

/** MEM-054 (plan B9): the v2 envelope, the only format import accepts. */
export function backup(extra = {}) {
  return { v: 2, routes: [], lists: [], associations: [], rehearsals: [], ...extra };
}

/** The MEM-042 v1 envelope; since plan D6 / B9 crit 7 it is the "not supported" case. */
export function backupV1(extra = {}) {
  return { v: 1, palace_id: "demo", route: [], associations: [], rehearsals: [], ...extra };
}

/** Key-value adapter with delete (rehearsal stores need it); values deep-copied like IndexedDB. */
export function kv() {
  const map = new Map();
  return {
    map,
    get: async (k) => (map.has(k) ? structuredClone(map.get(k)) : undefined),
    put: async (k, v) => void map.set(k, structuredClone(v)),
    delete: async (k) => void map.delete(k),
    list: async () => [...map.values()].map((v) => structuredClone(v)),
  };
}

/**
 * Fresh empty palace + rehearsal + route stores over their own adapters, plus the two image seams
 * the v2 backup takes: thumbnail (fakeThumbnail) and loadImage (fakeLoadImage). Every call to either
 * seam is recorded in thumbCalls / loadCalls.
 */
export function stores() {
  const palaceAdapter = kv();
  const rehAdapter = kv();
  const routeAdapter = kv();
  const thumbCalls = [];
  const loadCalls = [];
  return {
    palaceAdapter,
    rehAdapter,
    routeAdapter,
    thumbCalls,
    loadCalls,
    store: createPalaceStore(palaceAdapter),
    rehearsals: createRehearsalStore(rehAdapter),
    routes: createRouteStore(routeAdapter),
    thumbnail: async (photo, opts) => {
      const bytes = await toBytes(photo);
      thumbCalls.push({ bytes, opts });
      return fakeThumbnail(bytes, opts);
    },
    loadImage: async (src) => {
      loadCalls.push(src);
      return fakeLoadImage(src);
    },
  };
}

/** Deep snapshot of every adapter, for "store unchanged" checks. */
export function snapshot(s) {
  const of = (a) => structuredClone([...a.map].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
  return { palace: of(s.palaceAdapter), rehearsals: of(s.rehAdapter), routes: of(s.routeAdapter) };
}

const ascii = (str) => [...str].map((c) => c.charCodeAt(0));

// Bytes per pixel of a phone JPEG at quality 0.9 and of a 0.7 thumbnail (about 3.6 and 2 bits/px).
export const BPP_Q90 = 0.45;
export const BPP_Q70 = 0.25;

/**
 * A structurally valid baseline JPEG: SOI, optional APP1 EXIF (with a GPS tag name), SOF0 carrying
 * width x height, an SOS header, `body` entropy bytes (never 0xFF), EOI. Same args -> same bytes.
 */
export function makeJpeg(width, height, { exif = false, body = 64, fill = 0x42 } = {}) {
  const head = [0xff, 0xd8];
  if (exif) head.push(0xff, 0xe1, 0x00, 0x14, ...ascii("Exif\0\0"), ...ascii("GPSLatitude!"));
  head.push(0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03,
    0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01);
  head.push(0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00);
  const out = new Uint8Array(head.length + body + 2);
  out.set(head);
  out.fill(fill, head.length, head.length + body);
  out.set([0xff, 0xd9], head.length + body);
  return out;
}

/** {width, height} from the SOF segment, or null when the bytes are not a parseable JPEG. */
export function jpegSize(bytes) {
  if (!bytes || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    if (marker === 0xd9 || marker === 0xda) return null;
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (marker >= 0xc0 && marker <= 0xc2) {
      if (i + 9 > bytes.length) return null;
      const height = (bytes[i + 5] << 8) | bytes[i + 6];
      const width = (bytes[i + 7] << 8) | bytes[i + 8];
      return width && height ? { width, height } : null;
    }
    i += 2 + len;
  }
  return null;
}

/** A 1x1 PNG signature + IHDR (decodable by a browser <img>, and by fakeLoadImage). */
export const PNG_1X1 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, ...ascii("IHDR"),
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde,
]);

/**
 * Stand-in for the browser canvas re-encode: scales the long side down to opts.maxSide (never up)
 * and emits an EXIF-free JPEG whose size follows pixel count and quality. Deterministic, so a
 * thumbnail of a thumbnail is byte-identical.
 */
export async function fakeThumbnail(bytes, opts) {
  const size = jpegSize(bytes);
  if (!size) throw new Error("undecodable photo");
  const s = Math.min(1, opts.maxSide / Math.max(size.width, size.height));
  const width = Math.round(size.width * s);
  const height = Math.round(size.height * s);
  const body = Math.round(width * height * BPP_Q70 * (opts.quality / 0.7));
  return { bytes: makeJpeg(width, height, { body }), width, height, sourceWidth: size.width, sourceHeight: size.height };
}

/**
 * Stand-in for app.js loadImage (img.decode()): resolves {naturalWidth, naturalHeight} for a data URL
 * a browser can decode (jpeg, png), rejects for undecodable bytes. Like a lenient browser it also
 * "decodes" any other src as 100x100, so only palace_export's own checks can refuse it.
 */
export async function fakeLoadImage(src) {
  const m = /^data:image\/(jpeg|png);base64,(.*)$/s.exec(String(src));
  if (!m) return { naturalWidth: 100, naturalHeight: 100, width: 100, height: 100 };
  const bytes = new Uint8Array(Buffer.from(m[2], "base64"));
  let size = null;
  if (m[1] === "jpeg") size = jpegSize(bytes);
  else if (bytes.length >= 24 && bytes[0] === 0x89) size = { width: (bytes[18] << 8) | bytes[19], height: (bytes[22] << 8) | bytes[23] };
  if (!size) throw new Error("image decode failed");
  return { naturalWidth: size.width, naturalHeight: size.height, width: size.width, height: size.height };
}

export const dataUrl = (bytes, mime = "image/jpeg") => `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;

export { associationKey };
