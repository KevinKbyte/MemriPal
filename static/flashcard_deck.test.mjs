// Covers: MEM-125
// Requirement: the Recall tab reviews Anki-style flashcards that are auto-generated from the material the user
// attached to a memory-palace route's loci. Each keyword i of a memorized item becomes one card on the i-th named
// station of its route (front = the locus, back = the material), tagged with the route it belongs to, with an id
// that stays the same when the cards are re-derived. The user can attach a note to any card; the note persists
// (trimmed, at most NOTE_MAX characters) and survives re-derivation. Grading a card follows ADR 0049's fixed
// MEM-090 schedule ("good" -> the next schedule entry after now, null once exhausted or past the deadline;
// "again" -> now + 1 day), and that schedule drives which cards are due and in what order.
// Contract (RED; GREEN implements static/flashcard_deck.js): deriveCards, mergeUserEdits, RATINGS, grade,
// dueOrder, NOTE_MAX, createFlashcardStore(adapter) with list / setNote / setReview over KV keys card:<id>.
// Timezone convention: instants are epoch ms built with Date.UTC; a day is a fixed 86_400_000 ms.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  deriveCards,
  mergeUserEdits,
  RATINGS,
  grade,
  dueOrder,
  NOTE_MAX,
  createFlashcardStore,
} from "./flashcard_deck.js";
import { memoryAdapter } from "./fake_dom_test.mjs";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// ADR 0049 simulated start S = 2026-11-03 18:00 and deadline T = 2026-11-21 00:00.
const S = Date.UTC(2026, 10, 3, 18, 0);
const T_ADR = Date.UTC(2026, 10, 21, 0, 0);
const T_ADR_ISO = "2026-11-21T00:00:00.000Z";
const iso = (ms) => (ms === null ? null : new Date(ms).toISOString());

function station(id, n, name, status = "named") {
  return { id, n, name, status };
}

function route(id, name, stations) {
  return { id, name, kind: "walk", status: "ready", created_at: "2026-11-01T00:00:00.000Z", stations, lists: [] };
}

function item(id, routeId, labels, extra = {}) {
  return {
    id,
    title: `Title ${id}`,
    text: `Text ${id}`,
    keywords: labels.map((label) => ({ label, source_quote: `quote of ${label}` })),
    route_id: routeId,
    placements: {},
    created_at: "2026-11-02T00:00:00.000Z",
    ...extra,
  };
}

/** A card as deriveCards would build it, plus optional note/review overrides. */
function card(overrides = {}) {
  return {
    id: "i1:s1",
    routeId: "r1",
    routeName: "Home walk",
    itemId: "i1",
    itemTitle: "Title i1",
    stationId: "s1",
    n: 1,
    front: "Front door",
    back: "apple",
    source: "quote of apple",
    deadline: null,
    ...overrides,
  };
}

