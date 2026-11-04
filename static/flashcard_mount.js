// @ts-check
// Recall tab mount for the flashcards deck (MEM-125 phase B). Reads the route KV directly: routes, raw
// MemorizeItems (`list:<id>`, no type field) and card overlays all live there; one card is shown at a time.

import { createFlashcardStore, deriveCards, dueOrder, grade, mergeUserEdits } from "./flashcard_deck.js";
import { renderFlashcard } from "./flashcard_view.js";

/** @typedef {import("./flashcard_deck.js").Card} Card */

const MSG = {
  empty: "No flashcards yet. Memorize a list onto a route to make some.",
  caughtUp: "All caught up: no cards due.",
  loadFailed: "Flashcards could not load.",
  rateFailed: "Rating not saved. Try again.",
  noteSaved: "Note saved.",
  noteFailed: "Note not saved. Try again.",
};

const STYLE_HREF = "/static/flashcards.css";

/**
 * Links flashcards.css once from <head>, as pal_bubble.js does: index.html's <link> list is pinned (MEM-040,
 * tests/test_assets_wiring.py). Walks head.children: the test fake DOM has no querySelector, and no head.
 * @param {any} doc
 */
function linkStylesheet(doc) {
  if (!doc.head) return;
  const linked = [...doc.head.children].some(
    (/** @type {any} */ n) =>
      n.tagName === "LINK" && n.getAttribute("rel") === "stylesheet" && n.getAttribute("href") === STYLE_HREF,
  );
  if (linked) return;
  const link = doc.createElement("link");
  link.setAttribute("rel", "stylesheet");
  link.setAttribute("href", STYLE_HREF);
  doc.head.append(link);
}

/** saveMemorizeItem stores the item as-is, so it is told apart from typed values by shape. @param {any} v */
const isItem = (v) =>
  v != null && v.type === undefined && typeof v.route_id === "string" && Array.isArray(v.keywords);

/**
 * @param {Document} doc
 * @param {{ adapter: import("./route_store.js").KvAdapter, now?: () => number }} deps
 * @returns {{ ready: Promise<void>, refresh: () => Promise<void> } | null}
 */
export function mountFlashcards(doc, { adapter, now = Date.now }) {
  const status = doc.getElementById("flashcards-status");
  const slot = doc.getElementById("flashcards-card");
  if (!status || !slot) return null;
  linkStylesheet(doc);
  const store = createFlashcardStore(adapter);
  /** @type {Card | null} */
  let current = null;
  let grading = false;

  /** @param {Card[]} due @param {number} total */
  const show = (due, total) => {
    current = due[0] ?? null;
    if (!current) {
      slot.replaceChildren();
      status.textContent = total ? MSG.caughtUp : MSG.empty;
      return;
    }
    status.textContent = `${due.length} card${due.length === 1 ? "" : "s"} due`;
    slot.replaceChildren(renderFlashcard(doc, current, { onGrade, onNote }));
  };

  const refresh = async () => {
    try {
      const values = await adapter.list();
      const routes = values.filter((v) => v?.type === "route" && v.route).map((v) => v.route);
      const cards = mergeUserEdits(deriveCards(routes, values.filter(isItem)), await store.list());
      show(dueOrder(cards, now()), cards.length);
    } catch {
      current = null;
      slot.replaceChildren();
      status.textContent = MSG.loadFailed;
    }
  };

  /** @param {string} id @param {string} rating */
  async function onGrade(id, rating) {
    // One save at a time: a double tap must not grade the card twice or grade the next one unseen.
    if (grading || current?.id !== id) return;
    grading = true;
    try {
      await store.setReview(id, grade(current, rating, now()));
    } catch {
      status.textContent = MSG.rateFailed;
      grading = false;
      return;
    }
    await refresh();
    grading = false;
  }

  /** @param {string} id @param {string} note */
  async function onNote(id, note) {
    try {
      await store.setNote(id, note);
      status.textContent = MSG.noteSaved;
    } catch {
      status.textContent = MSG.noteFailed;
    }
  }

  return { ready: refresh(), refresh };
}
