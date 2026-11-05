// @ts-check
// Okapi BM25 keyword search over the emoji corpus (MEM-144): the offline fallback when the MEM-100 keyword
// table misses a landmark. Pure and deterministic; a bad query returns [] instead of throwing.

import { EMOJI_CORPUS } from "./emoji_corpus.js";

const K1 = 1.2;
const B = 0.75;
const DEFAULT_K = 5;

/** Lower-case alnum runs, accents folded ("Caf\u{E9}" -> "cafe"). @param {string} s */
const tokenize = (s) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().match(/[a-z0-9]+/g) ?? [];

/**
 * @param {ReadonlyArray<{ emoji: string, name: string, keywords: string[] }>} corpus
 * @returns {{ search: (query: unknown, k?: number) => Array<{ emoji: string, score: number }> }}
 */
export function createEmojiIndex(corpus) {
  const docs = corpus.map((row) => {
    const tokens = tokenize(`${row.name} ${row.keywords.join(" ")}`);
    /** @type {Map<string, number>} */
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { emoji: row.emoji, len: tokens.length, tf };
  });
  const n = docs.length;
  const avgdl = n ? docs.reduce((sum, d) => sum + d.len, 0) / n : 0;
  /** @type {Map<string, number>} */
  const df = new Map();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  /** @param {string} t */
  const idf = (t) => {
    const m = df.get(t) ?? 0;
    return Math.log(1 + (n - m + 0.5) / (m + 0.5));
  };

  return {
    search(query, k = DEFAULT_K) {
      if (typeof query !== "string") return [];
      const terms = [...new Set(tokenize(query))].filter((t) => df.has(t));
      if (!terms.length) return [];
      const limit = Number.isInteger(k) && k > 0 ? k : DEFAULT_K;
      const hits = [];
      for (const d of docs) {
        let score = 0;
        for (const t of terms) {
          const f = d.tf.get(t);
          if (f) score += (idf(t) * f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.len) / avgdl));
        }
        if (score > 0) hits.push({ emoji: d.emoji, score });
      }
      // Array.prototype.sort is stable, so equal scores keep corpus order.
      return hits.sort((a, b) => b.score - a.score).slice(0, limit);
    },
  };
}

/** @type {ReturnType<typeof createEmojiIndex> | null} */
let shared = null;

/**
 * The best-scoring EMOJI_CORPUS emoji for `query`, or null when no word matches.
 * @param {unknown} query
 * @returns {string | null}
 */
export function bestEmoji(query) {
  shared ??= createEmojiIndex(EMOJI_CORPUS);
  return shared.search(query, 1)[0]?.emoji ?? null;
}
