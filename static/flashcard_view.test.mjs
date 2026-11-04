// Covers: MEM-125
// Requirement: Recall flashcards (Anki-style supplemental review of a memory palace route's material). One card
// renders as an article.flashcard carrying data-card-id. Before the user answers, the card shows only the cue:
// `Stop <n>`, the locus (card.front) and the prompt "What did you place here?"; the answer, its source and the
// route tag stay hidden. "Show answer" reveals the answer (plus the source quote when it differs from the
// answer), the route tag chip (text = route name, aria-label `Route: <route name>`), the Again / Got it rating
// buttons and a note editor, and hides itself. Again / Got it report onGrade(card.id, "again" | "good"); the
// note editor is pre-filled with the card's note (empty when it has none), capped at 1000 characters, and
// "Save note" reports onNote(card.id, edited text). Card text is user/AI material: it always renders as text
// (no HTML writes, no image loads) and the view never writes inline styles (CSP-safe).
// Contract (RED; GREEN implements static/flashcard_view.js):
//   renderFlashcard(doc, card, { onGrade, onNote }) -> HTMLElement (article)
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { renderFlashcard } from "./flashcard_view.js";
import { fakePage, find, findAll, visibleText } from "./fake_dom_test.mjs";

const PROMPT = "What did you place here?";

function makeCard(overrides = {}) {
  return {
    id: "item-1:st-3",
    routeId: "r1",
    routeName: "Morning Walk",
    itemId: "item-1",
    itemTitle: "Krebs cycle",
    stationId: "st-3",
    n: 3,
    front: "Front door",
    back: "Copper kettle",
    source: "the copper kettle whistles at dawn",
    deadline: null,
    note: "Kettle steams on the doormat",
    review: null,
    ...overrides,
  };
}

function setup(cardOverrides = {}) {
  const page = fakePage([]);
  const grades = [];
  const notes = [];
  const card = makeCard(cardOverrides);
  const root = renderFlashcard(page.doc, card, {
    onGrade: (...args) => grades.push(args),
    onNote: (...args) => notes.push(args),
  });
  const has = (cls) => (n) => n.classList.contains(cls);
  const byAction = (action) => (n) => n.dataset.action === action;
  const byRating = (rating) => (n) => n.dataset.rating === rating;
  const reveal = () => {
    const btn = find(root, byAction("show-answer"));
    assert.ok(btn, "a data-action=show-answer button exists");
    page.fire(btn, "click");
  };
  return { page, card, root, grades, notes, has, byAction, byRating, reveal };
}

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function styleWrites(page) {
  const out = [];
  for (const e of page.madeByCode()) {
    const keys = Object.keys(e.style).filter((k) => k !== "setProperty" && k !== "removeProperty");
    if (keys.length) out.push([e.tagName, keys]);
    if ("style" in e.attrs) out.push([e.tagName, "style attribute"]);
  }
  return out;
}

