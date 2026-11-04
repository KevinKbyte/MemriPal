// Covers: MEM-124
// Requirement: "Your routes" scales to many routes: a typeahead query filters items by name, case- and
// diacritic-insensitive, every whitespace token must match (AND); an optional multi-group OR filter (Landmarks
// gallery, item 73) keeps items in any selected group; routes list recent-first with a stable sort; a debounce
// helper throttles typeahead input.
import { describe, test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";

import { normalize, queryTokens, filterItems, sortRecentFirst, debounce } from "./list_filter.js";

const names = (items) => items.map((item) => item.name);

describe("normalize", () => {
  test("null and undefined become the empty string", () => {
    assert.equal(normalize(null), "");
    assert.equal(normalize(undefined), "");
  });

  test("lowercases, strips diacritics, collapses and trims whitespace", () => {
    assert.equal(normalize("  Caf\u00e9   RUE "), "cafe rue");
  });

  test("strips combining marks from decomposed input", () => {
    assert.equal(normalize("Cafe\u0301"), "cafe");
  });

  test("tabs and newlines collapse to one space", () => {
    assert.equal(normalize("Main\t\n  St"), "main st");
  });

  test("non-string input is stringified", () => {
    assert.equal(normalize(42), "42");
  });
});

describe("queryTokens", () => {
  test("splits a normalized query into tokens", () => {
    assert.deepEqual(queryTokens("  Park   MAIN "), ["park", "main"]);
  });

  test("empty or whitespace-only query yields no tokens", () => {
    assert.deepEqual(queryTokens(""), []);
    assert.deepEqual(queryTokens("   \t "), []);
    assert.deepEqual(queryTokens(null), []);
  });

  test("tokens are diacritic-free", () => {
    assert.deepEqual(queryTokens("Caf\u00e9 Cre\u0300me"), ["cafe", "creme"]);
  });
});

describe("filterItems: text query", () => {
  const routes = [
    { name: "Main St to Park" },
    { name: "Main St" },
    { name: "CAF\u00c9 Loop" },
    { name: "Harbor Walk" },
  ];

  test("empty query returns every item in input order, as a new array", () => {
    const out = filterItems(routes, "");
    assert.deepEqual(out, routes);
    assert.notEqual(out, routes);
  });

  test("whitespace-only query returns every item", () => {
    assert.deepEqual(names(filterItems(routes, "   ")), names(routes));
  });

  test("every token must match (AND), in any order", () => {
    assert.deepEqual(names(filterItems(routes, "park main")), ["Main St to Park"]);
  });

  test("a single token matches as a substring", () => {
    assert.deepEqual(names(filterItems(routes, "main")), ["Main St to Park", "Main St"]);
    assert.deepEqual(names(filterItems(routes, "arb")), ["Harbor Walk"]);
  });

  test("diacritic- and case-insensitive both ways", () => {
    assert.deepEqual(names(filterItems(routes, "cafe")), ["CAF\u00c9 Loop"]);
    assert.deepEqual(names(filterItems([{ name: "caf\u00e9" }], "CAFE")), ["caf\u00e9"]);
    assert.deepEqual(names(filterItems([{ name: "Cafe\u0301 Row" }], "caf\u00e9")), ["Cafe\u0301 Row"]);
  });

  test("no match returns an empty array", () => {
    assert.deepEqual(filterItems(routes, "zzz"), []);
  });

  test("empty input list returns an empty array", () => {
    assert.deepEqual(filterItems([], "main"), []);
  });

  test("custom key accessor", () => {
    const items = [
      { title: "Riverside", name: "ignored" },
      { title: "Uptown", name: "Riverside" },
    ];
    const out = filterItems(items, "river", { key: (item) => item.title });
    assert.deepEqual(out, [items[0]]);
  });

  test("key returning an array lets tokens hit different fields", () => {
    const items = [
      { name: "Museum Mile", tags: ["art", "history"] },
      { name: "Art Walk", tags: ["outdoor"] },
      { name: "Museum Mile North", tags: ["outdoor"] },
    ];
    const key = (item) => [item.name, ...item.tags];
    assert.deepEqual(names(filterItems(items, "museum history", { key })), ["Museum Mile"]);
    assert.deepEqual(names(filterItems(items, "art", { key })), ["Museum Mile", "Art Walk"]);
  });

  test("null or undefined key value matches only an empty query", () => {
    const items = [{ name: null }, { name: undefined }, {}, { name: "Park" }];
    assert.deepEqual(filterItems(items, ""), items);
    assert.deepEqual(names(filterItems(items, "park")), ["Park"]);
    assert.deepEqual(filterItems(items, "null"), []);
    assert.deepEqual(filterItems(items, "undefined"), []);
  });

  test("input array and items are not mutated", () => {
    const items = [{ name: "B Route" }, { name: "A Route" }];
    const snapshot = structuredClone(items);
    const ref = items.slice();
    filterItems(items, "route");
    filterItems(items, "a");
    assert.deepEqual(items, snapshot);
    assert.equal(items.length, 2);
    assert.equal(items[0], ref[0]);
    assert.equal(items[1], ref[1]);
  });

  test("scale: 1000 generated items, a token returns exactly the expected matches", () => {
    const items = Array.from({ length: 1000 }, (_, i) => ({
      id: i,
      name: i % 7 === 0 ? `Route ${i} Caf\u00e9 Stop` : `Route ${i} Plain`,
    }));
    const expected = items.filter((item) => item.id % 7 === 0).map((item) => item.id);
    const out = filterItems(items, "CAFE");
    assert.deepEqual(
      out.map((item) => item.id),
      expected,
    );
    assert.equal(out.length, 143);
    assert.deepEqual(
      filterItems(items, "route 999").map((item) => item.id),
      [999],
    );
  });
});

describe("filterItems: group OR filter", () => {
  const landmarks = [
    { name: "Old Church", group: "historic", groups: ["historic", "religious"] },
    { name: "City Park", group: "nature", groups: ["nature"] },
    { name: "Art Museum", group: "culture", groups: ["culture", "historic"] },
    { name: "Food Hall", group: "food", groups: ["food"] },
    { name: "Unsorted", group: null, groups: null },
  ];
  const groupKey = (item) => item.group;
  const groupsKey = (item) => item.groups;

  test("string groupKey: keeps items in any selected group", () => {
    const out = filterItems(landmarks, "", { anyOf: ["nature", "food"], groupKey });
    assert.deepEqual(names(out), ["City Park", "Food Hall"]);
  });

  test("array groupKey: keeps items sharing at least one selected group", () => {
    const out = filterItems(landmarks, "", { anyOf: ["historic"], groupKey: groupsKey });
    assert.deepEqual(names(out), ["Old Church", "Art Museum"]);
    const out2 = filterItems(landmarks, "", { anyOf: ["religious", "nature"], groupKey: groupsKey });
    assert.deepEqual(names(out2), ["Old Church", "City Park"]);
  });

  test("anyOf accepts a Set", () => {
    const out = filterItems(landmarks, "", { anyOf: new Set(["culture"]), groupKey });
    assert.deepEqual(names(out), ["Art Museum"]);
  });

  test("null group never matches a non-empty anyOf", () => {
    const out = filterItems(landmarks, "", { anyOf: ["historic", "nature", "culture", "food"], groupKey });
    assert.deepEqual(names(out), ["Old Church", "City Park", "Art Museum", "Food Hall"]);
  });

  test("empty array or empty Set anyOf applies no group filter", () => {
    assert.deepEqual(filterItems(landmarks, "", { anyOf: [], groupKey }), landmarks);
    assert.deepEqual(filterItems(landmarks, "", { anyOf: new Set(), groupKey }), landmarks);
    assert.deepEqual(filterItems(landmarks, "", { anyOf: undefined, groupKey }), landmarks);
  });

  test("empty anyOf without a groupKey does not throw", () => {
    assert.deepEqual(filterItems(landmarks, "", { anyOf: [] }), landmarks);
  });

  test("group filter and text query combine with AND", () => {
    const out = filterItems(landmarks, "museum", { anyOf: ["historic"], groupKey: groupsKey });
    assert.deepEqual(names(out), ["Art Museum"]);
    const none = filterItems(landmarks, "park", { anyOf: ["historic"], groupKey: groupsKey });
    assert.deepEqual(none, []);
  });

  test("non-empty anyOf without a groupKey function throws TypeError", () => {
    assert.throws(() => filterItems(landmarks, "", { anyOf: ["historic"] }), TypeError);
    assert.throws(() => filterItems(landmarks, "", { anyOf: ["historic"], groupKey: "group" }), TypeError);
  });

  test("group filtering does not mutate the input", () => {
    const snapshot = structuredClone(landmarks);
    filterItems(landmarks, "", { anyOf: new Set(["food"]), groupKey });
    assert.deepEqual(landmarks, snapshot);
  });
});

describe("sortRecentFirst", () => {
  test("ISO strings sort newest first", () => {
    const items = [
      { name: "a", created_at: "2026-01-01T00:00:00Z" },
      { name: "b", created_at: "2026-03-01T00:00:00Z" },
      { name: "c", created_at: "2026-02-01T00:00:00Z" },
    ];
    assert.deepEqual(names(sortRecentFirst(items)), ["b", "c", "a"]);
  });

  test("ties keep input order (stable)", () => {
    const t = "2026-05-05T05:05:05Z";
    const items = [
      { name: "first", created_at: t },
      { name: "newer", created_at: "2026-06-01T00:00:00Z" },
      { name: "second", created_at: t },
      { name: "third", created_at: t },
    ];
    assert.deepEqual(names(sortRecentFirst(items)), ["newer", "first", "second", "third"]);
  });

  test("missing or invalid times go last, in input order", () => {
    const items = [
      { name: "nullT", created_at: null },
      { name: "old", created_at: "2025-01-01T00:00:00Z" },
      { name: "garbage", created_at: "not a date" },
      { name: "missing" },
      { name: "new", created_at: "2026-01-01T00:00:00Z" },
      { name: "badDate", created_at: new Date("nope") },
    ];
    assert.deepEqual(names(sortRecentFirst(items)), ["new", "old", "nullT", "garbage", "missing", "badDate"]);
  });

  test("numbers (epoch ms) and Dates are accepted and mixed with ISO strings", () => {
    const items = [
      { name: "num", created_at: Date.parse("2026-02-01T00:00:00Z") },
      { name: "date", created_at: new Date("2026-04-01T00:00:00Z") },
      { name: "iso", created_at: "2026-03-01T00:00:00Z" },
      { name: "zero", created_at: 0 },
    ];
    assert.deepEqual(names(sortRecentFirst(items)), ["date", "iso", "num", "zero"]);
  });

  test("custom time accessor", () => {
    const items = [
      { name: "a", meta: { savedAt: 100 } },
      { name: "b", meta: { savedAt: 300 } },
      { name: "c", meta: { savedAt: 200 } },
    ];
    const out = sortRecentFirst(items, { time: (item) => item.meta.savedAt });
    assert.deepEqual(names(out), ["b", "c", "a"]);
  });

  test("returns a new array and does not mutate the input", () => {
    const items = [
      { name: "a", created_at: "2026-01-01T00:00:00Z" },
      { name: "b", created_at: "2026-02-01T00:00:00Z" },
    ];
    const snapshot = structuredClone(items);
    const out = sortRecentFirst(items);
    assert.notEqual(out, items);
    assert.deepEqual(items, snapshot);
    assert.deepEqual(names(out), ["b", "a"]);
  });

  test("empty input returns an empty array", () => {
    assert.deepEqual(sortRecentFirst([]), []);
  });
});

describe("debounce", () => {
  afterEach(() => {
    mock.timers.reset();
  });

  test("fires once with the last call's args after ms, not before", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const calls = [];
    const debounced = debounce((...args) => calls.push(args), 200);
    debounced("a");
    debounced("b", 2);
    mock.timers.tick(199);
    assert.deepEqual(calls, []);
    mock.timers.tick(1);
    assert.deepEqual(calls, [["b", 2]]);
    mock.timers.tick(1000);
    assert.deepEqual(calls, [["b", 2]]);
  });

  test("each call restarts the timer", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const calls = [];
    const debounced = debounce((q) => calls.push(q), 100);
    debounced("p");
    mock.timers.tick(80);
    debounced("pa");
    mock.timers.tick(80);
    debounced("par");
    mock.timers.tick(99);
    assert.deepEqual(calls, []);
    mock.timers.tick(1);
    assert.deepEqual(calls, ["par"]);
  });

  test("a call after the timer fired schedules a fresh call", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const calls = [];
    const debounced = debounce((q) => calls.push(q), 50);
    debounced("one");
    mock.timers.tick(50);
    debounced("two");
    mock.timers.tick(50);
    assert.deepEqual(calls, ["one", "two"]);
  });

  test("cancel drops a pending call", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const calls = [];
    const debounced = debounce((q) => calls.push(q), 100);
    debounced("x");
    mock.timers.tick(50);
    debounced.cancel();
    mock.timers.tick(1000);
    assert.deepEqual(calls, []);
  });

  test("cancel with nothing pending is harmless", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const calls = [];
    const debounced = debounce((q) => calls.push(q), 10);
    assert.doesNotThrow(() => debounced.cancel());
    debounced("y");
    mock.timers.tick(10);
    assert.deepEqual(calls, ["y"]);
  });

  test("ms of 0 fires on the next timer tick", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const calls = [];
    const debounced = debounce((q) => calls.push(q), 0);
    debounced("z");
    mock.timers.tick(0);
    assert.deepEqual(calls, ["z"]);
  });

  test("non-function fn throws TypeError", () => {
    assert.throws(() => debounce(null, 100), TypeError);
    assert.throws(() => debounce("fn", 100), TypeError);
    assert.throws(() => debounce(undefined, 100), TypeError);
  });

  test("ms that is not a finite number >= 0 throws RangeError", () => {
    const fn = () => {};
    assert.throws(() => debounce(fn, -1), RangeError);
    assert.throws(() => debounce(fn, Number.NaN), RangeError);
    assert.throws(() => debounce(fn, Number.POSITIVE_INFINITY), RangeError);
    assert.throws(() => debounce(fn, "100"), RangeError);
    assert.throws(() => debounce(fn, undefined), RangeError);
  });
});
