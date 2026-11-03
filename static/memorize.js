// @ts-check
// Memorize (MEM-087, ADR 0048): pasted notes -> keywords via /split notes mode, one keyword per station
// via /associate, mnemonics and the route recommendation on the phone (0 calls). Pure; fetch is injected.

import { STOPWORDS, tokenize } from "./recall_match.js";
// Byte-exact base64 of fixtures/demo/photo.jpg: the photo keys the /split replay fixture, so a photo-less
// route must send exactly these bytes or fixture mode misses (split never shows it to the model).
import DEMO_PHOTO_B64 from "./assets/demo_photo.json" with { type: "json" };

// split.py caps, mirrored so an edited list fails on the phone exactly as split_list would.
const MAX_POINTS = 12;
const MAX_LIST_BYTES = 4096;
const MAX_LABEL_CHARS = 100;
const JPEG_DATA_URL = "data:image/jpeg;base64,";
const LOCK_REASON = "Mnemonics and associations are built from the keywords.";

/** @typedef {{label: string, source_quote: string}} Keyword */
/** @typedef {{keywords: boolean, mnemonics: boolean, associations: boolean}} DeconstructState */

/** @param {string} url @param {unknown} body @param {typeof fetch} fetch */
async function postJson(url, body, fetch) {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await resp.json().catch(() => null);
  if (!resp.ok) {
    throw new Error(payload && typeof payload.error === "string" ? payload.error : `http_${resp.status}`);
  }
  return payload;
}

/** @param {unknown} p @returns {p is Keyword} */
const isKeyword = (p) => typeof p === "object" && p !== null
  && typeof (/** @type {any} */ (p).label) === "string" && typeof (/** @type {any} */ (p).source_quote) === "string";

/**
 * One POST /split in notes mode; keywords come back in speech order.
 * @param {{text: string, lociCount: number, photo?: string}} input photo: plain base64 JPEG
 * @param {{fetch: typeof fetch}} deps
 * @returns {Promise<Keyword[]>}
 */
export async function splitNotes({ text, lociCount, photo = DEMO_PHOTO_B64 }, { fetch }) {
  const payload = await postJson("/split", { photo, mode: "notes", text, loci_count: lociCount }, fetch);
  const points = payload?.points;
  if (!Array.isArray(points) || !points.every(isKeyword)) throw new Error("bad_response");
  return points.map((p) => ({ label: p.label, source_quote: p.source_quote }));
}

/**
 * An edited keyword list re-split with split.py split_list's rules; never calls the model.
 * @param {string} text @param {number} lociCount
 * @returns {Keyword[]}
 */
export function splitList(text, lociCount) {
  if (new TextEncoder().encode(text).length > MAX_LIST_BYTES) throw new Error("list_too_large");
  const items = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!items.length) throw new Error("no_items");
  // Code points, as Python's len() counts them.
  if (items.some((item) => [...item].length > MAX_LABEL_CHARS)) throw new Error("item_too_long");
  if (items.length > Math.min(MAX_POINTS, lociCount)) throw new Error("too_many_items");
  return items.map((item) => ({ label: item, source_quote: item }));
}

/**
 * Keyword i at stations[i], one POST /associate each, in order; an invalid reply leaves its station out.
 * @param {Keyword[]} keywords @param {{id: string, name: string}[]} stations
 * @param {{fetch: typeof fetch}} deps
 * @returns {Promise<Record<string, {record: object, sig: string}>>}
 */
export async function associateKeywords(keywords, stations, { fetch }) {
  /** @type {Record<string, {record: object, sig: string}>} */
  const placements = {};
  const n = Math.min(keywords.length, stations.length);
  for (let i = 0; i < n; i++) {
    const station = stations[i];
    const body = { image: JPEG_DATA_URL + DEMO_PHOTO_B64, item: keywords[i].label, locus: station.name };
    const reply = await postJson("/associate", body, fetch);
    const ok = reply?.status === "valid" && typeof reply.record === "object" && reply.record !== null
      && typeof reply.sig === "string";
    // The sig rides beside the record, never inside it: the server signed the record as sent (MEM-036).
    if (ok) placements[station.id] = { record: reply.record, sig: reply.sig };
  }
  return placements;
}

