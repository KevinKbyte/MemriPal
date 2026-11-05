// @ts-check
// Live recall lighting (MEM-037): a board of the palace points that light while Kev speaks, fed by a relay
// that posts a short audio slice per tick through the unchanged recall relay (not streaming ASR).

import { countInOrder } from "./recall_match.js";

export const LIVE_SLICE_MS = 5000;

/** @typedef {import("./mic_wav.js").Grade} Grade */

/**
 * Keyword hits for this reply's text plus every Spark "correct" index (MEM-136); partial/miss never count.
 * @param {{ append: (text: string) => number[], gradeGot?: (i: number) => boolean }} matcher
 * @param {{ text: string, grade?: Grade }} reply
 * @returns {number[]} newly got indices, ascending and unique
 */
export function scoreReply(matcher, reply) {
  const hits = new Set(matcher.append(reply.text));
  for (const item of reply.grade?.items ?? []) {
    if (item.verdict === "correct" && matcher.gradeGot?.(item.index)) hits.add(item.index);
  }
  return [...hits].sort((a, b) => a - b);
}

/**
 * @param {{ label: string }[]} points
 * @param {Pick<Document, "createElement">} doc
 * @param {{ label: string, inOrder?: { starts: () => (number | null)[] } }} opts badge text: "LIVE" or
 *   "recorded replay"; inOrder (route practice, MEM-051) lights only rows counted in route order
 */
export function renderLiveBoard(points, doc, { label, inOrder }) {
  const badge = doc.createElement("p");
  badge.className = "live-badge";
  badge.textContent = label;
  const list = doc.createElement("ol");
  list.className = "live-board";
  const rows = points.map((p) => {
    const li = doc.createElement("li");
    li.textContent = p.label;
    return li;
  });
  list.append(...rows);
  const el = doc.createElement("div");
  el.append(badge, list);
  /** @type {HTMLElement | null} */
  let tagEl = null;
  /** @type {HTMLElement | null} */
  let noticeEl = null;
  return {
    el,
    /**
     * Which grader lit paraphrased points (MEM-136); textContent only, the provider is server-supplied.
     * @param {{ provider: string, latency_ms: number }} grade
     */
    tag(grade) {
      if (!tagEl) {
        tagEl = doc.createElement("p");
        tagEl.className = "grade-tag";
        badge.after(tagEl);
      }
      tagEl.textContent = `Spark - ${grade.provider} - ${grade.latency_ms} ms`;
    },
    /**
     * One dismissable notice that grading fell back to keyword match, offering the own-key prompt.
     * @param {() => void} onAddKey
     */
    downgrade(onAddKey) {
      if (noticeEl) return;
      const note = doc.createElement("div");
      note.className = "grade-downgrade";
      const msg = doc.createElement("p");
      msg.textContent = "Spark is unavailable, so recall is scored by keyword match.";
      const key = doc.createElement("button");
      key.className = "btn grade-downgrade-key";
      key.setAttribute("type", "button");
      key.textContent = "Use my own key";
      key.addEventListener("click", () => onAddKey());
      const dismiss = doc.createElement("button");
      dismiss.className = "btn grade-downgrade-dismiss";
      dismiss.setAttribute("type", "button");
      dismiss.textContent = "Dismiss";
      dismiss.addEventListener("click", () => {
        note.hidden = true;
      });
      note.append(msg, key, dismiss);
      badge.after(note);
      noticeEl = note;
    },
    /** @param {number[]} indices */
    light(indices) {
      if (inOrder) {
        // A later hit can uncount an earlier one, so every row is recomputed, not just the new indices.
        const counted = countInOrder(inOrder.starts());
        rows.forEach((row, i) => {
          row.classList.toggle("lit", counted[i] === true);
          if (counted[i]) row.dataset.state = "got";
          else delete row.dataset.state;
        });
        return;
      }
      for (const i of indices) {
        const row = Number.isInteger(i) ? rows[i] : undefined;
        if (!row) continue;
        row.classList.add("lit");
        row.dataset.state = "got";
      }
    },
  };
}

/**
 * Every `every` ms, take the newest slice of the clip and relay it; whatever the matcher newly finds goes to
 * onMatch. At most one slice is in the air: a tick during a post is skipped. The first failure stops the
 * relay and goes to onFail once.
 * @param {{
 *   clip: { take: () => Promise<Uint8Array | null> },
 *   post: (wav: Uint8Array) => Promise<{ text: string, grade?: Grade, gradeError?: boolean }>,
 *   matcher: { append: (text: string) => number[], gradeGot?: (i: number) => boolean },
 *   onMatch: (indices: number[]) => void,
 *   onFail: (err: unknown) => void,
 *   onGrade?: (grade: Grade) => void,
 *   onDowngrade?: () => void,
 *   every?: number,
 *   setInterval: (fn: () => void, ms: number) => unknown,
 *   clearInterval: (handle: any) => void,
 * }} opts
 */
export function createLiveRelay({
  clip,
  post,
  matcher,
  onMatch,
  onFail,
  onGrade,
  onDowngrade,
  every = LIVE_SLICE_MS,
  setInterval,
  clearInterval,
}) {
  let stopped = false;
  let downgraded = false;
  /** @type {Promise<void> | null} */
  let inFlight = null;
  const halt = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(handle);
  };
  const send = async () => {
    try {
      const wav = await clip.take();
      if (!wav) return;
      const reply = await post(wav);
      onMatch(scoreReply(matcher, reply));
      if (reply.grade) onGrade?.(reply.grade);
      if (reply.gradeError && !downgraded) {
        downgraded = true;
        onDowngrade?.();
      }
    } catch (err) {
      halt();
      onFail(err);
    } finally {
      inFlight = null;
    }
  };
  const handle = setInterval(() => {
    if (!stopped && !inFlight) inFlight = send();
  }, every);
  return {
    // Never rejects: an in-flight post's failure goes to onFail.
    async stop() {
      halt();
      await inFlight;
    },
  };
}
