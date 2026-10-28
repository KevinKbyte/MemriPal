// Covers: MEM-033
// Requirement: the recall end screen (#recall-results, what you said vs what is in the palace) lets
// the user overrule the matcher: every missed point has a "Mark got it" button (points already got
// have none); clicking it turns that point into a hit on screen, updates the got/missed tallies and
// the rehearsal history, and rewrites the saved rehearsal so the point is stored as got with
// override true; no other point changes. Model and transcript text stays plain text (no HTML).
// Contract (RED; GREEN implements in static/flow.js, possibly static/rehearsals.js):
//   Each <li> of the said-vs-palace <ol> in #recall-results whose className is "said-missed" holds
//     exactly one <button data-action="mark-got"> whose text includes "Mark got it" (case-insensitive);
//     a "said-got" row holds none.
//   Click -> that point becomes got: its row (re-rendered or updated) has className "said-got", text
//     "marked got it", and no mark-got button; the other rows keep their class and text, the other
//     missed rows keep their button. #rehearsals row shows "<got>/<n> recalled" with the new got
//     count; #hit-rates shows "<label>: 1/1" for the overridden point.
//   Store: the same record (same id, timestamp, transcript; still one record) now has that point
//     {got: true, override: true, span: null}; every other point is unchanged. Survives a reload.
//   No innerHTML/outerHTML/insertAdjacentHTML anywhere in the flow.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { fakePage, find, findAll, jsonResponse, memoryAdapter, record, until, visibleText } from "./fake_dom_test.mjs";
import { createPalaceStore } from "./palace_store.js";
import { replayRecording } from "./recall.js";
import { createMatcher } from "./recall_match.js";
import { createRehearsalStore } from "./rehearsals.js";

const flow = await import("./flow.js").catch((err) => ({ __missing: String(err) }));

function wireApp() {
  assert.ok("wireApp" in flow, `static/flow.js must export wireApp (${flow.__missing ?? "not exported"})`);
  return flow.wireApp;
}

const HTML = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const TIMELINE = JSON.parse(readFileSync(new URL("../fixtures/demo/recall_timeline.json", import.meta.url), "utf8"));

// Recorded demo split reply (MEM-023), as in app_flow.test.mjs.
const POINTS = [
  ["The method is over two thousand years old", "The method of loci is more than two thousand years"],
  ["Place each item at a familiar spot", "place each thing you want to remember at a familiar spot"],
  ["Spatial memory is strong", "Spatial memory is strong because finding food and shelter once"],
  ["Vivid images stick better than plain facts", "Vivid images stick better than plain facts."],
  ["Engage every sense", "Imagine how the scene sounds, smells, tastes and feels"],
  ["Walking the route keeps the order", "Walking the route in the same direction every time"],
  ["Start small with ten or twelve spots", "Ten or twelve spots in one room are enough"],
  ["Review after a day, then after a week", "Walk the palace again after a day, then after a week"],
  ["Memory champions memorize decks of cards", "Memory champions use this exact technique"],
  ["Students can use it for exams", "Students can use it for exams"],
  ["Speakers can drop their slides", "speakers can use it to drop their slides"],
  ["Try it on your next shopping list", "try it on your next shopping list"],
].map(([label, source_quote]) => ({ label, source_quote }));
const PLACES = ["lamp", "door", "clock", "shelf", "window", "rug", "chair", "desk", "plant", "mirror", "sofa", "vase"];
const LOCI = PLACES.map((label, i) => ({ n: i + 1, label, box: { x1: 10 + i * 60, y1: 10, x2: 60 + i * 60, y2: 200 } }));
const IMAGE = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==";
const PHOTO = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const NOTES = "The method of loci is more than two thousand years old.";
const TYPED = "students can use it for exams and try it on your next shopping list";
const TURNS = 5000;

function pageFromHtml() {
  const ids = [];
  const hidden = [];
  for (const m of HTML.matchAll(/<[a-z][a-z0-9]*\b[^>]*>/gi)) {
    const id = /\bid="([^"]+)"/.exec(m[0]);
    if (!id) continue;
    ids.push(id[1]);
    if (/\shidden(?=[\s>=/])/.test(m[0])) hidden.push(id[1]);
  }
  return fakePage(ids, { hidden });
}

function demoServer(points) {
  return async (url, init = {}) => {
    const u = String(url);
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    if (u === "/demo/photo.jpg") return new Response(PHOTO, { headers: { "content-type": "image/jpeg" } });
    if (u === "/demo/notes.txt") return new Response(NOTES, { headers: { "content-type": "text/plain" } });
    if (u === "/demo/recall.json") return jsonResponse(TIMELINE);
    if (u === "/loci") return jsonResponse({ image: IMAGE, width: 800, height: 600, loci: LOCI });
    if (u === "/split") return jsonResponse({ points });
    if (u === "/associate") return jsonResponse({ record: record(body.item, body.locus), status: "valid" });
    if (u === "/scenes") return jsonResponse({ tier: 1, image: IMAGE, width: 800, height: 600 });
    return jsonResponse({ error: "not_found" }, 404);
  };
}