describe("renderFlashcard (MEM-125)", () => {
  test("root is an article with class flashcard and data-card-id = card.id", () => {
    const { root, card } = setup();
    assert.equal(root.tagName, "ARTICLE");
    assert.ok(root.classList.contains("flashcard"), "root has class flashcard");
    assert.equal(root.dataset.cardId, card.id);
  });

  test("before reveal: shows Stop <n>, the locus and the prompt, not the answer, source or route name", () => {
    const { root, has, byAction } = setup();
    const text = visibleText(root);
    assert.ok(text.includes("Stop 3"), `visible text has "Stop 3": ${text}`);
    assert.ok(text.includes("Front door"), "visible text has the locus (card.front)");
    assert.ok(text.includes(PROMPT), "visible text has the prompt");
    assert.ok(!text.includes("Copper kettle"), "answer is hidden before reveal");
    assert.ok(!text.includes("the copper kettle whistles at dawn"), "source is hidden before reveal");
    assert.ok(!text.includes("Morning Walk"), "route name is hidden before reveal");
    const btn = find(root, byAction("show-answer"), { visibleOnly: true });
    assert.ok(btn, "Show answer button is visible before reveal");
    assert.equal(btn.textContent, "Show answer");
    assert.equal(find(root, has("flashcard-route"), { visibleOnly: true }), null, "route chip hidden before reveal");
  });

  test("before reveal: rating buttons and the note editor are not visible", () => {
    const { root, has, byRating, byAction } = setup();
    assert.equal(find(root, byRating("again"), { visibleOnly: true }), null);
    assert.equal(find(root, byRating("good"), { visibleOnly: true }), null);
    assert.equal(find(root, has("flashcard-note"), { visibleOnly: true }), null);
    assert.equal(find(root, byAction("save-note"), { visibleOnly: true }), null);
  });

  test("Show answer reveals the answer, the differing source and the route tag chip, and hides itself", () => {
    const { root, has, byAction, reveal } = setup();
    reveal();
    const text = visibleText(root);
    assert.ok(text.includes("Copper kettle"), `answer visible after reveal: ${text}`);
    assert.ok(text.includes("the copper kettle whistles at dawn"), "source visible when it differs from back");
    assert.ok(text.includes("Front door"), "locus stays visible after reveal");
    const chip = find(root, has("flashcard-route"), { visibleOnly: true });
    assert.ok(chip, "route tag chip (class flashcard-route) is visible after reveal");
    assert.equal(chip.textContent, "Morning Walk");
    assert.equal(chip.getAttribute("aria-label"), "Route: Morning Walk");
    assert.equal(find(root, byAction("show-answer"), { visibleOnly: true }), null, "Show answer button hidden after reveal");
    const back = find(root, has("flashcard-back"));
    assert.ok(back, "a flashcard-back part exists");
    assert.equal(back.hidden, false, "flashcard-back is unhidden after reveal");
  });

  test("source equal to the answer is not repeated", () => {
    const { root, reveal } = setup({ back: "Copper kettle", source: "Copper kettle", note: "" });
    reveal();
    assert.equal(count(visibleText(root), "Copper kettle"), 1, "answer appears exactly once");
  });

  test("Again click calls onGrade(card.id, 'again')", () => {
    const { root, page, grades, notes, byRating, reveal } = setup();
    reveal();
    const again = find(root, byRating("again"), { visibleOnly: true });
    assert.ok(again, "data-rating=again button visible after reveal");
    assert.equal(again.textContent, "Again");
    page.fire(again, "click");
    assert.deepEqual(grades, [["item-1:st-3", "again"]]);
    assert.deepEqual(notes, []);
  });

  test("Got it click calls onGrade(card.id, 'good')", () => {
    const { root, page, grades, notes, byRating, reveal } = setup();
    reveal();
    const good = find(root, byRating("good"), { visibleOnly: true });
    assert.ok(good, "data-rating=good button visible after reveal");
    assert.equal(good.textContent, "Got it");
    page.fire(good, "click");
    assert.deepEqual(grades, [["item-1:st-3", "good"]]);
    assert.deepEqual(notes, []);
  });

  test("note editor is a textarea pre-filled with card.note, maxlength 1000, labelled", () => {
    const { root, has, reveal } = setup();
    reveal();
    const ta = find(root, has("flashcard-note"), { visibleOnly: true });
    assert.ok(ta, "note editor (class flashcard-note) visible after reveal");
    assert.equal(ta.tagName, "TEXTAREA");
    assert.equal(ta.value, "Kettle steams on the doormat");
    assert.equal(Number(ta.getAttribute("maxlength") ?? ta.maxLength), 1000);
    assert.equal(ta.getAttribute("aria-label"), "Your note for this card");
  });

  test("note editor is empty when the card has no note", () => {
    const { root, has, reveal } = setup({ note: undefined });
    reveal();
    const ta = find(root, has("flashcard-note"));
    assert.ok(ta, "note editor exists");
    assert.equal(ta.value, "");
  });

  test("Save note calls onNote(card.id, edited textarea value)", () => {
    const { root, page, has, byAction, grades, notes, reveal } = setup();
    reveal();
    const ta = find(root, has("flashcard-note"));
    ta.value = "Kettle whistles the citrate song";
    const save = find(root, byAction("save-note"), { visibleOnly: true });
    assert.ok(save, "data-action=save-note button visible after reveal");
    assert.equal(save.textContent, "Save note");
    page.fire(save, "click");
    assert.deepEqual(notes, [["item-1:st-3", "Kettle whistles the citrate song"]]);
    assert.deepEqual(grades, []);
  });

  test("hostile card text renders as text: no HTML writes, no image elements or loads", () => {
    const evil = "<img src=x onerror=alert(1)>";
    const { root, page, has, reveal } = setup({
      front: `Door ${evil}`,
      back: `Kettle ${evil}`,
      source: `quote ${evil}`,
      routeName: `Walk ${evil}`,
      note: `note ${evil}`,
    });
    reveal();
    const text = visibleText(root);
    assert.ok(text.includes(`Door ${evil}`), "hostile front shown as literal text");
    assert.ok(text.includes(`Kettle ${evil}`), "hostile back shown as literal text");
    assert.ok(text.includes(`quote ${evil}`), "hostile source shown as literal text");
    const chip = find(root, has("flashcard-route"));
    assert.equal(chip.textContent, `Walk ${evil}`);
    assert.equal(chip.getAttribute("aria-label"), `Route: Walk ${evil}`);
    assert.equal(find(root, has("flashcard-note")).value, `note ${evil}`);
    assert.deepEqual(page.htmlWrites, []);
    assert.deepEqual(page.srcWrites, []);
    assert.deepEqual(findAll(root, (n) => n.tagName === "IMG"), []);
  });

  test("no inline style writes before or after reveal", () => {
    const { page, reveal } = setup();
    assert.deepEqual(styleWrites(page), [], "no style writes on render");
    reveal();
    assert.deepEqual(styleWrites(page), [], "no style writes on reveal");
  });
});
