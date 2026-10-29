// Shared fixtures for the MEM-042 palace backup tests (palace_export*.test.mjs). Not a test file
// itself (no describe/test); the *.test.mjs files import it.

import { associationKey, createPalaceStore } from "./palace_store.js";
import { createRehearsalStore } from "./rehearsals.js";

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

export function backup(extra = {}) {
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

/** Fresh empty palace + rehearsal stores over their own adapters. */
export function stores() {
  const palaceAdapter = kv();
  const rehAdapter = kv();
  return {
    palaceAdapter,
    rehAdapter,
    store: createPalaceStore(palaceAdapter),
    rehearsals: createRehearsalStore(rehAdapter),
  };
}

export { associationKey };
