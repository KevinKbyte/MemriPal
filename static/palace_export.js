// @ts-check
// Palace backup v2 (MEM-042 + MEM-054, ADRs 0028 / 0033): one JSON file {v: 2, routes, lists,
// associations, rehearsals}. The file is untrusted: JSON.parse only, exact key sets, and every stored
// object is rebuilt key by key from an allow-list, so __proto__ / constructor never reach the store or
// Object.prototype. Routes are exported / checked in backup_routes.js.

import { exportRoutes, importRoutes } from "./backup_routes.js";
import { associationKey } from "./palace_store.js";
import { pointOf } from "./rehearsals.js";

/** = recall_relay.py MAX_CHUNK_BYTES; kept for that meaning, no longer the backup cap (ADR 0033). */
export const MAX_IMPORT_BYTES = 1048576;
/** Export and import byte cap, sized to 3 routes x 8 thumbnails; checked before the file is read. */
export const MAX_BACKUP_BYTES = 8388608;
/** A v1 (ADR 0028) file: its routes have no photos, so it is refused rather than migrated. */
export const OLD_FORMAT = "Older backup format, not supported";
// Entries accumulate per item + locus pair across runs, so far above one route's 12.
export const MAX_IMPORT_ASSOCIATIONS = 500;
export const MAX_IMPORT_REHEARSALS = 1000;
// split.py MAX_POINTS.
const MAX_POINTS = 12;

const PALACE_ID = "demo";
const TOP_KEYS = ["associations", "lists", "rehearsals", "routes", "v"];
// associate.py FIELDS.
const FIELDS = [
  "item", "locus",
  "kinesthetic", "auditory", "visual", "emotional", "conceptual", "olfactory", "gustatory", "spatial",
  "scene_prompt_details", "walk_cue", "reencode_hint", "question", "answer",
];
const NAME_MAX = 100; // MAX_ITEM_LEN, MAX_LOCUS_LEN (trimmed)
const SCENE_FIELDS = new Set(["spatial", "visual", "scene_prompt_details"]);
const SCENE_FIELD_MAX = 300; // MAX_SCENE_FIELD_CHARS
const FIELD_MAX = 2000; // MAX_FIELD_CHARS
const SIG_RE = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * routes is optional until the page wires a route store; without one no routes are read or written.
 * @typedef {ReturnType<typeof import("./palace_store.js").createPalaceStore>} Store
 * @typedef {ReturnType<typeof import("./rehearsals.js").createRehearsalStore>} Rehearsals
 * @typedef {{
 *   store: Store, rehearsals: Rehearsals, routes?: import("./backup_routes.js").RouteStore,
 *   thumbnail?: import("./backup_routes.js").Thumbnail, loadImage: import("./backup_routes.js").LoadImage,
 * }} BackupDeps
 */

/** @param {unknown} v @returns {v is Record<string, any>} */
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * True when `obj` has exactly `required` plus any of `optional` as own keys.
 * @param {Record<string, any>} obj
 * @param {string[]} required
 * @param {string[]} [optional]
 */
function exactKeys(obj, required, optional = []) {
  const keys = Object.keys(obj);
  return required.every((k) => keys.includes(k)) && keys.every((k) => required.includes(k) || optional.includes(k));
}

/**
 * I3: a fresh {record, status[, sig]} or null; an unknown key is never stripped (it would change the
 * canonical JSON record_sign.py signs).
 * @param {unknown} e
 */
function associationOf(e) {
  if (!isObject(e) || !exactKeys(e, ["record", "status"], ["sig"])) return null;
  const { record, status, sig } = e;
  if (!isObject(record) || !exactKeys(record, FIELDS)) return null;
  if (!FIELDS.every((f) => typeof record[f] === "string")) return null;
  for (const f of ["item", "locus"]) {
    const t = record[f].trim();
    if (!t || t.length > NAME_MAX) return null;
  }
  for (const f of FIELDS.slice(2)) {
    if (record[f].length > (SCENE_FIELDS.has(f) ? SCENE_FIELD_MAX : FIELD_MAX)) return null;
  }
  if (status !== "valid" && status !== "invalid") return null;
  if ("sig" in e && !(typeof sig === "string" && SIG_RE.test(sig))) return null;
  /** @type {Record<string, string>} */
  const rec = {};
  for (const f of FIELDS) rec[f] = record[f];
  return "sig" in e ? { record: rec, status, sig } : { record: rec, status };
}

/** @param {string} t */
function isoRoundTrips(t) {
  const d = new Date(t);
  return !Number.isNaN(d.getTime()) && d.toISOString() === t;
}

/**
 * pointOf runs String() on label and source_quote, which throws on {toString: 1} and overflows the
 * stack on a deeply nested array; only primitives (or absent) are safe to hand it.
 * @param {unknown} p
 */
function safePoint(p) {
  if (!isObject(p)) return false;
  return ["label", "source_quote"].every((k) => p[k] === null || p[k] === undefined || ["string", "number", "boolean"].includes(typeof p[k]));
}

/**
 * I4: a fresh rehearsal or null. The points cap is checked over the whole file first (capError).
 * @param {unknown} r
 */