function kvAdapter() {
  const map = new Map();
  return {
    map,
    get: async (k) => map.get(k),
    put: async (k, v) => void map.set(k, v),
    delete: async (k) => void map.delete(k),
    list: async () => [...map.values()],
  };
}

function clock() {
  let t = Date.UTC(2026, 9, 31, 9, 0, 0);
  let n = 0;
  return { now: () => (t += 60_000), newId: () => `reh-${++n}` };
}

function boot(opts = {}) {
  const p = pageFromHtml();
  const rehAdapter = opts.rehAdapter ?? kvAdapter();
  const palaceAdapter = opts.palaceAdapter ?? memoryAdapter();
  wireApp()({
    doc: p.doc,
    fetch: demoServer(opts.points ?? POINTS),
    store: createPalaceStore(palaceAdapter),
    rehearsals: createRehearsalStore(rehAdapter, clock()),
    getUserMedia: undefined,
    location: { hostname: "localhost" },
    loadImage: async (src) => ({ src }),
    confirm: () => true,
    wait: async () => {},
  });
  return { p, rehAdapter, palaceAdapter };
}

const el = (b, id) => {
  const e = b.p.els[id];
  assert.ok(e, `index.html must contain #${id}`);
  return e;
};
const saidRows = (b) => {
  const list = find(el(b, "recall-results"), (n) => n.tagName === "OL" && n.className === "said-vs-palace");
  return list ? list.children.filter((c) => typeof c === "object" && c.tagName === "LI") : [];
};
const markButtons = (row) => findAll(row, (n) => n.tagName === "BUTTON" && n.dataset.action === "mark-got", { visibleOnly: true });
const runRows = (b) => findAll(el(b, "rehearsals"), (n) => n.tagName === "LI", { visibleOnly: true });
const rateRow = (b, label) =>
  find(el(b, "hit-rates"), (n) => n.tagName === "LI" && visibleText(n).includes(label), { visibleOnly: true });
const stored = (b) => [...b.rehAdapter.map.values()].map((v) => JSON.parse(v));
const rowState = (row) => ({ cls: row.className, text: visibleText(row) });

async function expectedReplay(points = POINTS) {
  return replayRecording(TIMELINE, createMatcher(points), { wait: async () => {} });
}

/** Load demo (auto), replay the recorded session, wait for the saved end screen. */
async function replayToEnd(b, points = POINTS) {
  el(b, "auto").checked = true;
  b.p.fire(el(b, "load-demo"), "click");
  await until(() => !el(b, "recall").hidden, "recall panel shown", TURNS);
  b.p.fire(el(b, "recall-replay"), "click");
  await until(() => stored(b).length === 1 && saidRows(b).length === points.length, "replay run saved and shown", TURNS);
  await until(() => runRows(b).length === 1, "history lists the run", TURNS);
}

/** Click the mark-got button of row i; resolves once that row reads as got. */
async function markGot(b, i) {
  const [button] = markButtons(saidRows(b)[i]);
  assert.ok(button, `row ${i} has a mark-got button`);
  b.p.fire(button, "click");
  await until(() => saidRows(b)[i]?.className === "said-got", `row ${i} turned got`, TURNS);
}

// Covers: MEM-033
// Requirement: on the end screen every missed point offers a "Mark got it" override; points the
// matcher already got do not.
describe("end screen: mark got it button on missed points", () => {
  test("each missed row has exactly one mark-got button; got rows have none", async () => {
    const b = boot();
    await replayToEnd(b);
    const want = await expectedReplay();
    assert.ok(want.some((r) => r.got) && want.some((r) => !r.got), "oracle has hits and misses");
    saidRows(b).forEach((row, i) => {
      const buttons = markButtons(row);
      if (want[i].got) {
        assert.equal(buttons.length, 0, `got row ${POINTS[i].label} has no override button`);
      } else {
        assert.equal(buttons.length, 1, `missed row ${POINTS[i].label} has one override button`);
        assert.match(visibleText(buttons[0]), /mark got it/i, "button reads Mark got it");
      }
    });
  });
});

