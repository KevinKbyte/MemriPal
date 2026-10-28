// @ts-check
// Spoken recall session (MEM-032, plan D4): microphone when available, else a typed box judged by the
// same deterministic matcher. Never browser Web Speech (D17): its audio goes to a third-party service.
import { createMatcher } from "./recall_match.js";

export const REPLAY_LABEL = "replay of a recorded session";

/**
 * @typedef {{ label: string, source_quote: string }} RecallPoint
 * @typedef {{ t_ms: number, text: string }} TimelineChunk
 * @typedef {{ label: string, chunks: TimelineChunk[] }} RecallTimeline
 * @typedef {ReturnType<typeof createMatcher>} Matcher
 */

/**
 * The microphone stream, or null when getUserMedia is missing, throws (insecure context) or rejects
 * (permission denied, no device).
 * @param {((c: MediaStreamConstraints) => Promise<MediaStream>) | null | undefined} getUserMedia
 * @returns {Promise<MediaStream | null>}
 */
async function openMic(getUserMedia) {
  if (typeof getUserMedia !== "function") return null;
  try {
    return await getUserMedia({ audio: true });
  } catch {
    return null;
  }
}

/**
 * @param {{
 *   points: RecallPoint[],
 *   getUserMedia?: ((c: MediaStreamConstraints) => Promise<MediaStream>) | null,
 *   doc: { getElementById: (id: string) => any },
 * }} opts
 */
export async function startRecall({ points, getUserMedia, doc }) {
  const matcher = createMatcher(points);
  const stream = await openMic(getUserMedia);
  const mode = stream === null ? "typed" : "spoken";
  if (mode === "typed") {
    const box = doc.getElementById("recall-typed");
    if (box) box.hidden = false;
  }
  return {
    mode,
    stream,
    matcher,
    /**
     * @param {string} text
     * @returns {number[]} indices newly matched by this answer
     */
    submitTyped: (text) => matcher.append(text),
    results: () => matcher.results(),
  };
}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Offline fixture-mode replay: feeds a recorded transcript timeline through the matcher at its
 * recorded pace. Purely local; no network call. onMatch gets each chunk's newly matched indices (MEM-037).
 * @param {RecallTimeline} timeline
 * @param {Pick<Matcher, "append" | "results">} matcher
 * @param {{ wait?: (ms: number) => Promise<unknown>, onMatch?: (indices: number[]) => void }} [opts]
 */
export async function replayRecording(timeline, matcher, { wait = sleep, onMatch } = {}) {
  let prev = 0;
  for (const chunk of timeline.chunks) {
    await wait(chunk.t_ms - prev);
    prev = chunk.t_ms;
    const got = matcher.append(chunk.text);
    if (onMatch) onMatch(got);
  }
  return matcher.results();
}
