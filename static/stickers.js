// @ts-check
// Emoji-composite stickers (MEM-117, ADR 0061): an item's keywords each pick a base emoji, and the picks layered
// together are the item's one memorable picture. Pure and DOM-free; tour_house.js draws the parts.

/** @typedef {{ emoji: string, name: string, words: ReadonlyArray<string> }} Sticker */
/** @typedef {{ text: string, keywords: string[], parts: string[], desc: string }} Composite */

export const FALLBACK_EMOJI = String.fromCodePoint(0x2728);

const MAX_KEYWORDS = 3;
const STOP = new Set(["the", "and", "for", "with", "in", "of", "or", "from", "into"]);

/** @param {string} emoji @param {string} name @param {string[]} [words] @returns {Sticker} */
const S = (emoji, name, words = []) => Object.freeze({ emoji, name, words: Object.freeze(words) });

// Every tour keyword has 2+ stickers so a re-roll visibly changes each locus (tour_house.test.mjs).
export const BASE_STICKERS = Object.freeze([
  S("\u{1F525}", "fire", ["sizzling", "hot", "flame"]),
  S("\u{1F373}", "frying pan", ["sizzling", "cooking", "egg"]),
  S("\u{1F953}", "bacon", ["breakfast", "crispy"]),
  S("\u{1F50A}", "speaker", ["squeaking", "loud", "noise"]),
  S("\u{1F514}", "bell", ["squeaking", "ring"]),
  S("\u{1F42D}", "mouse", ["squeaking", "squeak"]),
  S("\u{1F3BE}", "tennis ball", ["toy"]),
  S("\u{26BD}", "soccer ball", ["toy", "kick"]),
  S("\u{1F3C0}", "basketball", ["ball", "hoop"]),
  S("\u{1F4A7}", "droplet", ["dripping", "water", "drop"]),
  S("\u{1F4A6}", "sweat droplets", ["dripping", "splash"]),
  S("\u{1F36F}", "honey pot", ["dripping", "sticky", "honey"]),
  S("\u{1F95C}", "peanuts", ["nut"]),
  S("\u{1F9C8}", "butter", ["spread"]),
  S("\u{1F35E}", "bread", ["butter", "toast", "loaf"]),
  S("\u{1F43E}", "paw prints", ["belly", "rub", "seal"]),
  S("\u{1F436}", "dog face", ["dog", "pal", "belly", "puppy"]),
  S("\u{1F3AB}", "ticket", ["voucher", "pass"]),
  S("\u{1F39F}\u{FE0F}", "admission tickets", ["voucher", "ticket"]),
  S("\u{1F4DC}", "scroll", ["paper", "list"]),
  S("\u{1F4C4}", "page facing up", ["paper", "document"]),
  S("\u{1F451}", "crown", ["king", "royal", "queen"]),
  S("\u{1F934}", "prince", ["crown", "royal"]),
  S("\u{1F9B4}", "bone", ["dog", "chew"]),
  S("\u{1F6D2}", "shopping cart", ["cart", "shop"]),
  S("\u{1F986}", "duck", ["squeaky"]),
  S("\u{1F9FC}", "soap", ["shampoo", "wash"]),
  S("\u{1F3E0}", "house", ["home"]),
  S("\u{1F3F0}", "castle", ["palace", "royal"]),
  S("\u{1F6AA}", "door", ["doormat", "entrance"]),
  S("\u{1FA9F}", "window", ["glass", "view"]),
  S("\u{1F327}\u{FE0F}", "cloud with rain", ["rain", "storm", "weather"]),
  S("\u{2B50}", "star", ["glitter", "sparkle"]),
  S("\u{1F9C0}", "cheese", ["wedge"]),
  S("\u{1F34E}", "red apple", ["fruit"]),
  S("\u{1F355}", "pizza", ["slice"]),
  S("\u{1F48E}", "gem", ["jewel", "diamond"]),
]);

/**
 * Up to 3 lower-case keywords of 3+ letters, stop words dropped, first occurrence kept.
 * @param {unknown} text
 * @returns {string[]}
 */
export function keywords(text) {
  /** @type {string[]} */
  const out = [];
  for (const w of String(text ?? "").toLowerCase().split(/[^a-z]+/)) {
    if (w.length < 3 || STOP.has(w) || out.includes(w)) continue;
    out.push(w);
    if (out.length === MAX_KEYWORDS) break;
  }
  return out;
}

/** Whole-word match, tolerating a plural "s" on either side. @param {string} k @param {string} t */
const same = (k, t) => k === t || k === `${t}s` || t === `${k}s`;

/** @param {Sticker} s */
const tokens = (s) => [s.name, ...s.words].flatMap((w) => w.split(" "));

/**
 * Stickers matching any keyword of `query`, most matched keywords first, then pool order.
 * @param {unknown} query
 * @param {ReadonlyArray<Sticker>} [pool]
 * @returns {Sticker[]}
 */
export function search(query, pool = BASE_STICKERS) {
  const ks = keywords(query);
  if (!ks.length) return [];
  return pool
    .map((s, i) => {
      const ts = tokens(s);
      return { s, i, hits: ks.filter((k) => ts.some((t) => same(k, t))).length };
    })
    .filter((r) => r.hits > 0)
    .sort((a, b) => b.hits - a.hits || a.i - b.i)
    .map((r) => r.s);
}

/**
 * One merged sticker: per keyword a random matching emoji (no repeats), or sparkles when nothing matched.
 * @param {string} text
 * @param {() => number} [rng]
 * @param {ReadonlyArray<Sticker>} [pool]
 * @returns {Composite}
 */
export function compose(text, rng = Math.random, pool = BASE_STICKERS) {
  const ks = keywords(text);
  /** @type {string[]} */
  const parts = [];
  for (const k of ks) {
    const matches = search(k, pool);
    if (!matches.length) continue;
    const emoji = matches[Math.floor(rng() * matches.length)].emoji;
    if (!parts.includes(emoji)) parts.push(emoji);
  }
  if (!parts.length) parts.push(FALLBACK_EMOJI);
  return { text, keywords: ks, parts, desc: ks.length ? ks.join(" ") : text };
}

/**
 * @param {string[]} items
 * @param {() => number} [rng]
 * @param {ReadonlyArray<Sticker>} [pool]
 * @returns {Composite[]}
 */
export function rollAll(items, rng = Math.random, pool = BASE_STICKERS) {
  return items.map((t) => compose(t, rng, pool));
}

/**
 * A new array with only sticker `i` re-composed; the others keep their identity.
 * @param {Composite[]} stickers
 * @param {number} i
 * @param {() => number} [rng]
 * @param {ReadonlyArray<Sticker>} [pool]
 * @returns {Composite[]}
 */
export function rollOne(stickers, i, rng = Math.random, pool = BASE_STICKERS) {
  const out = [...stickers];
  if (Number.isInteger(i) && i >= 0 && i < out.length) out[i] = compose(out[i].text, rng, pool);
  return out;
}