function rehearsalOf(r) {
  if (!isObject(r) || !exactKeys(r, ["id", "palace_id", "timestamp", "transcript", "points"])) return null;
  const { id, palace_id, timestamp, transcript, points } = r;
  if (typeof id !== "string" || !UUID_RE.test(id) || palace_id !== PALACE_ID) return null;
  if (typeof timestamp !== "string" || !isoRoundTrips(timestamp)) return null;
  if (typeof transcript !== "string" || !Array.isArray(points) || !points.every(safePoint)) return null;
  return { id, palace_id, timestamp, transcript, points: points.map(pointOf) };
}

/**
 * I1 count caps shared by export and import: the reason for the first one broken, else null.
 * @param {{associations: unknown[], rehearsals: unknown[]}} b
 */
function capError(b) {
  if (b.associations.length > MAX_IMPORT_ASSOCIATIONS) return `over ${MAX_IMPORT_ASSOCIATIONS} associations`;
  if (b.rehearsals.length > MAX_IMPORT_REHEARSALS) return `over ${MAX_IMPORT_REHEARSALS} rehearsals`;
  const crowded = b.rehearsals.some((r) => isObject(r) && Array.isArray(r.points) && r.points.length > MAX_POINTS);
  return crowded ? `over ${MAX_POINTS} points in a rehearsal` : null;
}

/** @param {string} text */
const byteLength = (text) => new TextEncoder().encode(text).length;

/**
 * E1: the backup of the demo palace, every object rebuilt from its allow-list. Rejects when the file
 * would break an I1 cap, so every exported file imports.
 * @param {BackupDeps} deps
 */
export async function buildBackup({ store, rehearsals, routes, thumbnail }) {
  // list() returns values only; the legacy loci route array fails associationOf like any other
  // non-entry and is not a v2 route. A stored entry may carry an image beside its record; only the
  // entry keys are exported.
  /** @param {unknown} v */
  const entryKeys = (v) => (isObject(v) ? Object.fromEntries(["record", "status", "sig"].filter((k) => k in v).map((k) => [k, v[k]])) : v);
  const associations = (await store.list()).map((v) => associationOf(entryKeys(v))).filter((a) => a !== null);
  const runs = (await rehearsals.list(PALACE_ID)).map(rehearsalOf).filter((r) => r !== null);
  const reason = capError({ associations, rehearsals: runs });
  if (reason) throw new Error(reason);
  // thumbnail is only called when a route store holds a saved route.
  const backupRoutes = await exportRoutes(routes, /** @type {any} */ (thumbnail));
  // lists[] is pinned only as an array until slice B7 defines list contents.
  const backup = { v: 2, routes: backupRoutes, lists: [], associations, rehearsals: runs };
  if (byteLength(JSON.stringify(backup)) > MAX_BACKUP_BYTES) throw new Error(`over ${MAX_BACKUP_BYTES} bytes`);
  return backup;
}

/**
 * I1 + I2: the file's three lists, or throws with the reason; nothing is written before this passes.
 * @param {string} text
 */
function parseBackup(text) {
  if (byteLength(text) > MAX_BACKUP_BYTES) throw new Error(`over ${MAX_BACKUP_BYTES} bytes`);
  /** @type {unknown} */
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("not a JSON file");
  }
  if (isObject(data) && data.v === 1) throw new Error(OLD_FORMAT);
  if (!isObject(data) || !exactKeys(data, TOP_KEYS)) throw new Error("not a MemriPal backup");
  if (data.v !== 2) throw new Error("unsupported backup version");
  const { routes, lists, associations, rehearsals } = data;
  if (![routes, lists, associations, rehearsals].every(Array.isArray)) throw new Error("not a MemriPal backup");
  const reason = capError({ associations, rehearsals });
  if (reason) throw new Error(reason);
  return { routes, associations, rehearsals };
}

/**
 * I3..I5 + D11: additive merge (a stored entry, rehearsal or route id wins and counts as present; the
 * first duplicate in a file wins); only a bad association / rehearsal is skipped, while any bad route
 * refuses the whole file before anything is written.
 * @param {string} text
 * @param {BackupDeps} deps
 * @returns {Promise<{added: number, present: number, skipped: number}>}
 */
export async function importBackup(text, { store, rehearsals, routes, loadImage }) {
  const file = parseBackup(text);
  if (file.routes.length && !routes) throw new Error("this page cannot store routes yet");
  // Every entry and route is validated before the first write, so nothing bad leaves a partial merge.
  const fileRoutes = await importRoutes(file.routes, loadImage);
  const entries = file.associations.map(associationOf);
  const runs = file.rehearsals.map(rehearsalOf);
  let added = 0;
  let present = 0;
  let skipped = 0;
  // Routes first: a failed route write throws before any association or rehearsal lands (no orphans).
  for (const r of fileRoutes) {
    if (await /** @type {NonNullable<typeof routes>} */ (routes).restoreRoute(r)) added += 1;
    else present += 1;
  }
  for (const a of entries) {
    if (!a) {
      skipped += 1;
      continue;
    }
    const key = associationKey(a.record.item, a.record.locus);
    if ((await store.get(key)) !== undefined) {
      present += 1;
      continue;
    }
    // I3: an unsigned "valid" entry never reaches /scenes; "invalid" makes the next run re-sign it.
    await store.put(key, "sig" in a ? a : { record: a.record, status: "invalid" });
    added += 1;
  }
  for (const r of runs) {
    if (!r) {
      skipped += 1;
    } else if ((await rehearsals.get(r.id)) !== null) {
      present += 1;
    } else {
      await rehearsals.restore(r);
      added += 1;
    }
  }
  return { added, present, skipped };
}
