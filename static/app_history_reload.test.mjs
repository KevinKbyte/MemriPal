// Covers: MEM-033
// Requirement: stored rehearsals are visible as soon as the page opens: with one or more saved runs
// of the demo palace, the rehearsal history (and its hit rates) shows on load without running "Load
// demo" again, also right after a recall replay and a reload. Every history row has a "View" control
// that opens that run's "what you said vs what is in the palace" from the stored record alone (said
// text for a hit, "not said" for a miss, plus the palace's source quote), set via textContent only.
// Removing a run via that history still needs a confirm and offers Undo. With no saved runs the page
// behaves as before (the recall panel stays hidden until Load demo).
// Contract (RED; GREEN implements in static/flow.js, and static/index.html if the history moves):
//   wireApp renders the demo palace's history on start (no click needed). The #rehearsals list (or
//     whichever index.html element holds it) and every index.html ancestor of it are not hidden once
//     >= 1 run is stored; with 0 runs #recall keeps its initial hidden state.
//   Each #rehearsals row (<li>, direct child) keeps <button data-action="delete-rehearsal"> and gains a
//     <button> whose text starts "View"; its click renders renderSaidVsPalace(record) of THAT row's
//     stored record into a shown page element. No network request, no palace points needed.
//   #rehearsal-undo is visible to the user after an accepted removal on a history loaded at start.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { fakePage, findAll, jsonResponse, memoryAdapter, record, settle, until, visibleText } from "./fake_dom_test.mjs";
import { createPalaceStore } from "./palace_store.js";
import { createRehearsalStore } from "./rehearsals.js";

const flow = await import("./flow.js").catch((err) => ({ __missing: String(err) }));

function wireApp() {
  assert.ok("wireApp" in flow, `static/flow.js must export wireApp (${flow.__missing ?? "not exported"})`);
  return flow.wireApp;
}

const HTML = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const TIMELINE = JSON.parse(readFileSync(new URL("../fixtures/demo/recall_timeline.json", import.meta.url), "utf8"));
const TURNS = 5000;

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

// Two stored runs of the demo palace with different outcomes per point, so each View is distinguishable.
const RUN_A = [
  { label: "Lamp point", source_quote: "Quote one from the notes", got: true, override: false, span: "said alpha one" },
  { label: "Door point", source_quote: "Quote two from the notes", got: false, override: false, span: null },
  { label: "Clock point", source_quote: "Quote three from the notes", got: true, override: true, span: null },
];
const RUN_B = [
  { label: "Lamp point", source_quote: "Quote one from the notes", got: false, override: false, span: null },
  { label: "Door point", source_quote: "Quote two from the notes", got: true, override: false, span: "said beta two" },
  { label: "Clock point", source_quote: "Quote three from the notes", got: false, override: false, span: null },
];
const OTHER_PALACE = [{ label: "Elsewhere", source_quote: "Not this palace", got: true, override: false, span: "other" }];

const VOID = new Set(["meta", "link", "input", "br", "img", "hr", "source", "area", "base", "col", "embed", "wbr"]);

/** Ids of the index.html elements that enclose `id` (outermost first); null if absent. */
function htmlAncestors(id) {
  const stack = [];
  for (const m of HTML.matchAll(/<(\/?)([a-z][a-z0-9]*)\b([^>]*)>/gi)) {
    const [, close, tag, attrs] = m;
    const name = tag.toLowerCase();
    if (close) {
      const at = stack.map((s) => s.tag).lastIndexOf(name);
      if (at >= 0) stack.length = at;
      continue;
    }
    const own = /\bid="([^"]+)"/.exec(attrs);
    if (own && own[1] === id) return stack.map((s) => s.id).filter(Boolean);
    if (!VOID.has(name)) stack.push({ tag: name, id: own ? own[1] : null });
  }
  return null;
}

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

function demoServer() {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method ?? "GET").toUpperCase();
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ u, method });
    if (u === "/demo/photo.jpg") return new Response(PHOTO, { headers: { "content-type": "image/jpeg" } });
    if (u === "/demo/notes.txt") return new Response(NOTES, { headers: { "content-type": "text/plain" } });
    if (u === "/demo/recall.json") return jsonResponse(TIMELINE);
    if (u === "/loci") return jsonResponse({ image: IMAGE, width: 800, height: 600, loci: LOCI });
    if (u === "/split") return jsonResponse({ points: POINTS });
    if (u === "/associate") return jsonResponse({ record: record(body.item, body.locus), status: "valid" });
    if (u === "/scenes") return jsonResponse({ tier: 1, image: IMAGE, width: 800, height: 600 });
    return jsonResponse({ error: "not_found" }, 404);
  };
  return { fn, calls };
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

