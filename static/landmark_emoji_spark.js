// @ts-check
// Spark-picked landmark emoji (MEM-144): when the LLM is reachable it chooses the glyph, but only a reply that is
// exactly one emoji is trusted; anything else (no Spark, failure, slow reply, text) falls back to the offline
// emojiFor (keyword table, BM25 corpus, pushpin). Never rejects.

import { emojiFor } from "./landmark_emoji.js";

const DEFAULT_TIMEOUT_MS = 2500;
// One pictographic grapheme: optional skin tone or FE0F, ZWJ sequences allowed. Keycaps and flags are out.
const ONE_EMOJI = /^\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|️)?(?:‍\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|️)?)*$/u;
const MAX_UNITS = 16;

/** @param {unknown} reply @returns {reply is string} */
const isOneEmoji = (reply) => typeof reply === "string" && reply.length <= MAX_UNITS && ONE_EMOJI.test(reply);

/**
 * @typedef {{ name?: unknown, category?: unknown, tags?: unknown }} Landmark
 * @typedef {(landmark: Landmark) => unknown} Spark
 */

/**
 * @param {Landmark} landmark
 * @param {Spark} spark
 * @param {number} timeoutMs
 * @returns {Promise<unknown>} the reply, or null on a throw or timeout
 */
async function ask(landmark, spark, timeoutMs) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
  try {
    // .then() turns a synchronous throw into a rejection, caught below.
    return await Promise.race([Promise.resolve().then(() => spark(landmark)), timeout]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {Landmark | null | undefined} landmark
 * @param {{ spark?: Spark | null, timeoutMs?: number }} [opts]
 * @returns {Promise<string>}
 */
export async function pickLandmarkEmoji(landmark, opts) {
  const { spark, timeoutMs = DEFAULT_TIMEOUT_MS } = opts ?? {};
  if (typeof spark === "function" && landmark && typeof landmark === "object" && typeof landmark.name === "string") {
    const reply = await ask(landmark, spark, timeoutMs);
    if (isOneEmoji(reply)) return reply;
  }
  return emojiFor(landmark);
}

/**
 * Browser Spark client: POSTs the landmark to /landmark-emoji; the server's emoji string, or null.
 * @param {typeof fetch} fetchFn
 * @returns {(landmark: Landmark) => Promise<string | null>}
 */
export function sparkEmojiClient(fetchFn) {
  return async (landmark) => {
    try {
      const { name, category, tags } = landmark;
      const r = await fetchFn("/landmark-emoji", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, category, tags }),
      });
      if (!r.ok) return null;
      const body = await r.json();
      return typeof body?.emoji === "string" ? body.emoji : null;
    } catch {
      return null;
    }
  };
}
