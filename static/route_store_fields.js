// @ts-check
// Field normalizers for route_store.js write paths: route kind, coordinate rounding (ADR 0053) and the
// station emoji tags copy (MEM-134). Split out of route_store.js to keep it under the file-size cap.

import { normalizeEmojis } from "./emoji_tags.js";

const KINDS = new Set(["daily", "occasional"]);

/** @param {unknown} kind @returns {"daily" | "occasional"} */
export function kindOf(kind) {
  if (!KINDS.has(/** @type {string} */ (kind))) throw new TypeError("kind must be daily or occasional");
  return /** @type {"daily" | "occasional"} */ (kind);
}

const round4 = (/** @type {number} */ v, dp = 4) => Math.round(v * 10 ** dp) / 10 ** dp;

/**
 * @param {any} c @param {number} [dp] 4 for the user's own GPS, 5 for public places (ADR 0053)
 * @returns {{ lat: number, lon: number } | null} null for anything that is not a finite lat/lon pair
 */
export function coordsOf(c, dp = 4) {
  const lat = c?.lat, lon = c?.lon;
  const ok = Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  return ok ? { lat: round4(lat, dp), lon: round4(lon, dp) } : null;
}

/**
 * Restore / seed copy of a station's emoji tags; the list is rebuilt, never shared with the input.
 * @param {{ emojis?: unknown, emojisEdited?: unknown }} from
 * @param {{ emojis?: string[], emojisEdited?: boolean }} to
 */
export function copyEmojis(from, to) {
  if (Array.isArray(from.emojis)) to.emojis = normalizeEmojis(from.emojis);
  if (typeof from.emojisEdited === "boolean") to.emojisEdited = from.emojisEdited;
}
