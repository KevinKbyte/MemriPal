// @ts-check
// Recall flashcards (MEM-125, ADR 0076): cards are derived at read time from the material a MemorizeItem placed
// on a route's loci; only the user's overlay (note + review state) is stored, keyed by the stable card id, so
// regenerating keywords or renaming stations never loses a note. Grading uses the fixed MEM-090 schedule.

import { recallSchedule } from "./recall_schedule.js";

const DAY = 24 * 60 * 60 * 1000;
export const NOTE_MAX = 1000;
// Two ratings only: ADR 0049's schedule is fixed, so finer Anki ratings would change nothing.
export const RATINGS = Object.freeze(["again", "good"]);
const CARD_KEY = (/** @type {string} */ id) => `card:${id}`;

/**
 * @typedef {{ start: number, due: number | null }} Review due null = schedule exhausted, the card is finished
 * @typedef {{
 *   id: string, routeId: string, routeName: string, itemId: string, itemTitle: string, stationId: string,
 *   n: number, front: string, back: string, source: string, deadline: number | null,
 *   note?: string, review?: Review | null,
 * }} Card
 * @typedef {{ id: string, note: string, review: Review | null }} CardRecord
 * @typedef {import("./route_store.js").KvAdapter} KvAdapter
 */

/**
 * Keyword i of an item sits on the i-th named station of its route (memorize.js associateKeywords).
 * @param {any[] | null | undefined} routes route_store.js Route shape
 * @param {any[] | null | undefined} items MemorizeItem shape (ADR 0048)
 * @returns {Card[]}
 */
export function deriveCards(routes, items) {
  const byId = new Map((routes ?? []).map((r) => [r.id, r]));
  const cards = [];
  for (const item of items ?? []) {
    const route = byId.get(item.route_id);
    if (!route) continue;
    const named = route.stations.filter((/** @type {any} */ s) => s.status === "named");
    const parsed = item.remember_by == null ? NaN : Date.parse(item.remember_by);
    const deadline = Number.isNaN(parsed) ? null : parsed;
    const n = Math.min(item.keywords.length, named.length);
    for (let i = 0; i < n; i++) {
      const station = named[i];
      const keyword = item.keywords[i];
      cards.push({
        id: `${item.id}:${station.id}`,
        routeId: route.id,
        routeName: route.name,
        itemId: item.id,
        itemTitle: item.title,
        stationId: station.id,
        n: station.n,
        front: station.name,
        back: keyword.label,
        source: keyword.source_quote,
        deadline,
      });
    }
  }
  return cards;
}

/**
 * @param {Card[]} cards @param {CardRecord[]} records records for ids no longer derived are ignored
 * @returns {Card[]}
 */
export function mergeUserEdits(cards, records) {
  const byId = new Map(records.map((r) => [r.id, r]));
  return cards.map((c) => {
    const r = byId.get(c.id);
    return { ...c, note: r?.note ?? "", review: r?.review ?? null };
  });
}

/**
 * @param {Card} card @param {string} rating one of RATINGS @param {number} now epoch ms
 * @returns {Review}
 */
export function grade(card, rating, now) {
  if (!RATINGS.includes(/** @type {string} */ (rating))) throw new TypeError(`unknown rating: ${rating}`);
  const start = card.review?.start ?? now;
  // ADR 0049: a failed recall adds a +1d re-review.
  if (rating === "again") return { start, due: now + DAY };
  const next = recallSchedule(card.deadline, { now: () => start }).find((t) => t > now);
  return { start, due: next ?? null };
}

/**
 * Cards to review now: new ones (treated as due now) and those whose due time has come, earliest first.
 * @param {Card[]} cards @param {number} now epoch ms
 * @returns {Card[]}
 */
export function dueOrder(cards, now) {
  const dueAt = (/** @type {Card} */ c) => (c.review ? c.review.due : now);
  const cmp = (/** @type {any} */ a, /** @type {any} */ b) => (a < b ? -1 : a > b ? 1 : 0);
  return cards
    .filter((c) => {
      const due = dueAt(c);
      return due !== null && due <= now;
    })
    .sort((a, b) => cmp(dueAt(a), dueAt(b)) || cmp(a.routeName, b.routeName) || cmp(a.n, b.n) || cmp(a.id, b.id));
}

/** @param {unknown} v */
const isTime = (v) => typeof v === "number" && Number.isFinite(v);

/** @param {any} review @returns {review is Review} */
const isReview = (review) => isTime(review?.start) && (review.due === null || isTime(review.due));

/**
 * Notes and review state in the route KV; values carry type "card" (route_store.js lists only type "route").
 * @param {Pick<KvAdapter, "get" | "put" | "list">} adapter
 */
export function createFlashcardStore(adapter) {
  /** @type {Promise<unknown>} */
  let tail = Promise.resolve();
  // Read-modify-write per call; serialized so a note and a review saved together on one card both land.
  const serial = (/** @type {() => Promise<CardRecord>} */ fn) => {
    const run = tail.then(fn);
    tail = run.catch(() => {});
    return run;
  };

  /** @param {string} id @param {Partial<CardRecord>} patch */
  const update = async (id, patch) => {
    const old = await adapter.get(CARD_KEY(id));
    const rec = { id, note: old?.note ?? "", review: old?.review ?? null, ...patch };
    await adapter.put(CARD_KEY(id), { type: "card", ...rec });
    return rec;
  };

  return {
    /** @returns {Promise<CardRecord[]>} */
    list: async () =>
      (await adapter.list())
        .filter((v) => v?.type === "card")
        .map((v) => ({ id: v.id, note: v.note, review: v.review })),

    /** @param {string} id @param {unknown} note @returns {Promise<CardRecord>} */
    setNote: (id, note) =>
      serial(async () => {
        if (typeof note !== "string" || note.trim().length > NOTE_MAX) {
          throw new TypeError(`note must be text of at most ${NOTE_MAX} characters`);
        }
        return update(id, { note: note.trim() });
      }),

    /** @param {string} id @param {unknown} review @returns {Promise<CardRecord>} */
    setReview: (id, review) =>
      serial(async () => {
        if (!isReview(review)) throw new TypeError("review must be { start: number, due: number | null }");
        return update(id, { review: { start: review.start, due: review.due } });
      }),
  };
}
