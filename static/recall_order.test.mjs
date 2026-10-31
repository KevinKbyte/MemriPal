// Covers: MEM-051
// Requirement: route practice scores stations in ROUTE order (plan D9): the matcher keeps each hit's
// window start (transcript token index), and a pure post-pass walks stations in route order counting
// station k only when its start comes after the last counted station's start. Saying the 6 names in
// reverse counts 1; "1 3 2 4 5 6" counts 5. Live lighting (#recall-live board) sets .lit only on counted
// hits, within the same relay tick that matched them.
// Contract (RED; GREEN implements static/recall_match.js, static/recall_live.js):
//   createMatcher(points).starts() -> (number | null)[] per point: token index where the matched window
//     starts; null when not matched by speech. results() keeps its five keys unchanged.
//   countInOrder(starts) -> boolean[] (exported from recall_match.js).
//   renderLiveBoard(points, doc, { label, inOrder: matcher }): light(indices) then leaves "lit" exactly on
//     the rows countInOrder(matcher.starts()) marks counted. Without inOrder the board is unchanged.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { fakePage, findAll, settle } from "./fake_dom_test.mjs";
import * as rm from "./recall_match.js";
import { createLiveRelay, renderLiveBoard } from "./recall_live.js";

function api(name) {
  assert.ok(typeof rm[name] === "function", `static/recall_match.js must export ${name}`);
  return rm[name];
}

const NAMES = ["red bench", "old oak", "stone arch", "blue gate", "brick wall", "corner shop"];
const POINTS = NAMES.map((n) => ({ label: n, source_quote: n }));
const say = (order) => order.map((k) => NAMES[k - 1]).join(" then ");

function counted(text) {
  const m = rm.createMatcher(POINTS);
  m.append(text);
  assert.equal(typeof m.starts, "function", "createMatcher must expose starts()");
  return api("countInOrder")(m.starts());
}

describe("matcher keeps each hit's window start (D9)", () => {
  test("starts() gives the token index of each matched window, null for unmatched", () => {
    const m = rm.createMatcher(POINTS);
    m.append("red bench then stone arch");
    assert.equal(typeof m.starts, "function", "createMatcher must expose starts()");
    assert.deepEqual(m.starts(), [0, null, 3, null, null, null]);
  });

  test("starts survive chunked appends (global token index)", () => {
    const m = rm.createMatcher(POINTS);
    m.append("red bench");
    m.append("old oak");
    assert.deepEqual(m.starts().slice(0, 2), [0, 2]);
  });

  test("results() keeps exactly its five keys", () => {
    const m = rm.createMatcher(POINTS);
    m.append("red bench");
    assert.deepEqual(Object.keys(m.results()[0]).sort(), ["got", "label", "override", "source_quote", "span"]);
  });
});

describe("countInOrder post-pass (criterion 4)", () => {
  test("all 6 in order -> 6 counted", () => {
    assert.deepEqual(counted(say([1, 2, 3, 4, 5, 6])), [true, true, true, true, true, true]);
  });

  test("the 6 names in reverse -> 1 counted hit", () => {
    assert.equal(counted(say([6, 5, 4, 3, 2, 1])).filter(Boolean).length, 1);
  });

  test('shuffled "1 3 2 4 5 6" -> 5 counted, station 3 not', () => {
    assert.deepEqual(counted(say([1, 3, 2, 4, 5, 6])), [true, true, false, true, true, true]);
  });

  test("5/6 said in order (station 4 skipped) -> 5 counted", () => {
    assert.deepEqual(counted(say([1, 2, 3, 5, 6])), [true, true, true, false, true, true]);
  });

  test("pure: null starts never count; empty input -> empty", () => {
    assert.deepEqual(api("countInOrder")([null, 2, null, 1]), [false, true, false, false]);
    assert.deepEqual(api("countInOrder")([]), []);
  });
});

describe("live board lights only counted hits (criteria 2, 5)", () => {
  const rowsOf = (el) => findAll(el, (n) => n.tagName === "LI");
  const lit = (el) => rowsOf(el).map((r) => r.classList.contains("lit"));

  test("lit rows always equal the post-pass: a later hit for station 2 counts it and drops station 3", () => {
    const { doc } = fakePage([]);
    const m = rm.createMatcher(POINTS);
    const board = renderLiveBoard(POINTS, doc, { label: "LIVE", inOrder: m });
    board.light(m.append(say([1, 3])));
    assert.deepEqual(lit(board.el), [true, false, true, false, false, false]);
    board.light(m.append(NAMES[1]));
    assert.deepEqual(lit(board.el), [true, true, false, false, false, false]);
  });

  test("without inOrder the board lights every matched index (MEM-037 unchanged)", () => {
    const { doc } = fakePage([]);
    const m = rm.createMatcher(POINTS);
    const board = renderLiveBoard(POINTS, doc, { label: "LIVE" });
    board.light(m.append(say([3, 1])));
    assert.deepEqual(lit(board.el), [true, false, true, false, false, false]);
  });

  test('"red bench" / "red door", "red bench left" -> exactly 1 row lit', () => {
    const { doc } = fakePage([]);
    const pts = [{ label: "red bench", source_quote: "red bench" }, { label: "red door", source_quote: "red door" }];
    const m = rm.createMatcher(pts);
    const board = renderLiveBoard(pts, doc, { label: "LIVE", inOrder: m });
    board.light(m.append("red bench left"));
    assert.deepEqual(lit(board.el), [true, false]);
  });

  test("relay tick naming station 3 after stations 1-2 lights row 3 in that same tick", async () => {
    const { doc } = fakePage([]);
    const m = rm.createMatcher(POINTS);
    const board = renderLiveBoard(POINTS, doc, { label: "LIVE", inOrder: m });
    const texts = [say([1, 2]), NAMES[2]];
    let fire = null;
    const relay = createLiveRelay({
      clip: { take: async () => new Uint8Array([1]) },
      post: async () => ({ text: texts.shift() ?? "" }),
      matcher: m,
      onMatch: board.light,
      onFail: (err) => assert.fail(String(err)),
      setInterval: (fn) => ((fire = fn), 1),
      clearInterval: () => {},
    });
    fire();
    await settle();
    assert.deepEqual(lit(board.el), [true, true, false, false, false, false]);
    fire();
    await settle();
    assert.deepEqual(lit(board.el), [true, true, true, false, false, false]);
    await relay.stop();
  });
});