describe("MEM-125 flashcard deck", () => {
  describe("deriveCards: cards are auto-generated from loci material", () => {
    const homeWalk = route("r1", "Home walk", [
      station("s1", 1, "Front door"),
      station("s2", 2, "Hallway"),
      station("s3", 3, "Kitchen"),
    ]);

    test("keyword i pairs with the i-th named station and carries the route tag fields", () => {
      const cards = deriveCards([homeWalk], [item("i1", "r1", ["apple", "bread"])]);
      assert.equal(cards.length, 2);
      assert.deepEqual(cards[0], card());
      assert.deepEqual(
        cards[1],
        card({ id: "i1:s2", stationId: "s2", n: 2, front: "Hallway", back: "bread", source: "quote of bread" }),
      );
    });

    test("stations that are not named are skipped when pairing keywords", () => {
      const mixed = route("r1", "Home walk", [
        station("s1", 1, "Front door"),
        station("s2", 2, "", "pending"),
        station("s3", 3, "Kitchen"),
        station("s4", 4, "", "error"),
        station("s5", 5, "Garden"),
      ]);
      const cards = deriveCards([mixed], [item("i1", "r1", ["apple", "bread", "cheese"])]);
      assert.deepEqual(
        cards.map((c) => [c.id, c.n, c.front, c.back]),
        [
          ["i1:s1", 1, "Front door", "apple"],
          ["i1:s3", 3, "Kitchen", "bread"],
          ["i1:s5", 5, "Garden", "cheese"],
        ],
      );
    });

    test("keywords beyond the named stations make no card", () => {
      const cards = deriveCards([homeWalk], [item("i1", "r1", ["a", "b", "c", "d", "e"])]);
      assert.deepEqual(cards.map((c) => c.back), ["a", "b", "c"]);
    });

    test("an item whose route is absent makes no cards; other items still do, in items order", () => {
      const park = route("r2", "Park loop", [station("p1", 1, "Gate"), station("p2", 2, "Pond")]);
      const cards = deriveCards(
        [homeWalk, park],
        [item("i2", "r2", ["x"]), item("gone", "r-missing", ["y"]), item("i1", "r1", ["z"])],
      );
      assert.deepEqual(
        cards.map((c) => [c.id, c.routeId, c.routeName]),
        [
          ["i2:p1", "r2", "Park loop"],
          ["i1:s1", "r1", "Home walk"],
        ],
      );
    });

    test("null / undefined routes or items yield []", () => {
      const items = [item("i1", "r1", ["apple"])];
      assert.deepEqual(deriveCards(null, items), []);
      assert.deepEqual(deriveCards(undefined, items), []);
      assert.deepEqual(deriveCards([homeWalk], null), []);
      assert.deepEqual(deriveCards([homeWalk], undefined), []);
      assert.deepEqual(deriveCards(null, null), []);
      assert.deepEqual(deriveCards([], []), []);
    });

    test("deadline is Date.parse(remember_by), or null when absent or unparseable", () => {
      const [withDeadline] = deriveCards([homeWalk], [item("i1", "r1", ["a"], { remember_by: T_ADR_ISO })]);
      assert.equal(withDeadline.deadline, T_ADR);
      const [noDeadline] = deriveCards([homeWalk], [item("i1", "r1", ["a"])]);
      assert.equal(noDeadline.deadline, null);
      const [garbage] = deriveCards([homeWalk], [item("i1", "r1", ["a"], { remember_by: "not a date" })]);
      assert.equal(garbage.deadline, null);
    });

    test("card ids are stable across re-derivation after the route and item are regenerated", () => {
      const before = deriveCards([homeWalk], [item("i1", "r1", ["apple", "bread"])]);
      const regenerated = route("r1", "Home walk (renamed)", [
        station("s1", 1, "Front porch"),
        station("s2", 2, "Long hallway"),
        station("s3", 3, "Kitchen"),
      ]);
      const after = deriveCards([regenerated], [item("i1", "r1", ["apple v2", "bread v2"])]);
      assert.deepEqual(after.map((c) => c.id), before.map((c) => c.id));
      assert.deepEqual(after.map((c) => c.id), ["i1:s1", "i1:s2"]);
    });

    test("does not mutate its inputs", () => {
      const routes = [homeWalk];
      const items = [item("i1", "r1", ["apple", "bread"], { remember_by: T_ADR_ISO })];
      const routesCopy = structuredClone(routes);
      const itemsCopy = structuredClone(items);
      deriveCards(routes, items);
      assert.deepEqual(routes, routesCopy);
      assert.deepEqual(items, itemsCopy);
    });
  });

  describe("mergeUserEdits: notes and review state attach by card id", () => {
    test("matching records supply note and review; unmatched cards get note '' and review null", () => {
      const cards = [card({ id: "a" }), card({ id: "b" }), card({ id: "c" })];
      const records = [
        { id: "c", note: "third", review: { start: S, due: S + DAY } },
        { id: "a", note: "first", review: null },
      ];
      const merged = mergeUserEdits(cards, records);
      assert.deepEqual(
        merged.map((c) => [c.id, c.note, c.review]),
        [
          ["a", "first", null],
          ["b", "", null],
          ["c", "third", { start: S, due: S + DAY }],
        ],
      );
      assert.equal(merged[0].back, "apple");
    });

    test("records whose id matches no card are ignored", () => {
      const merged = mergeUserEdits([card({ id: "a" })], [{ id: "orphan", note: "x", review: null }]);
      assert.equal(merged.length, 1);
      assert.equal(merged[0].id, "a");
      assert.equal(merged[0].note, "");
      assert.equal(merged[0].review, null);
    });

    test("a note survives re-derivation because the card id is stable", () => {
      const r = route("r1", "Home walk", [station("s1", 1, "Front door")]);
      const records = [{ id: "i1:s1", note: "my hint", review: null }];
      const first = mergeUserEdits(deriveCards([r], [item("i1", "r1", ["apple"])]), records);
      const second = mergeUserEdits(deriveCards([r], [item("i1", "r1", ["apple again"])]), records);
      assert.equal(first[0].note, "my hint");
      assert.equal(second[0].note, "my hint");
    });

    test("returns new cards and does not mutate its inputs", () => {
      const cards = [card({ id: "a" })];
      const records = [{ id: "a", note: "n", review: { start: S, due: null } }];
      const cardsCopy = structuredClone(cards);
      const recordsCopy = structuredClone(records);
      const merged = mergeUserEdits(cards, records);
      assert.notEqual(merged[0], cards[0]);
      assert.deepEqual(cards, cardsCopy);
      assert.deepEqual(records, recordsCopy);
    });
  });

  describe("RATINGS and NOTE_MAX", () => {
    test("RATINGS is the frozen pair again / good; NOTE_MAX is 1000", () => {
      assert.deepEqual([...RATINGS], ["again", "good"]);
      assert.ok(Object.isFrozen(RATINGS));
      assert.equal(NOTE_MAX, 1000);
    });
  });

  describe("grade follows ADR 0049's MEM-090 schedule", () => {
    test("no deadline, first good at S: due S+1d, start S", () => {
      assert.deepEqual(grade(card({ review: null }), "good", S), { start: S, due: S + DAY });
    });

    test("a card with no review property starts at now", () => {
      const c = card();
      delete c.review;
      assert.deepEqual(grade(c, "good", S), { start: S, due: S + DAY });
    });

    test("deadline S+18d, first good at S: due S+10min", () => {
      const out = grade(card({ deadline: S + 18 * DAY, review: null }), "good", S);
      assert.deepEqual(out, { start: S, due: S + 10 * MIN });
    });

    test("ADR deadline 11-21, first good at S: due 11-03 18:10", () => {
      const out = grade(card({ deadline: T_ADR, review: null }), "good", S);
      assert.equal(iso(out.due), "2026-11-03T18:10:00.000Z");
      assert.equal(out.start, S);
    });

    test("a later good past several entries: due is the first entry strictly after now; start kept", () => {
      const c = card({ deadline: T_ADR, review: { start: S, due: S + 10 * MIN } });
      const at1110 = grade(c, "good", Date.UTC(2026, 10, 10, 9, 30));
      assert.deepEqual({ start: at1110.start, due: iso(at1110.due) }, { start: S, due: "2026-11-13T00:00:00.000Z" });
      const exactlyOn1113 = grade(c, "good", Date.UTC(2026, 10, 13, 0, 0));
      assert.equal(iso(exactlyOn1113.due), "2026-11-17T00:00:00.000Z");
      assert.equal(exactlyOn1113.start, S);
    });

    test("no deadline, later good: next entry of S + 1,3,7,14,30,60,120 d after now", () => {
      const c = card({ review: { start: S, due: S + DAY } });
      assert.deepEqual(grade(c, "good", S + 5 * DAY), { start: S, due: S + 7 * DAY });
    });

    test("schedule exhausted: due null (card finished)", () => {
      const noDeadline = card({ review: { start: S, due: S + 120 * DAY } });
      assert.deepEqual(grade(noDeadline, "good", S + 120 * DAY), { start: S, due: null });
      const withDeadline = card({ deadline: T_ADR, review: { start: S, due: Date.UTC(2026, 10, 20, 0, 0) } });
      assert.equal(grade(withDeadline, "good", Date.UTC(2026, 10, 20, 12, 0)).due, null);
    });

    test("deadline passed: due null", () => {
      const reviewed = card({ deadline: T_ADR, review: { start: S, due: S + 10 * MIN } });
      assert.equal(grade(reviewed, "good", T_ADR + DAY).due, null);
      const fresh = card({ deadline: S - DAY, review: null });
      assert.deepEqual(grade(fresh, "good", S), { start: S, due: null });
    });

    test("again: due now + 1d, start kept from the existing review", () => {
      const now = Date.UTC(2026, 10, 10, 9, 30);
      const c = card({ deadline: T_ADR, review: { start: S, due: S + 10 * MIN } });
      assert.deepEqual(grade(c, "again", now), { start: S, due: now + DAY });
    });

    test("again on a new card: start = now, due now + 1d", () => {
      assert.deepEqual(grade(card({ review: null }), "again", S), { start: S, due: S + DAY });
    });

    test("an unknown rating throws TypeError", () => {
      for (const bad of ["easy", "hard", "GOOD", "", undefined, null, 1]) {
        assert.throws(() => grade(card({ review: null }), bad, S), TypeError, `rating ${String(bad)}`);
      }
    });

    test("does not mutate the card", () => {
      const c = card({ deadline: T_ADR, review: { start: S, due: S + 10 * MIN } });
      const copy = structuredClone(c);
      grade(c, "good", Date.UTC(2026, 10, 10, 0, 0));
      grade(c, "again", Date.UTC(2026, 10, 10, 0, 0));
      assert.deepEqual(c, copy);
    });
  });

  describe("dueOrder: the schedule drives which cards are due and in what order", () => {
    const now = Date.UTC(2026, 10, 10, 12, 0);

    test("includes new and due cards; excludes finished and future cards", () => {
      const cards = [
        card({ id: "new", review: null }),
        card({ id: "due-now", review: { start: S, due: now } }),
        card({ id: "overdue", review: { start: S, due: now - HOUR } }),
        card({ id: "finished", review: { start: S, due: null } }),
        card({ id: "future", review: { start: S, due: now + 1 } }),
      ];
      assert.deepEqual(dueOrder(cards, now).map((c) => c.id), ["overdue", "due-now", "new"]);
    });

    test("sorted by effective due ascending (new = now), so overdue reviews come before new cards", () => {
      const cards = [
        card({ id: "new", review: null }),
        card({ id: "two-days-late", review: { start: S, due: now - 2 * DAY } }),
        card({ id: "one-hour-late", review: { start: S, due: now - HOUR } }),
      ];
      assert.deepEqual(dueOrder(cards, now).map((c) => c.id), ["two-days-late", "one-hour-late", "new"]);
    });

    test("ties break by routeName, then n, then id", () => {
      const cards = [
        card({ id: "z", routeName: "Park loop", n: 1, review: null }),
        card({ id: "b", routeName: "Home walk", n: 2, review: null }),
        card({ id: "c", routeName: "Home walk", n: 1, review: null }),
        card({ id: "a", routeName: "Home walk", n: 1, review: null }),
        card({ id: "d", routeName: "Home walk", n: 1, review: { start: S, due: now } }),
      ];
      assert.deepEqual(dueOrder(cards, now).map((c) => c.id), ["a", "c", "d", "b", "z"]);
    });

    test("empty input yields []; input array is not mutated", () => {
      assert.deepEqual(dueOrder([], now), []);
      const cards = [card({ id: "b", review: null }), card({ id: "a", review: { start: S, due: now - DAY } })];
      const copy = structuredClone(cards);
      dueOrder(cards, now);
      assert.deepEqual(cards, copy);
    });

    test("a card graded good drops out until its due time arrives", () => {
      const graded = card({ id: "g", review: grade(card({ review: null }), "good", S) });
      assert.deepEqual(dueOrder([graded], S + DAY - 1), []);
      assert.deepEqual(dueOrder([graded], S + DAY).map((c) => c.id), ["g"]);
    });
  });

  describe("createFlashcardStore: user notes and review state persist in the route KV", () => {
    test("setNote persists: a fresh store on the same adapter lists it", async () => {
      const adapter = memoryAdapter();
      const saved = await createFlashcardStore(adapter).setNote("i1:s1", "red apple on the door");
      assert.deepEqual(saved, { id: "i1:s1", note: "red apple on the door", review: null });
      const listed = await createFlashcardStore(adapter).list();
      assert.deepEqual(listed, [{ id: "i1:s1", note: "red apple on the door", review: null }]);
    });

    test("stores under key card:<id> with value { type: 'card', id, note, review }", async () => {
      const adapter = memoryAdapter();
      await createFlashcardStore(adapter).setNote("i1:s1", "hint");
      assert.deepEqual(adapter.map.get("card:i1:s1"), { type: "card", id: "i1:s1", note: "hint", review: null });
    });

    test("a persisted note flows through mergeUserEdits onto the re-derived card", async () => {
      const adapter = memoryAdapter();
      await createFlashcardStore(adapter).setNote("i1:s1", "my hint");
      const r = route("r1", "Home walk", [station("s1", 1, "Front door")]);
      const cards = deriveCards([r], [item("i1", "r1", ["apple"])]);
      const merged = mergeUserEdits(cards, await createFlashcardStore(adapter).list());
      assert.equal(merged[0].note, "my hint");
    });

    test("setNote stores the note trimmed", async () => {
      const store = createFlashcardStore(memoryAdapter());
      const saved = await store.setNote("a", "   padded note \n\t");
      assert.equal(saved.note, "padded note");
      assert.deepEqual(await store.list(), [{ id: "a", note: "padded note", review: null }]);
    });

    test("a note of exactly NOTE_MAX characters after trim is accepted", async () => {
      const store = createFlashcardStore(memoryAdapter());
      const full = "x".repeat(NOTE_MAX);
      assert.equal((await store.setNote("a", `  ${full}  `)).note, full);
    });

    test("a note longer than NOTE_MAX rejects TypeError and writes nothing", async () => {
      const adapter = memoryAdapter();
      const store = createFlashcardStore(adapter);
      await assert.rejects(store.setNote("a", "x".repeat(NOTE_MAX + 1)), TypeError);
      assert.deepEqual(adapter.puts, []);
      assert.deepEqual(await store.list(), []);
    });

    test("a non-string note rejects TypeError and writes nothing", async () => {
      const adapter = memoryAdapter();
      const store = createFlashcardStore(adapter);
      for (const bad of [null, undefined, 42, { text: "x" }]) {
        await assert.rejects(store.setNote("a", bad), TypeError, `note ${String(bad)}`);
      }
      assert.deepEqual(adapter.puts, []);
    });

    test("a rejected setNote leaves the previously stored note intact", async () => {
      const store = createFlashcardStore(memoryAdapter());
      await store.setNote("a", "keep me");
      await assert.rejects(store.setNote("a", "y".repeat(NOTE_MAX + 1)), TypeError);
      assert.deepEqual(await store.list(), [{ id: "a", note: "keep me", review: null }]);
    });

    test("setReview persists and keeps the stored note; setNote keeps the stored review", async () => {
      const store = createFlashcardStore(memoryAdapter());
      await store.setNote("a", "hint");
      const r1 = await store.setReview("a", { start: S, due: S + DAY });
      assert.deepEqual(r1, { id: "a", note: "hint", review: { start: S, due: S + DAY } });
      const r2 = await store.setNote("a", "better hint");
      assert.deepEqual(r2, { id: "a", note: "better hint", review: { start: S, due: S + DAY } });
    });

    test("setReview on a card with no stored note keeps note ''; due null is valid", async () => {
      const store = createFlashcardStore(memoryAdapter());
      const saved = await store.setReview("a", { start: S, due: null });
      assert.deepEqual(saved, { id: "a", note: "", review: { start: S, due: null } });
    });

    test("an invalid review rejects TypeError and writes nothing", async () => {
      const adapter = memoryAdapter();
      const store = createFlashcardStore(adapter);
      const inf = Number.POSITIVE_INFINITY;
      const bad = [null, undefined, "soon", {}, { start: S }, { due: S }, { start: "1", due: S }];
      bad.push({ start: Number.NaN, due: S }, { start: inf, due: S }, { start: S, due: undefined });
      bad.push({ start: S, due: Number.NaN }, { start: S, due: inf }, { start: S, due: "tomorrow" });
      for (const review of bad) {
        await assert.rejects(store.setReview("a", review), TypeError, `review ${JSON.stringify(review)}`);
      }
      assert.deepEqual(adapter.puts, []);
    });

    test("list ignores KV values that are not cards; empty adapter lists []", async () => {
      assert.deepEqual(await createFlashcardStore(memoryAdapter()).list(), []);
      const adapter = memoryAdapter();
      adapter.map.set("route:r1", { type: "route", id: "r1", name: "Home walk", stations: [] });
      adapter.map.set("list:i1", { type: "list", id: "i1", title: "x" });
      adapter.map.set("legacy", { id: "no-type" });
      adapter.map.set("nothing", null);
      const store = createFlashcardStore(adapter);
      await store.setNote("i1:s1", "hint");
      assert.deepEqual(await store.list(), [{ id: "i1:s1", note: "hint", review: null }]);
    });

    test("concurrent setNote and setReview on one id both survive", async () => {
      const adapter = memoryAdapter();
      const store = createFlashcardStore(adapter);
      await Promise.all([store.setNote("a", "hint"), store.setReview("a", { start: S, due: S + DAY })]);
      assert.deepEqual(await store.list(), [{ id: "a", note: "hint", review: { start: S, due: S + DAY } }]);
      await Promise.all([store.setReview("a", { start: S, due: null }), store.setNote("a", "second")]);
      assert.deepEqual(await createFlashcardStore(adapter).list(), [
        { id: "a", note: "second", review: { start: S, due: null } },
      ]);
    });

    test("a rejected call does not block later serialized calls", async () => {
      const store = createFlashcardStore(memoryAdapter());
      const results = await Promise.allSettled([
        store.setNote("a", "z".repeat(NOTE_MAX + 1)),
        store.setNote("a", "after failure"),
      ]);
      assert.equal(results[0].status, "rejected");
      assert.equal(results[1].status, "fulfilled");
      assert.deepEqual(await store.list(), [{ id: "a", note: "after failure", review: null }]);
    });
  });
});
