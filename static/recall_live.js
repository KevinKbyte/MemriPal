// @ts-check
// Live recall lighting (MEM-037): a board of the palace points that light while Kev speaks, fed by a relay
// that posts a short audio slice per tick through the unchanged recall relay (not streaming ASR).

export const LIVE_SLICE_MS = 5000;

/**
 * @param {{ label: string }[]} points
 * @param {Pick<Document, "createElement">} doc
 * @param {{ label: string }} opts badge text: "LIVE" or "recorded replay"
 */
export function renderLiveBoard(points, doc, { label }) {
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
  return {
    el,
    /** @param {number[]} indices */
    light(indices) {
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
 *   post: (wav: Uint8Array) => Promise<{ text: string }>,
 *   matcher: { append: (text: string) => number[] },
 *   onMatch: (indices: number[]) => void,
 *   onFail: (err: unknown) => void,
 *   every?: number,
 *   setInterval: (fn: () => void, ms: number) => unknown,
 *   clearInterval: (handle: any) => void,
 * }} opts
 */
export function createLiveRelay({ clip, post, matcher, onMatch, onFail, every = LIVE_SLICE_MS, setInterval, clearInterval }) {
  let stopped = false;
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
      const { text } = await post(wav);
      onMatch(matcher.append(text));
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