/**
 * Acronym of the keywords' first letters plus a chain naming each keyword in order.
 * @param {Keyword[]} keywords
 */
export function mnemonics(keywords) {
  const labels = keywords.map((k) => k.label.trim());
  return {
    acronym: labels.map((l) => l.charAt(0).toUpperCase()).join(""),
    chain: labels.join(", then "),
  };
}

/** Content words of `text` (recall_match.js tokenizer, stopwords dropped). @param {string} text */
const words = (text) => new Set(tokenize(text, 0).map((t) => t.w).filter((w) => !STOPWORDS.has(w)));

/** @param {Set<string>} a @param {Set<string>} b */
function jaccard(a, b) {
  const shared = [...a].filter((w) => b.has(w));
  const union = new Set([...a, ...b]).size;
  return { score: union ? shared.length / union : 0, shared };
}

/**
 * The route to place `item` on: free stations >= keywords (an active list leaves none free), best
 * Jaccard of the item's words against the route name and list names, then the tightest fit, then name.
 * @param {{title: string, text: string, keywords: Keyword[]}} item
 * @param {any[]} routes saved routes (route_store.js shape)
 * @returns {{routeId: string, reason: string} | null}
 */
export function recommendRoute(item, routes) {
  const need = item.keywords.length;
  const itemWords = words([item.title, item.text, ...item.keywords.map((k) => k.label)].join(" "));
  const fits = [];
  for (const r of routes) {
    const lists = r.lists ?? [];
    const free = lists.some((/** @type {any} */ l) => l.status === "active")
      ? 0
      : r.stations.filter((/** @type {any} */ s) => s.status === "named").length;
    if (free < need) continue;
    const routeWords = words([r.name, ...lists.map((/** @type {any} */ l) => l.name)].join(" "));
    fits.push({ r, free, ...jaccard(itemWords, routeWords) });
  }
  fits.sort((a, b) => b.score - a.score || a.free - b.free
    || (a.r.name < b.r.name ? -1 : a.r.name > b.r.name ? 1 : 0) || (a.r.id < b.r.id ? -1 : 1));
  const best = fits[0];
  if (!best) return null;
  const match = best.shared.length ? `matches "${best.shared.join(", ")}"` : "no word match, best fit by size";
  return {
    routeId: best.r.id,
    reason: `${best.r.name}: ${best.free} free stations for ${need} keywords; ${match}.`,
  };
}

/**
 * Store a MemorizeItem under KV key list:<id>.
 * @param {{put: (key: string, value: unknown) => Promise<void>}} kv @param {{id: string}} item
 */
export async function saveMemorizeItem(kv, item) {
  await kv.put(`list:${item.id}`, item);
}

/**
 * One checkbox click. Dependents (mnemonics, associations) need keywords: checking one checks
 * keywords too, and keywords stays checked while a dependent is.
 * @param {DeconstructState} state @param {keyof DeconstructState} box
 * @returns {DeconstructState}
 */
export function toggleDeconstruct(state, box) {
  const next = { keywords: state.keywords, mnemonics: state.mnemonics, associations: state.associations };
  if (box === "keywords") {
    if (!state.mnemonics && !state.associations) next.keywords = !state.keywords;
    return next;
  }
  next[box] = !state[box];
  if (next[box]) next.keywords = true;
  return next;
}

/**
 * What each checkbox shows: the keywords box is locked, with the reason, while a dependent is checked.
 * @param {DeconstructState} state
 */
export function deconstructView(state) {
  const locked = state.mnemonics || state.associations;
  return {
    keywords: { checked: state.keywords, disabled: locked, reason: locked ? LOCK_REASON : null },
    mnemonics: { checked: state.mnemonics, disabled: false, reason: null },
    associations: { checked: state.associations, disabled: false, reason: null },
  };
}
