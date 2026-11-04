// @ts-check
// Emoji tags (MEM-134, ADR 0072): a station's 0..MAX_EMOJIS emojis replace the sound/smell/feel/mood quick-taps.
// Pure helpers, no DOM: picker search, legacy-tap migration, Muse auto-fill from the station's generated context,
// and the stored-list normalizer. Stored taps are never rewritten; migration only reads them.

import { EMOJI } from "./emoji_data.js";
import { EMOJI_DEFAULT, emojiFor } from "./landmark_emoji.js";

export const MAX_EMOJIS = 6;

/** Legacy sense-tap label (lower-case) -> emoji. Every glyph here is also an EMOJI entry. */
export const TAP_EMOJI = Object.freeze({
  traffic: "\u{1F697}", birds: "\u{1F426}", water: "\u{1F4A7}", voices: "\u{1F5E3}\u{FE0F}", quiet: "\u{1F92B}",
  music: "\u{1F3B5}",
  food: "\u{1F372}", coffee: "\u{2615}", flowers: "\u{1F490}", fumes: "\u{1F4A8}", rain: "\u{1F327}\u{FE0F}",
  warm: "\u{2600}\u{FE0F}", cold: "\u{2744}\u{FE0F}", windy: "\u{1F32C}\u{FE0F}", uphill: "\u{26F0}\u{FE0F}",
  stairs: "\u{1FA9C}", shade: "\u{26F1}\u{FE0F}",
  calm: "\u{1F60C}", busy: "\u{1F465}", bright: "\u{1F506}", cosy: "\u{1F56F}\u{FE0F}", grand: "\u{1F3DB}\u{FE0F}",
  odd: "\u{1F914}",
});

const SENSE_GROUPS = ["sound", "smell", "feel", "mood"];

/**
 * Picker search: exact name, then name prefix, then any name word / keyword prefix; list order within a rank.
 * "" (or a non-string) returns the first `limit` entries. Never throws.
 * @param {unknown} query
 * @param {readonly import("./emoji_data.js").EmojiEntry[]} [list]
 * @param {number} [limit]
 */
export function searchEmoji(query, list = EMOJI, limit = 48) {
  const q = typeof query === "string" ? query.trim().toLowerCase() : "";
  if (q === "") return list.slice(0, limit);
  const ranks = [[], [], []];
  for (const x of list) {
    if (x.name === q) ranks[0].push(x);
    else if (x.name.startsWith(q)) ranks[1].push(x);
    else if ([...x.name.split(/\s+/), ...x.keywords].some((w) => w.startsWith(q))) ranks[2].push(x);
  }
  return ranks.flat().slice(0, limit);
}

/**
 * A station's legacy taps as emojis, in sound, smell, feel, mood order; unknown labels, "None" and turn skipped.
 * @param {unknown} taps
 * @returns {string[]}
 */
export function migrateTaps(taps) {
  if (!taps || typeof taps !== "object") return [];
  const t = /** @type {Record<string, unknown>} */ (taps);
  const out = [];
  for (const g of SENSE_GROUPS) {
    const label = typeof t[g] === "string" ? /** @type {string} */ (t[g]).toLowerCase() : "";
    if (Object.hasOwn(TAP_EMOJI, label)) out.push(/** @type {Record<string, string>} */ (TAP_EMOJI)[label]);
  }
  return [...new Set(out)];
}

const escapeRe = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// One whole-word matcher per entry over its name and keywords (optional plural s/es), built once.
const MATCHERS = EMOJI.map((x) => ({
  e: x.e,
  re: new RegExp(`(?<![a-z0-9])(?:${[x.name, ...x.keywords].map(escapeRe).join("|")})(?:e?s)?(?![a-z0-9])`),
}));

/**
 * Muse auto-fill: the landmark glyph (when emojiFor finds one), then EMOJI entries named as whole words in the
 * station's context, in order of first appearance; deduped, capped. Never [] (falls back to [EMOJI_DEFAULT]).
 * @param {unknown} station
 * @returns {string[]}
 */
export function museEmojis(station) {
  const st = station && typeof station === "object" ? /** @type {Record<string, any>} */ (station) : {};
  const profile = st.profile && typeof st.profile === "object" ? st.profile : {};
  const text = [st.name, profile.visual, profile.spatial, profile.conceptual, st.category]
    .filter((s) => typeof s === "string").join("\n").toLowerCase();
  const out = [];
  const landmark = emojiFor({ name: st.name, category: st.category });
  if (landmark !== EMOJI_DEFAULT) out.push(landmark);
  const hits = [];
  for (const m of MATCHERS) {
    const at = text.search(m.re);
    if (at >= 0) hits.push({ at, e: m.e });
  }
  // Array.prototype.sort is stable, so equal positions keep EMOJI list order.
  hits.sort((a, b) => a.at - b.at);
  for (const h of hits) out.push(h.e);
  const result = [...new Set(out)].slice(0, MAX_EMOJIS);
  return result.length ? result : [EMOJI_DEFAULT];
}

/**
 * Stored emoji list: trimmed non-empty strings <= 16 UTF-16 units, deduped, capped at MAX_EMOJIS.
 * @param {unknown} list
 * @returns {string[]}
 */
export function normalizeEmojis(list) {
  if (!Array.isArray(list)) return [];
  const out = new Set();
  for (const v of list) {
    if (typeof v !== "string") continue;
    const s = v.trim();
    if (s !== "" && s.length <= 16) out.add(s);
    if (out.size === MAX_EMOJIS) break;
  }
  return /** @type {string[]} */ ([...out]);
}

/**
 * The emojis a station's card starts with: a user-edited list wins (copied); otherwise migrated taps then Muse.
 * @param {unknown} station
 * @returns {string[]}
 */
export function startingEmojis(station) {
  const st = station && typeof station === "object" ? /** @type {Record<string, any>} */ (station) : {};
  if (st.emojisEdited === true && Array.isArray(st.emojis)) return [...st.emojis];
  return normalizeEmojis([...migrateTaps(st.taps), ...museEmojis(station)]);
}
