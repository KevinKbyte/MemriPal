// Covers: MEM-125
// Requirement: The Recall tab shows the Recall flashcards deck (MEM-125) built from what the user memorized onto
// their routes. On open it reads the route KV (routes, MemorizeItems, card notes/reviews; photos are ignored),
// derives one card per keyword placed on a named station, and shows the first due card plus a status line:
// "No flashcards yet. Memorize a list onto a route to make some." when nothing is derivable, "All caught up: no
// cards due." when nothing is due, `1 card due` / `<k> cards due` otherwise, and "Flashcards could not load."
// when the KV read fails. Grading a revealed card (Again / Got it) saves its review on the fixed MEM-090
// schedule and moves on to the next due card; a second rating while the save is pending is ignored, and a failed
// save says "Rating not saved. Try again." and keeps the card. Saving a note stores the trimmed text and says
// "Note saved." ("Note not saved. Try again." on failure, card kept). Card text always renders as text.
// Contract (RED; GREEN implements static/flashcard_mount.js):
//   mountFlashcards(doc, { adapter, now = Date.now }) -> { ready: Promise<void>, refresh: () => Promise<void> } | null
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { mountFlashcards } from "./flashcard_mount.js";
import { fakePage, find, findAll, settle, until, deferred } from "./fake_dom_test.mjs";

const NOW = Date.UTC(2026, 10, 4, 12);
const DAY = 24 * 60 * 60 * 1000;
const IDS = ["flashcards-status", "flashcards-card"];

const MSG = {
  empty: "No flashcards yet. Memorize a list onto a route to make some.",
  caughtUp: "All caught up: no cards due.",
  loadFailed: "Flashcards could not load.",
  rateFailed: "Rating not saved. Try again.",
  noteSaved: "Note saved.",
  noteFailed: "Note not saved. Try again.",
};

function makeRoute(overrides = {}) {
  return {
    id: "r1",
    name: "Morning Walk",
    stations: [
      { id: "st-1", n: 1, name: "Front door", status: "named" },
      { id: "st-2", n: 2, name: "Hallway", status: "named" },
      { id: "st-3", n: 3, name: "Kitchen", status: "pending" },
    ],
    ...overrides,
  };
}

function makeItem(overrides = {}) {
  return {
    id: "item-1",
    title: "Krebs cycle",
    text: "the copper kettle whistles; the brass bell rings",
    keywords: [
      { label: "Copper kettle", source_quote: "the copper kettle whistles" },
      { label: "Brass bell", source_quote: "the brass bell rings" },
    ],
    route_id: "r1",
    placements: {},
    created_at: "2026-11-01T09:00:00Z",
    ...overrides,
  };
}

/** In-memory route KV (route_store.js KvAdapter shape); list() resolves to every stored value. */
function fakeKv(entries = []) {
  const map = new Map(entries.map(([k, v]) => [k, structuredClone(v)]));
  const calls = [];
  const puts = [];
  const kv = {
    map,
    calls,
    puts,
    /** When set, put(key, value) awaits holdPut(key, value) before storing (it may reject). */
    holdPut: null,
    listFails: false,
    async get(key) {
      calls.push("get");
      return map.has(key) ? structuredClone(map.get(key)) : undefined;
    },
    async put(key, value) {
      calls.push("put");
      puts.push(key);
      if (kv.holdPut) await kv.holdPut(key, value);
      map.set(key, structuredClone(value));
    },
    async delete(key) {
      calls.push("delete");
      map.delete(key);
    },
    async list() {
      calls.push("list");
      if (kv.listFails) throw new Error("kv unavailable");
      return [...map.values()].map((v) => structuredClone(v));
    },
  };
  return kv;
}

function seeded({ item = makeItem(), route = makeRoute(), extra = [] } = {}) {
  return fakeKv([
    ["route:r1", { type: "route", route }],
    [`list:${item.id}`, item],
    ["photo:r1:st-1", { type: "photo", bytes: new Uint8Array([1, 2, 3]) }],
    ...extra,
  ]);
}

async function mount(kv, ids = IDS) {
  const page = fakePage(ids);
  const api = mountFlashcards(page.doc, { adapter: kv, now: () => NOW });
  if (api) await api.ready;
  const status = page.els["flashcards-status"];
  const slot = page.els["flashcards-card"];
  const cards = () => findAll(slot, (n) => n.tagName === "ARTICLE" && n.classList.contains("flashcard"));
  const cardId = () => cards()[0]?.dataset.cardId ?? null;
  const byAction = (action) => find(slot, (n) => n.dataset.action === action);
  const byRating = (rating) => find(slot, (n) => n.dataset.rating === rating);
  const noteBox = () => find(slot, (n) => n.classList.contains("flashcard-note"));
  const reveal = () => {
    const btn = byAction("show-answer");
    assert.ok(btn, "the shown card has a data-action=show-answer button");
    page.fire(btn, "click");
  };
  const rate = (rating) => {
    const btn = byRating(rating);
    assert.ok(btn, `the shown card has a data-rating=${rating} button`);
    page.fire(btn, "click");
  };
  return { page, api, status, slot, cards, cardId, byAction, byRating, noteBox, reveal, rate };
}