/** A rehearsal adapter already holding RUN_A then RUN_B of the demo palace and one other palace's run. */
async function seeded() {
  const rehAdapter = kvAdapter();
  const store = createRehearsalStore(rehAdapter, clock());
  const a = await store.save("demo", { transcript: "alpha", results: RUN_A });
  const b = await store.save("demo", { transcript: "beta", results: RUN_B });
  await store.save("other", { transcript: "other", results: OTHER_PALACE });
  return { rehAdapter, a, b };
}

/** A freshly opened page (a reload) over the given stores; never clicks Load demo. */
function boot(opts = {}) {
  const p = pageFromHtml();
  const server = opts.server ?? demoServer();
  const rehAdapter = opts.rehAdapter ?? kvAdapter();
  const palaceAdapter = opts.palaceAdapter ?? memoryAdapter();
  const confirms = [];
  wireApp()({
    doc: p.doc,
    fetch: server.fn,
    store: createPalaceStore(palaceAdapter),
    rehearsals: createRehearsalStore(rehAdapter, clock()),
    getUserMedia: undefined,
    location: { hostname: "localhost" },
    loadImage: async (src) => ({ src }),
    confirm: () => {
      confirms.push(true);
      return opts.confirm ? opts.confirm() : true;
    },
    wait: async () => {},
  });
  return { p, server, rehAdapter, palaceAdapter, confirms };
}

const el = (b, id) => {
  const e = b.p.els[id];
  assert.ok(e, `index.html must contain #${id}`);
  return e;
};

/** The user can see page element `id`: neither it nor any index.html element around it is hidden. */
function shown(b, id) {
  const chain = htmlAncestors(id);
  assert.ok(chain, `index.html must contain #${id}`);
  return [...chain, id].every((a) => !b.p.els[a]?.hidden);
}

const runRows = (b) => el(b, "rehearsals").children.filter((c) => typeof c === "object" && c.tagName === "LI" && !c.hidden);
const visibleRows = (b) => (shown(b, "rehearsals") ? runRows(b) : []);
const button = (row, pred) => findAll(row, (n) => n.tagName === "BUTTON" && pred(n), { visibleOnly: true })[0] ?? null;
const viewButton = (row) => button(row, (n) => /^\s*View\b/.test(n.textContent));
const removeButton = (row) => button(row, (n) => n.dataset.action === "delete-rehearsal");
// A row names its run by timestamp, shown locale-formatted (UX F14) or as the stored ISO string.
const showsStamp = (row, iso) => [iso, new Date(iso).toLocaleString()].some((s) => visibleText(row).includes(s));
const stampOf = (row, stamps) => stamps.find((s) => showsStamp(row, s)) ?? null;

/** Every <ol class="said-vs-palace"> the user can currently see, anywhere on the page. */
function shownSaidLists(b) {
  return Object.keys(b.p.els)
    .filter((id) => shown(b, id))
    .flatMap((id) =>
      findAll(b.p.els[id], (n) => n.tagName === "OL" && String(n.className).split(/\s+/).includes("said-vs-palace"), {
        visibleOnly: true,
      }),
    );
}

/** A said-vs-palace list showing exactly `points` in palace order (MEM-033 renderSaidVsPalace). */
function showsRun(list, points) {
  const rows = list.children.filter((c) => typeof c === "object" && c.tagName === "LI");
  if (rows.length !== points.length) return false;
  return points.every((p, i) => {
    const text = visibleText(rows[i]);
    const said = p.got ? (p.span ?? "marked got it") : "not said";
    return text.includes(p.label) && text.includes(said) && text.includes(p.source_quote);
  });
}

const viewing = (b, points) => shownSaidLists(b).some((list) => showsRun(list, points));

function watchRejections(t) {
  const seen = [];
  const onRejection = (reason) => seen.push(reason);
  process.on("unhandledRejection", onRejection);
  t.after(() => process.off("unhandledRejection", onRejection));
  return seen;
}

