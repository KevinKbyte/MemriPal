// @ts-check
// Palace backup (MEM-042, ADR 0028): one JSON file {v, palace_id, route, associations, rehearsals}.
// The file is untrusted: JSON.parse only, exact key sets, and every stored object is rebuilt key by
// key from an allow-list, so __proto__ / constructor never reach the store or Object.prototype.

import { associationKey } from "./palace_store.js";
import { pointOf } from "./rehearsals.js";

/** = recall_relay.py MAX_CHUNK_BYTES; checked on file.size before the file is read. */
export const MAX_IMPORT_BYTES = 1048576;
// Entries accumulate per item + locus pair across runs, so far above one route's 12.
export const MAX_IMPORT_ASSOCIATIONS = 500;
export const MAX_IMPORT_REHEARSALS = 1000;
// loci.py max_loci and split.py MAX_POINTS.
const MAX_ROUTE_LOCI = 12;
const MAX_POINTS = 12;

const PALACE_ID = "demo";
const TOP_KEYS = ["associations", "palace_id", "rehearsals", "route", "v"];
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
const BOX_KEYS = ["x1", "y1", "x2", "y2"];

/**
 * @typedef {ReturnType<typeof import("./palace_store.js").createPalaceStore>} Store
 * @typedef {ReturnType<typeof import("./rehearsals.js").createRehearsalStore>} Rehearsals
 * @typedef {{store: Store, rehearsals: Rehearsals}} BackupDeps
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

/** @param {unknown} v */
const finite = (v) => typeof v === "number" && Number.isFinite(v);

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
 * Route: a fresh locus list (app.py _locus_json shape), or null when any locus fails.
 * @param {unknown[]} route
 */
function routeOf(route) {
  const out = [];
  for (const l of route) {
    if (!isObject(l) || !exactKeys(l, ["n", "label", "phrase", "box", "outline"])) return null;
    const { n, label, phrase, box, outline } = l;
    if (!Number.isInteger(n) || typeof label !== "string" || typeof phrase !== "string") return null;
    if (!isObject(box) || !exactKeys(box, BOX_KEYS) || !BOX_KEYS.every((k) => finite(box[k]))) return null;
    if (!Array.isArray(outline) || !outline.every((p) => Array.isArray(p) && p.length === 2 && p.every(finite))) return null;
    out.push({
      n,
      label,
      phrase,
      box: { x1: box.x1, y1: box.y1, x2: box.x2, y2: box.y2 },
      outline: outline.map((p) => [p[0], p[1]]),
    });
  }
  return out;
}

/**
 * I1 count caps shared by export and import: the reason for the first one broken, else null.
 * @param {{route: unknown[], associations: unknown[], rehearsals: unknown[]}} b
 */
function capError(b) {
  if (b.associations.length > MAX_IMPORT_ASSOCIATIONS) return `over ${MAX_IMPORT_ASSOCIATIONS} associations`;
  if (b.rehearsals.length > MAX_IMPORT_REHEARSALS) return `over ${MAX_IMPORT_REHEARSALS} rehearsals`;
  if (b.route.length > MAX_ROUTE_LOCI) return `over ${MAX_ROUTE_LOCI} places in the route`;
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
export async function buildBackup({ store, rehearsals }) {
  const route = routeOf((await store.loadRoute()) ?? []) ?? [];
  // list() returns values only; the route array fails associationOf like any other non-entry. A
  // stored entry may carry an image beside its record; only the entry keys are exported.
  /** @param {unknown} v */
  const entryKeys = (v) => (isObject(v) ? Object.fromEntries(["record", "status", "sig"].filter((k) => k in v).map((k) => [k, v[k]])) : v);
  const associations = (await store.list()).map((v) => associationOf(entryKeys(v))).filter((a) => a !== null);
  const runs = (await rehearsals.list(PALACE_ID)).map(rehearsalOf).filter((r) => r !== null);
  const backup = { v: 1, palace_id: PALACE_ID, route, associations, rehearsals: runs };
  const reason = capError(backup);
  if (reason) throw new Error(reason);
  if (byteLength(JSON.stringify(backup)) > MAX_IMPORT_BYTES) throw new Error(`over ${MAX_IMPORT_BYTES} bytes`);
  return backup;
}

/**
 * I1 + I2: the file's three lists, or throws with the reason; nothing is written before this passes.
 * @param {string} text
 */
function parseBackup(text) {
  if (byteLength(text) > MAX_IMPORT_BYTES) throw new Error(`over ${MAX_IMPORT_BYTES} bytes`);
  /** @type {unknown} */
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("not a JSON file");
  }
  if (!isObject(data) || !exactKeys(data, TOP_KEYS)) throw new Error("not a MemriPal backup");
  if (data.v !== 1) throw new Error("unsupported backup version");
  if (data.palace_id !== PALACE_ID) throw new Error("not a backup of this palace");
  const { route, associations, rehearsals } = data;
  if (!Array.isArray(route) || !Array.isArray(associations) || !Array.isArray(rehearsals)) {
    throw new Error("not a MemriPal backup");
  }
  const reason = capError({ route, associations, rehearsals });
  if (reason) throw new Error(reason);
  return { route, associations, rehearsals };
}

/**
 * I3..I5: additive merge (an existing entry wins, the first duplicate in a file wins); only a bad
 * entry is skipped. A valid route is restored when none is stored, but never counted.
 * @param {string} text
 * @param {BackupDeps} deps
 * @returns {Promise<{imported: number, skipped: number}>}
 */
export async function importBackup(text, { store, rehearsals }) {
  const file = parseBackup(text);
  // Every entry is validated before the first write, so no bad entry can leave a partial merge.
  const entries = file.associations.map(associationOf);
  const runs = file.rehearsals.map(rehearsalOf);
  let imported = 0;
  let skipped = 0;
  for (const a of entries) {
    const key = a ? associationKey(a.record.item, a.record.locus) : "";
    if (!a || (await store.get(key)) !== undefined) {
      skipped += 1;
      continue;
    }
    // I3: an unsigned "valid" entry never reaches /scenes; "invalid" makes the next run re-sign it.
    await store.put(key, "sig" in a ? a : { record: a.record, status: "invalid" });
    imported += 1;
  }
  for (const r of runs) {
    if (!r || (await rehearsals.get(r.id)) !== null) {
      skipped += 1;
      continue;
    }
    await rehearsals.restore(r);
    imported += 1;
  }
  const route = routeOf(file.route);
  if (route && route.length && (await store.loadRoute()) === null) await store.saveRoute(route);
  return { imported, skipped };
}