const putsFor = (kv, key) => kv.puts.filter((k) => k === key).length;

describe("mountFlashcards (MEM-125)", () => {
  test("returns null and touches no KV when #flashcards-status is missing", async () => {
    const kv = seeded();
    const page = fakePage(["flashcards-card"]);
    assert.equal(mountFlashcards(page.doc, { adapter: kv, now: () => NOW }), null);
    await settle();
    assert.deepEqual(kv.calls, []);
  });

  test("returns null and touches no KV when #flashcards-card is missing", async () => {
    const kv = seeded();
    const page = fakePage(["flashcards-status"]);
    assert.equal(mountFlashcards(page.doc, { adapter: kv, now: () => NOW }), null);
    await settle();
    assert.deepEqual(kv.calls, []);
  });

  test("empty KV: 'No flashcards yet' status and an empty card slot", async () => {
    const { api, status, slot } = await mount(fakeKv());
    assert.equal(typeof api.refresh, "function");
    assert.equal(status.textContent, MSG.empty);
    assert.equal(slot.children.length, 0);
  });

  test("a route with no memorized item and a photo value only: still 'No flashcards yet'", async () => {
    const kv = fakeKv([
      ["route:r1", { type: "route", route: makeRoute() }],
      ["photo:r1:st-1", { type: "photo", bytes: new Uint8Array([9]) }],
    ]);
    const { status, slot } = await mount(kv);
    assert.equal(status.textContent, MSG.empty);
    assert.equal(slot.children.length, 0);
  });

  test("two new cards: '2 cards due' and exactly one article.flashcard, the first in due order", async () => {
    const { status, cards, cardId } = await mount(seeded());
    assert.equal(status.textContent, "2 cards due");
    assert.equal(cards().length, 1, "the slot holds exactly one card");
    assert.equal(cardId(), "item-1:st-1");
  });

  test("one new card: singular '1 card due'", async () => {
    const item = makeItem({ keywords: [{ label: "Copper kettle", source_quote: "the copper kettle whistles" }] });
    const { status, cardId } = await mount(seeded({ item }));
    assert.equal(status.textContent, "1 card due");
    assert.equal(cardId(), "item-1:st-1");
  });

  test("stored review records are merged: an overdue card comes first and shows its saved note", async () => {
    const overdue = { type: "card", id: "item-1:st-2", note: "Bell by the coats", review: { start: NOW - 3 * DAY, due: NOW - 1000 } };
    const { status, cardId, noteBox } = await mount(seeded({ extra: [["card:item-1:st-2", overdue]] }));
    assert.equal(status.textContent, "2 cards due");
    assert.equal(cardId(), "item-1:st-2");
    assert.equal(noteBox().value, "Bell by the coats");
  });

  test("cards exist but none due: 'All caught up' status and an empty slot", async () => {
    const later = { type: "card", id: "item-1:st-1", note: "", review: { start: NOW - DAY, due: NOW + DAY } };
    const finished = { type: "card", id: "item-1:st-2", note: "", review: { start: NOW - 200 * DAY, due: null } };
    const kv = seeded({ extra: [["card:item-1:st-1", later], ["card:item-1:st-2", finished]] });
    const { status, slot } = await mount(kv);
    assert.equal(status.textContent, MSG.caughtUp);
    assert.equal(slot.children.length, 0);
  });

  test("KV list rejects: 'Flashcards could not load.' and an empty slot", async () => {
    const kv = seeded();
    kv.listFails = true;
    const { status, slot } = await mount(kv);
    assert.equal(status.textContent, MSG.loadFailed);
    assert.equal(slot.children.length, 0);
  });

  test("refresh() re-reads the KV: a list memorized after mount shows up", async () => {
    const kv = fakeKv();
    const { api, status, cardId } = await mount(kv);
    assert.equal(status.textContent, MSG.empty);
    kv.map.set("route:r1", { type: "route", route: makeRoute() });
    kv.map.set("list:item-1", makeItem());
    await api.refresh();
    assert.equal(status.textContent, "2 cards due");
    assert.equal(cardId(), "item-1:st-1");
  });

  test("'Got it' on a new card saves review {start: now, due: now + 1d} and moves to the next due card", async () => {
    const kv = seeded();
    const { status, cardId, reveal, rate } = await mount(kv);
    reveal();
    rate("good");
    await until(() => cardId() === "item-1:st-2", "next due card shown after grading");
    assert.deepEqual(kv.map.get("card:item-1:st-1"), {
      type: "card",
      id: "item-1:st-1",
      note: "",
      review: { start: NOW, due: NOW + DAY },
    });
    assert.equal(status.textContent, "1 card due");
  });

  test("'Again' on the last due card saves due = now + 1d and shows 'All caught up'", async () => {
    const item = makeItem({ keywords: [{ label: "Copper kettle", source_quote: "the copper kettle whistles" }] });
    const kv = seeded({ item });
    const { status, slot, reveal, rate } = await mount(kv);
    reveal();
    rate("again");
    await until(() => status.textContent === MSG.caughtUp, "caught-up status after the last card is graded");
    assert.deepEqual(kv.map.get("card:item-1:st-1").review, { start: NOW, due: NOW + DAY });
    assert.equal(slot.children.length, 0);
  });

  test("a second rating click while the first save is pending is ignored (one put)", async () => {
    const kv = seeded();
    const gate = deferred();
    kv.holdPut = () => gate.promise;
    const { cardId, reveal, byRating, page } = await mount(kv);
    reveal();
    const good = byRating("good");
    const again = byRating("again");
    page.fire(good, "click");
    await until(() => kv.puts.length === 1, "first grade save reached put");
    page.fire(again, "click");
    page.fire(good, "click");
    await settle();
    assert.equal(putsFor(kv, "card:item-1:st-1"), 1, "only one put while the save is pending");
    kv.holdPut = null;
    gate.resolve();
    await until(() => cardId() === "item-1:st-2", "next card after the held save lands");
    assert.equal(putsFor(kv, "card:item-1:st-1"), 1, "no late second put");
    assert.deepEqual(kv.map.get("card:item-1:st-1").review, { start: NOW, due: NOW + DAY }, "the first rating (good) won");
  });

  test("grade put rejects: 'Rating not saved. Try again.' and the same card stays", async () => {
    const kv = seeded();
    kv.holdPut = async () => {
      throw new Error("quota");
    };
    const { status, cardId, cards, reveal, rate } = await mount(kv);
    reveal();
    rate("good");
    await until(() => status.textContent === MSG.rateFailed, "rating failure status");
    assert.equal(cards().length, 1);
    assert.equal(cardId(), "item-1:st-1");
    assert.equal(kv.map.has("card:item-1:st-1"), false);
  });

  test("Save note stores the trimmed note under card:<id> and says 'Note saved.'", async () => {
    const kv = seeded();
    const { status, cardId, reveal, byAction, noteBox, page } = await mount(kv);
    reveal();
    noteBox().value = "  Kettle hums the citrate song  ";
    page.fire(byAction("save-note"), "click");
    await until(() => status.textContent === MSG.noteSaved, "note saved status");
    const rec = kv.map.get("card:item-1:st-1");
    assert.equal(rec.type, "card");
    assert.equal(rec.id, "item-1:st-1");
    assert.equal(rec.note, "Kettle hums the citrate song");
    assert.equal(cardId(), "item-1:st-1");
  });

  test("note put rejects: 'Note not saved. Try again.' and the card stays", async () => {
    const kv = seeded();
    kv.holdPut = async () => {
      throw new Error("quota");
    };
    const { status, cardId, cards, reveal, byAction, noteBox, page } = await mount(kv);
    reveal();
    noteBox().value = "Kettle hums";
    page.fire(byAction("save-note"), "click");
    await until(() => status.textContent === MSG.noteFailed, "note failure status");
    assert.equal(cards().length, 1);
    assert.equal(cardId(), "item-1:st-1");
  });

  test("hostile station and keyword text renders as text (no HTML writes)", async () => {
    const evil = "<img src=x onerror=alert(1)>";
    const route = makeRoute({
      name: `Walk ${evil}`,
      stations: [{ id: "st-1", n: 1, name: `Door ${evil}`, status: "named" }],
    });
    const item = makeItem({ title: `Title ${evil}`, keywords: [{ label: `Kettle ${evil}`, source_quote: `quote ${evil}` }] });
    const { page, cardId, reveal } = await mount(seeded({ item, route }));
    assert.equal(cardId(), "item-1:st-1");
    reveal();
    assert.deepEqual(page.htmlWrites, []);
  });
});
