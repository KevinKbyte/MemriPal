// @ts-check
// One Recall flashcard (MEM-125, ADR 0076). Card text is user/AI material, so every string goes through
// textContent / value, never HTML, and the view sets no inline style (the CSP refuses style attributes).

import { NOTE_MAX, RATINGS } from "./flashcard_deck.js";

/** @typedef {import("./flashcard_deck.js").Card} Card */

const RATING_LABELS = { again: "Again", good: "Got it" };

/**
 * @param {Document} doc
 * @param {string} tag
 * @param {string} [cls]
 * @param {string} [text]
 */
function make(doc, tag, cls, text) {
  const node = doc.createElement(tag);
  if (cls) node.classList.add(cls);
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * @param {Document} doc
 * @param {Card} card
 * @param {{ onGrade: (id: string, rating: string) => void, onNote: (id: string, note: string) => void }} handlers
 * @returns {HTMLElement}
 */
export function renderFlashcard(doc, card, { onGrade, onNote }) {
  const root = make(doc, "article", "flashcard");
  root.setAttribute("data-card-id", card.id);

  const front = make(doc, "div", "flashcard-front");
  front.append(
    make(doc, "p", "flashcard-stop", `Stop ${card.n}`),
    make(doc, "p", "flashcard-locus", card.front),
    make(doc, "p", "flashcard-prompt", "What did you place here?"),
  );

  const show = make(doc, "button", "flashcard-show", "Show answer");
  show.setAttribute("type", "button");
  show.setAttribute("data-action", "show-answer");

  const back = make(doc, "div", "flashcard-back");
  back.hidden = true;
  back.append(make(doc, "p", "flashcard-answer", card.back));
  if (card.source && card.source !== card.back) {
    back.append(make(doc, "p", "flashcard-source", card.source));
  }
  const chip = make(doc, "span", "flashcard-route", card.routeName);
  chip.setAttribute("aria-label", `Route: ${card.routeName}`);
  back.append(chip);

  const ratings = make(doc, "div", "flashcard-ratings");
  for (const rating of RATINGS) {
    const btn = make(doc, "button", "flashcard-rate", RATING_LABELS[/** @type {"again" | "good"} */ (rating)]);
    btn.setAttribute("type", "button");
    btn.setAttribute("data-rating", rating);
    btn.addEventListener("click", () => onGrade(card.id, rating));
    ratings.append(btn);
  }

  const note = /** @type {HTMLTextAreaElement} */ (make(doc, "textarea", "flashcard-note"));
  note.setAttribute("aria-label", "Your note for this card");
  note.setAttribute("maxlength", String(NOTE_MAX));
  note.setAttribute("rows", "2");
  note.setAttribute("placeholder", "Add a note (optional)");
  note.value = card.note ?? "";
  const save = make(doc, "button", "flashcard-save", "Save note");
  save.setAttribute("type", "button");
  save.setAttribute("data-action", "save-note");
  save.addEventListener("click", () => onNote(card.id, note.value));
  const noteRow = make(doc, "div", "flashcard-note-row");
  noteRow.append(note, save);

  // Ratings last: grading moves the deck on, so the note editor must come before it.
  back.append(noteRow, ratings);

  show.addEventListener("click", () => {
    back.hidden = false;
    show.hidden = true;
  });

  root.append(front, show, back);
  return root;
}