// Covers: MEM-033
// Requirement: saved rehearsals of the demo palace are listed (with per-point hit rates) as soon as
// the page opens, in the same order "Load demo" shows them; with none saved the page is unchanged.
describe("rehearsal history on page load", () => {
  test("stored runs are listed on load without Load demo: one row per demo-palace run, plus hit rates", async (t) => {
    const rejections = watchRejections(t);
    const { rehAdapter, a, b: runB } = await seeded();
    const b = boot({ rehAdapter });
    await until(() => visibleRows(b).length >= 2, "stored runs listed and visible on load", TURNS);
    await settle(30);
    assert.equal(visibleRows(b).length, 2, "one row per stored run of the demo palace only");
    const stamps = [a.timestamp, runB.timestamp];
    assert.deepEqual(visibleRows(b).map((r) => stampOf(r, stamps)).sort(), [...stamps].sort(), "each run's timestamp shown");
    assert.ok(!visibleRows(b).some((r) => visibleText(r).includes("Elsewhere")), "another palace's run is not listed");
    assert.ok(shown(b, "hit-rates"), "hit rates visible on load");
    const lamp = findAll(el(b, "hit-rates"), (n) => n.tagName === "LI" && visibleText(n).includes("Lamp point"))[0];
    assert.ok(lamp, "a hit-rate row for a stored point");
    assert.match(visibleText(lamp), /\b1\/2\b/);
    assert.equal(b.server.calls.filter((c) => c.method === "POST").length, 0, "listing history sends nothing");
    assert.deepEqual(rejections, []);
  });

  test("row order on load matches the order the history shows after Load demo", async () => {
    const { rehAdapter, a, b: runB } = await seeded();
    const stamps = [a.timestamp, runB.timestamp];
    const opened = boot({ rehAdapter });
    await until(() => visibleRows(opened).length === 2, "history listed on load", TURNS);
    const onLoad = visibleRows(opened).map((r) => stampOf(r, stamps));

    const demo = boot({ rehAdapter });
    el(demo, "auto").checked = true;
    demo.p.fire(el(demo, "load-demo"), "click");
    await until(() => !el(demo, "walk").hidden && runRows(demo).length === 2, "history after Load demo", TURNS);
    assert.deepEqual(onLoad, runRows(demo).map((r) => stampOf(r, stamps)));
  });

  test("no stored runs: nothing breaks, the recall panel stays hidden until Load demo", async (t) => {
    const rejections = watchRejections(t);
    const b = boot();
    await settle(50);
    assert.equal(el(b, "recall").hidden, true, "no recall panel before a palace exists");
    assert.equal(runRows(b).length, 0);
    assert.equal(b.p.htmlWrites.length, 0);
    el(b, "auto").checked = true;
    b.p.fire(el(b, "load-demo"), "click");
    await until(() => !el(b, "recall").hidden, "recall panel shown after Load demo", TURNS);
    assert.equal(runRows(b).length, 0);
    assert.deepEqual(rejections, []);
  });

  test("regression: after a replay and a reload the run is listed and viewable without Load demo", async () => {
    const first = boot();
    el(first, "auto").checked = true;
    first.p.fire(el(first, "load-demo"), "click");
    await until(() => !el(first, "recall").hidden, "recall panel shown", TURNS);
    first.p.fire(el(first, "recall-replay"), "click");
    await until(() => first.rehAdapter.map.size === 1 && runRows(first).length === 1, "replay saved", TURNS);
    const [saved] = [...first.rehAdapter.map.values()].map((v) => JSON.parse(v));
    assert.ok(saved.points.some((p) => p.got) && saved.points.some((p) => !p.got), "replay has hits and misses");

    const reloaded = boot({ rehAdapter: first.rehAdapter, palaceAdapter: first.palaceAdapter });
    await until(() => visibleRows(reloaded).length === 1, "the earlier run is listed after a reload, no Load demo", TURNS);
    const view = viewButton(visibleRows(reloaded)[0]);
    assert.ok(view, "the history row has a View control");
    reloaded.p.fire(view, "click");
    await until(() => viewing(reloaded, saved.points), "the replayed run's said vs palace shown", TURNS);
    assert.equal(reloaded.server.calls.filter((c) => c.method === "POST").length, 0, "no model call after the reload");
  });
});

