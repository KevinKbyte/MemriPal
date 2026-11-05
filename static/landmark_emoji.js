// @ts-check
// Best-fit landmark emoji (MEM-100, ADR 0057): a deterministic keyword table that fills Station.emoji once, when a
// station is created; the live map draws the stored value (ADR 0055), so a glyph never changes under the user.
// Source order is category, then OSM tag values, then the name; within one string the earliest whole-word match
// wins (in a walking-direction name the landmark named first is the one you stand at), a tie the longest keyword.

import { bestEmoji } from "./emoji_bm25.js";

export const EMOJI_DEFAULT = "\u{1F4CD}";

/** [emoji, keywords]. Multi-word keywords match as phrases. */
const TABLE = /** @type {ReadonlyArray<[string, string[]]>} */ ([
  ["\u{1F3E4}", ["post office"]],
  ["\u{1F689}", ["station", "subway", "metro", "transit", "train", "railway"]],
  ["\u{1F68F}", ["bus stop", "bus"]],
  ["\u{1F3D9}\u{FE0F}", ["tower", "skyscraper"]],
  ["\u{1F3E2}", ["office", "headquarters", "hq", "coworking"]],
  ["\u{1F4BB}", ["tech"]],
  ["\u{1F37A}", ["brewery", "brewpub", "pub", "bar", "tavern", "taproom"]],
  ["\u{2615}", ["cafe", "coffee", "espresso"]],
  ["\u{1F374}", ["restaurant", "diner", "bistro", "grill", "kitchen", "eatery", "fast food"]],
  ["\u{1F3DB}\u{FE0F}", ["museum", "gallery"]],
  ["\u{26EA}", ["church", "cathedral", "chapel", "place of worship"]],
  ["\u{1F333}", ["park", "garden", "playground"]],
  ["\u{1F4DA}", ["library"]],
  ["\u{1F393}", ["university", "college", "institute", "campus"]],
  ["\u{1F3EB}", ["school"]],
  ["\u{1F309}", ["bridge"]],
  ["\u{1F3E8}", ["hotel", "inn", "hostel", "motel"]],
  ["\u{1F6D2}", ["shop", "store", "market", "marketplace", "supermarket", "grocery", "mall"]],
  ["\u{1F3E5}", ["hospital", "clinic"]],
  ["\u{1F3E6}", ["bank"]],
  ["\u{1F3AD}", ["theater", "theatre", "cinema"]],
  ["\u{1F3ED}", ["factory", "mill"]],
  ["\u{1F3D8}\u{FE0F}", ["apartment", "condo", "residence"]],
  ["\u{1F3DF}\u{FE0F}", ["stadium", "arena"]],
  ["\u{26F2}", ["fountain"]],
  ["\u{1F5FD}", ["statue", "monument"]],
]);

const SHOP = "\u{1F6D2}";

// Keywords are plain [a-z ] text, so they need no regex escaping.
const RULES = TABLE.flatMap(([emoji, words]) =>
  words.map((word) => ({ emoji, word, re: new RegExp(`(?<![a-z0-9])${word}(?:e?s)?(?![a-z0-9])`) })));

/** Lower-case, accents folded ("Caf\u{E9}" -> "cafe"). @param {string} s */
const fold = (s) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

/** The emoji of the earliest whole-word keyword in `text` (tie: longest keyword), or null. @param {unknown} text */
function match(text) {
  if (typeof text !== "string") return null;
  const s = fold(text);
  let best = null;
  for (const rule of RULES) {
    const at = s.search(rule.re);
    if (at < 0) continue;
    if (!best || at < best.at || (at === best.at && rule.word.length > best.word.length)) best = { at, ...rule };
  }
  return best ? best.emoji : null;
}

/** @param {unknown} tags */
function fromTags(tags) {
  if (!tags || typeof tags !== "object" || Array.isArray(tags)) return null;
  const entries = Object.entries(tags);
  for (const [, value] of entries) {
    const hit = typeof value === "string" ? match(value.replace(/_/g, " ")) : null;
    if (hit) return hit;
  }
  return entries.some(([key]) => key === "shop") ? SHOP : null;
}

/** @param {unknown} tags @returns {unknown[]} */
const tagValues = (tags) => (tags && typeof tags === "object" && !Array.isArray(tags) ? Object.values(tags) : []);

/**
 * Best-fit emoji for a landmark: the keyword table, then a BM25 corpus search (MEM-144), then EMOJI_DEFAULT.
 * Never throws.
 * @param {{ name?: unknown, category?: unknown, tags?: unknown } | null | undefined} input
 * @returns {string}
 */
export function emojiFor(input) {
  if (!input || typeof input !== "object") return EMOJI_DEFAULT;
  const table = match(input.category) ?? fromTags(input.tags) ?? match(input.name);
  if (table) return table;
  const query = [input.name, input.category, ...tagValues(input.tags)].filter((s) => typeof s === "string").join(" ");
  return bestEmoji(query) ?? EMOJI_DEFAULT;
}