// Covers: MEM-033
// Requirement: clicking "Mark got it" turns that point into a hit on screen, updates the got/missed
// tallies and history, rewrites the saved rehearsal with an override, and changes no other point.
describe("end screen override: screen, counts, store", () => {
  test("clicking mark got it turns the row got and updates got/missed counts and history", async () => {
    const b = boot();
    await replayToEnd(b);
    const want = await expectedReplay();
    const gotBefore = want.filter((r) => r.got).length;
    const missedBefore = POINTS.length - gotBefore;
    const target = want.findIndex((r) => !r.got);
    assert.match(visibleText(runRows(b)[0]), new RegExp(`\\b${gotBefore}/${POINTS.length} recalled`));
    assert.match(visibleText(rateRow(b, POINTS[target].label)), /\b0\/1\b/);

    await markGot(b, target);

    const rows = saidRows(b);
    assert.equal(rows.length, POINTS.length, "still one row per point");
    assert.ok(visibleText(rows[target]).includes("marked got it"), "the row says it was marked got");
    assert.equal(markButtons(rows[target]).length, 0, "no override button once got");
    assert.equal(rows.filter((r) => r.className === "said-got").length, gotBefore + 1, "got count +1");
    assert.equal(rows.filter((r) => r.className === "said-missed").length, missedBefore - 1, "missed count -1");
    await until(
      () => runRows(b).length === 1 && new RegExp(`\\b${gotBefore + 1}/${POINTS.length} recalled`).test(visibleText(runRows(b)[0])),
      "history row shows the new got count",
      TURNS,
    );
    await until(() => /\b1\/1\b/.test(visibleText(rateRow(b, POINTS[target].label) ?? "")), "hit rate counts the override", TURNS);
  });

  test("the saved rehearsal records the override on that point only, also after a reload", async () => {
    const b = boot();
    await replayToEnd(b);
    const want = await expectedReplay();
    const target = want.findIndex((r) => !r.got);
    const [before] = stored(b);

    await markGot(b, target);
    await until(() => stored(b)[0]?.points[target]?.override === true, "override saved", TURNS);

    const after = stored(b);
    assert.equal(after.length, 1, "the run is updated, not saved twice");
    const [rec] = after;
    assert.equal(rec.id, before.id);
    assert.equal(rec.timestamp, before.timestamp);
    assert.equal(rec.transcript, before.transcript);
    assert.deepEqual(rec.points[target], { ...before.points[target], got: true, override: true, span: null });
    rec.points.forEach((p, i) => {
      if (i !== target) assert.deepEqual(p, before.points[i], `point ${POINTS[i].label} unchanged`);
    });

    const again = boot({ rehAdapter: b.rehAdapter, palaceAdapter: b.palaceAdapter });
    el(again, "auto").checked = true;
    again.p.fire(el(again, "load-demo"), "click");
    await until(() => /\b1\/1\b/.test(visibleText(rateRow(again, POINTS[target].label) ?? "")), "override survives a reload", TURNS);
  });

  test("overriding one point leaves every other row as it was", async () => {
    const b = boot();
    await replayToEnd(b);
    const want = await expectedReplay();
    const missed = want.map((r, i) => (r.got ? -1 : i)).filter((i) => i >= 0);
    assert.ok(missed.length >= 2, "oracle has at least two misses");
    const [target, other] = missed;
    const before = saidRows(b).map(rowState);

    await markGot(b, target);

    const rows = saidRows(b);
    rows.forEach((row, i) => {
      if (i !== target) assert.deepEqual(rowState(row), before[i], `row ${POINTS[i].label} unchanged`);
    });
    assert.equal(markButtons(rows[other]).length, 1, "another missed row keeps its button");

    await markGot(b, other);
    await until(() => stored(b)[0]?.points[other]?.override === true, "second override saved", TURNS);
    const [rec] = stored(b);
    assert.equal(rec.points[target].override, true, "the first override is kept");
    assert.equal(rec.points.filter((p) => p.override).length, 2, "exactly the two clicked points are overrides");
  });

  test("a typed run (no mic) offers the same override", async () => {
    const b = boot();
    el(b, "auto").checked = true;
    b.p.fire(el(b, "load-demo"), "click");
    await until(() => !el(b, "recall").hidden, "recall panel shown", TURNS);
    b.p.fire(el(b, "recall-start"), "click");
    await until(() => !el(b, "recall-typed").hidden, "typed box shown", TURNS);
    el(b, "recall-typed").value = TYPED;
    b.p.fire(el(b, "recall-submit"), "click");
    await until(() => stored(b).length === 1 && saidRows(b).length === POINTS.length, "typed run saved and shown", TURNS);
    const m = createMatcher(POINTS);
    m.append(TYPED);
    const target = m.results().findIndex((r) => !r.got);
    assert.ok(target >= 0, "oracle has a miss");

    await markGot(b, target);
    await until(() => stored(b)[0]?.points[target]?.override === true, "override saved", TURNS);
    assert.equal(stored(b)[0].points[target].got, true);
  });
});

// Covers: MEM-033
// Requirement: model text on the end screen (labels, source quotes, spans) is shown as plain text,
// before and after an override; nothing is parsed as HTML.
describe("end screen override renders text only", () => {
  test("markup in a missed point's model text stays literal through an override", async () => {
    const EVIL = '<img src=x onerror="alert(1)"> spatial memory';
    const points = POINTS.map((p, i) => (i === 2 ? { ...p, source_quote: EVIL } : p));
    const b = boot({ points });
    await replayToEnd(b, points);
    const want = await expectedReplay(points);
    assert.equal(want[2].got, false, "the point carrying markup is missed by the replay");

    await markGot(b, 2);

    const results = el(b, "recall-results");
    assert.ok(visibleText(saidRows(b)[2]).includes(EVIL), "markup shown as literal text");
    assert.equal(findAll(results, (n) => n.tagName === "IMG").length, 0, "no element parsed out of model text");
    assert.deepEqual(b.p.htmlWrites, [], "no innerHTML/outerHTML/insertAdjacentHTML");
  });
});