// Covers: MEM-033
// Requirement: every history row opens that run's "what you said vs what is in the palace" (said text
// for a hit, "not said" for a miss, with the palace's source quote), from the stored record alone;
// stored text is shown as text, never as markup.
describe("per-run said-vs-palace view", () => {
  test("each row's View renders that run's said vs palace from the stored record alone", async (t) => {
    const rejections = watchRejections(t);
    const { rehAdapter, a, b: runB } = await seeded();
    const b = boot({ rehAdapter });
    await until(() => visibleRows(b).length === 2, "history listed on load", TURNS);
    const rowFor = (stamp) => visibleRows(b).find((r) => showsStamp(r, stamp));
    for (const row of visibleRows(b)) assert.ok(viewButton(row), "every row has a View control");
    assert.ok(!viewing(b, RUN_A) && !viewing(b, RUN_B), "no run opened before a View click");
    const callsBefore = b.server.calls.length;

    b.p.fire(viewButton(rowFor(a.timestamp)), "click");
    await until(() => viewing(b, RUN_A), "run A said vs palace shown", TURNS);
    const list = shownSaidLists(b).find((l) => showsRun(l, RUN_A));
    const rows = list.children.filter((c) => typeof c === "object" && c.tagName === "LI");
    assert.ok(visibleText(rows[0]).includes("said alpha one"), "a hit shows the matched span");
    assert.ok(visibleText(rows[1]).includes("not said"), "a miss shows not said");
    assert.ok(visibleText(rows[1]).includes("Quote two from the notes"), "a miss still shows the source quote");
    assert.ok(visibleText(rows[2]).includes("marked got it"), "an override without a span");

    b.p.fire(viewButton(rowFor(runB.timestamp)), "click");
    await until(() => viewing(b, RUN_B), "run B said vs palace shown", TURNS);
    assert.equal(b.server.calls.length, callsBefore, "View makes no request");
    assert.deepEqual(rejections, []);
  });

  test("a run finished in this session gets a View control too", async () => {
    const b = boot();
    el(b, "auto").checked = true;
    b.p.fire(el(b, "load-demo"), "click");
    await until(() => !el(b, "recall").hidden, "recall panel shown", TURNS);
    b.p.fire(el(b, "recall-replay"), "click");
    await until(() => b.rehAdapter.map.size === 1 && visibleRows(b).length === 1, "replay saved and listed", TURNS);
    const [saved] = [...b.rehAdapter.map.values()].map((v) => JSON.parse(v));
    el(b, "recall-results").replaceChildren();
    const view = viewButton(visibleRows(b)[0]);
    assert.ok(view, "the history row has a View control");
    b.p.fire(view, "click");
    await until(() => viewing(b, saved.points), "the run's said vs palace shown again", TURNS);
  });

  test("stored markup is shown as text: textContent only", async () => {
    const rehAdapter = kvAdapter();
    const evil = [{ label: "<img src=x onerror=alert(1)>", source_quote: "<b>quote</b>", got: true, override: false, span: "<script>x</script>" }];
    await createRehearsalStore(rehAdapter, clock()).save("demo", { transcript: "t", results: evil });
    const b = boot({ rehAdapter });
    await until(() => visibleRows(b).length === 1, "history listed on load", TURNS);
    b.p.fire(viewButton(visibleRows(b)[0]), "click");
    await until(() => viewing(b, evil), "the stored text shown literally", TURNS);
    assert.deepEqual(b.p.htmlWrites, [], "no innerHTML / insertAdjacentHTML");
    assert.equal(b.p.madeByCode().filter((n) => n.tagName === "IMG" || n.tagName === "SCRIPT").length, 0);
  });
});

// Covers: MEM-033
// Requirement: removing a run via the history shown on load still asks to confirm first and offers
// a visible Undo that puts the identical record back.
describe("removing a run via the history shown on load", () => {
  test("declined confirm keeps the run; accepted removes it with a visible Undo that restores it", async () => {
    const { rehAdapter, a } = await seeded();
    let answer = false;
    const b = boot({ rehAdapter, confirm: () => answer });
    await until(() => visibleRows(b).length === 2, "history listed on load", TURNS);
    const before = [...rehAdapter.map.entries()];
    const rowA = () => visibleRows(b).find((r) => showsStamp(r, a.timestamp));

    b.p.fire(removeButton(rowA()), "click");
    await until(() => b.confirms.length === 1, "confirm asked", TURNS);
    await settle(50);
    assert.equal(rehAdapter.map.has(a.id), true, "declined confirm keeps the record");
    assert.equal(el(b, "rehearsal-undo").hidden, true, "no Undo without a removal");

    answer = true;
    b.p.fire(removeButton(rowA()), "click");
    await until(() => !rehAdapter.map.has(a.id) && !el(b, "rehearsal-undo").hidden, "removed, Undo offered", TURNS);
    assert.equal(b.confirms.length, 2, "each click asks first");
    assert.ok(shown(b, "rehearsal-undo"), "the Undo control is visible to the user");
    await until(() => visibleRows(b).length === 1, "run gone from history", TURNS);

    b.p.fire(el(b, "rehearsal-undo"), "click");
    await until(() => rehAdapter.map.has(a.id) && visibleRows(b).length === 2, "run restored and listed", TURNS);
    assert.deepEqual([...rehAdapter.map.entries()].sort(), [...before].sort(), "Undo restores the identical record");
    assert.equal(el(b, "rehearsal-undo").hidden, true);
  });
});
