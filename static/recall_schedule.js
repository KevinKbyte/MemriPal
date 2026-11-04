// @ts-check
// Recall schedule (ADR 0049 schedule (a), MEM-090): review times before a memorized item's deadline.
// Pure: time comes only from the injected clock, and a day is a fixed 86_400_000 ms (no local calendar).

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const SAME_DAY_OFFSETS = [10 * MIN, HOUR];
const NO_DEADLINE_DAYS = [1, 3, 7, 14, 30, 60, 120];

/**
 * @param {number | null | undefined} deadline epoch ms, or null / undefined for no deadline
 * @param {{ now: () => number }} opts
 * @returns {number[]} review times, epoch ms, strictly ascending
 */
export function recallSchedule(deadline, { now }) {
  const start = now();
  if (deadline == null) return NO_DEADLINE_DAYS.map((d) => start + d * DAY);
  if (deadline <= start) return [];
  const sameDay = SAME_DAY_OFFSETS.map((offset) => start + offset);
  if (deadline - start <= DAY) return [...sameDay, start + 4 * HOUR].filter((t) => t < deadline);
  // Countdown doubling T-1d, T-2d, T-4d ... while the anchor stays on or after the S+1d floor.
  const anchors = [];
  for (let back = DAY; deadline - back >= start + DAY; back *= 2) anchors.unshift(deadline - back);
  // Drop an anchor within 1d of the review before it; doubling gaps are >= 1d, so only the earliest
  // anchor can trip this, against S+1h.
  const out = [...sameDay];
  for (const t of anchors) if (t - out[out.length - 1] >= DAY) out.push(t);
  return out;
}
