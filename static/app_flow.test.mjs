// Covers: MEM-029, MEM-030, MEM-032, MEM-033
// Requirement: the page runs the whole palace loop in the browser: "Load demo" builds the fixture
// palace (route review unless #auto is checked, then scenes and the walk view), then a recall panel
// takes typed answers when there is no microphone or replays the recorded demo session (labelled as a
// replay), shows what was said vs what is in the palace, saves the run as a rehearsal, and lists the
// rehearsal history with per-point hit rates; a rehearsal is deleted only after a confirm, with Undo.
// In live mode every model route carries the passcode typed into the page.
// Contract (RED; GREEN implements):
//   static/flow.js (new module) exports wireApp(deps); app.js imports it from "./flow.js", calls it
//   once on load, and no longer binds #load-demo itself (Load demo must not also run onLoadDemo).
//   deps = {doc, fetch, store, rehearsals, getUserMedia, location, loadImage, confirm, wait}:
//     store = createPalaceStore(adapter); rehearsals = createRehearsalStore(adapter, ...);
//     getUserMedia = bound navigator.mediaDevices.getUserMedia or undefined; location = {hostname};
//     confirm = () => boolean | Promise<boolean> (window.confirm in the browser);
//     wait = (ms) => Promise (replay pacing; the browser default may be a setTimeout sleep).
//   wireApp: showPublicBanner(doc, location.hostname). Click #load-demo -> runDemoPalace({auto:
//     #auto.checked}) with the /split points kept for recall. Once the walk view shows: #recall
//     unhidden and the palace's stored history rendered.
//   #recall-start click -> startRecall({points, getUserMedia, doc}); getUserMedia is never called
//     before it. Typed mode: #recall-submit click submits #recall-typed.value and ends the run.
//   #recall-replay (text includes REPLAY_LABEL) click -> GET /demo/recall.json -> replayRecording(
//     timeline, createMatcher(points), {wait: deps.wait}) -> ends the run. Never POST /recall/audio.
//   Ending a run: rehearsals.save(palaceId, {transcript, results}) (palaceId stable for the same
//     demo palace, also after a reload); #recall-results = renderSaidVsPalace(record, doc) (an
//     <ol class="said-vs-palace">), plus REPLAY_LABEL text only for a replay run.
//   History: #rehearsals = one <li> per run of this palace, each with a <button
//     data-action="delete-rehearsal">; #hit-rates = one <li> per hitRates() entry whose text holds
//     the label, "<hits>/<runs>", and "chronic" only when chronic. Delete -> deleteRehearsalWithUndo
//     with deps.confirm; accepted -> #rehearsal-undo unhidden, its click restores the run and hides it.
//   Passcode: a non-empty #passcode value adds header X-Memripal-Passcode to every request to
//     /loci, /split, /associate, /scenes, /recall/audio (other headers kept); never to /demo/*.
//   index.html gains #recall (hidden), #recall-start, #recall-typed (textarea/input, hidden),
//     #recall-submit, #recall-replay, #recall-results, #rehearsals, #hit-rates, #rehearsal-undo
//     (hidden), #passcode (input type="password").
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { fakePage, find, findAll, jsonResponse, memoryAdapter, record, settle, until, visibleText } from "./fake_dom_test.mjs";
import { createPalaceStore } from "./palace_store.js";
import { REPLAY_LABEL, replayRecording } from "./recall.js";
import { createMatcher } from "./recall_match.js";
import { createRehearsalStore } from "./rehearsals.js";

const flow = await import("./flow.js").catch((err) => ({ __missing: String(err) }));

function wireApp() {
  assert.ok("wireApp" in flow, `static/flow.js must export wireApp (${flow.__missing ?? "not exported"})`);
  return flow.wireApp;
}

const HTML = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const APP_JS = readFileSync(new URL("./app.js", import.meta.url), "utf8");
const TIMELINE = JSON.parse(readFileSync(new URL("../fixtures/demo/recall_timeline.json", import.meta.url), "utf8"));

// Recorded demo split reply (MEM-023), 12 points in speech order, as in recall.test.mjs.
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
const LABELS = POINTS.map((p) => p.label);
const PLACES = ["lamp", "door", "clock", "shelf", "window", "rug", "chair", "desk", "plant", "mirror", "sofa", "vase"];
const LOCI = PLACES.map((label, i) => ({ n: i + 1, label, box: { x1: 10 + i * 60, y1: 10, x2: 60 + i * 60, y2: 200 } }));
const IMAGE = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==";
const PHOTO = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const NOTES = "The method of loci is more than two thousand years old.";
const TYPED = "students can use it for exams and try it on your next shopping list";
const LIVE_ROUTES = ["/loci", "/split", "/associate", "/scenes", "/recall/audio"];
const TURNS = 5000;

/** Page roots exactly as index.html declares them (ids, and which start hidden). */
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

/** Fake server: demo fixtures, /loci, /split, /associate (signed, MEM-036), /scenes, /demo/recall.json. */
function demoServer() {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers ?? {});
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ u, method, headers, body });
    if (u === "/demo/photo.jpg") return new Response(PHOTO, { headers: { "content-type": "image/jpeg" } });
    if (u === "/demo/notes.txt") return new Response(NOTES, { headers: { "content-type": "text/plain" } });
    if (u === "/demo/recall.json") return jsonResponse(TIMELINE);
    if (u === "/loci") return jsonResponse({ image: IMAGE, width: 800, height: 600, loci: LOCI });
    if (u === "/split") return jsonResponse({ points: POINTS });
    if (u === "/associate") return jsonResponse({ record: record(body.item, body.locus), status: "valid", sig: `sig_${body.item}` });
    if (u === "/scenes") return jsonResponse({ tier: 1, image: IMAGE, width: 800, height: 600 });
    return jsonResponse({ error: "not_found" }, 404);
  };
  const count = (method, u) => calls.filter((c) => c.method === method && c.u === u).length;
  return { fn, calls, count };
}

/** Async key-value adapter with delete, the createRehearsalStore contract. */
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

/** A page with wireApp applied; adapters can be shared to model a reload. */
function boot(opts = {}) {
  const p = pageFromHtml();
  const server = opts.server ?? demoServer();
  const rehAdapter = opts.rehAdapter ?? kvAdapter();
  const palaceAdapter = opts.palaceAdapter ?? memoryAdapter();
  const confirms = [];
  const deps = {
    doc: p.doc,
    fetch: server.fn,
    store: createPalaceStore(palaceAdapter),
    rehearsals: createRehearsalStore(rehAdapter, opts.clock ?? clock()),
    getUserMedia: opts.getUserMedia,
    location: { hostname: opts.hostname ?? "localhost" },
    loadImage: async (src) => ({ src }),
    confirm: () => {
      confirms.push(true);
      return opts.confirm ? opts.confirm() : true;
    },
    wait: async () => {},
  };
  wireApp()(deps);
  return { p, server, rehAdapter, palaceAdapter, deps, confirms };
}

const el = (b, id) => {
  const e = b.p.els[id];
  assert.ok(e, `index.html must contain #${id}`);
  return e;
};

async function loadDemo(b, { auto = true } = {}) {
  el(b, "auto").checked = auto;
  b.p.fire(el(b, "load-demo"), "click");
  if (auto) await until(() => !el(b, "walk").hidden, "walk view shown", TURNS);
}

const saidRows = (b) => {
  const list = find(el(b, "recall-results"), (n) => n.tagName === "OL" && n.className === "said-vs-palace");
  return list ? list.children.filter((c) => typeof c === "object" && c.tagName === "LI") : [];
};
const runRows = (b) => findAll(el(b, "rehearsals"), (n) => n.tagName === "LI", { visibleOnly: true });
const deleteButtons = (b) =>
  findAll(el(b, "rehearsals"), (n) => n.tagName === "BUTTON" && n.dataset.action === "delete-rehearsal", { visibleOnly: true });
const rateRow = (b, label) =>
  find(el(b, "hit-rates"), (n) => n.tagName === "LI" && visibleText(n).includes(label), { visibleOnly: true });
const stored = (b) => [...b.rehAdapter.map.values()].map((v) => JSON.parse(v));

async function expectedReplay() {
  return replayRecording(TIMELINE, createMatcher(POINTS), { wait: async () => {} });
}
function expectedTyped() {
  const m = createMatcher(POINTS);
  m.append(TYPED);
  return m.results();
}

async function replayOnce(b, runs) {
  b.p.fire(el(b, "recall-replay"), "click");
  await until(() => stored(b).length === runs && saidRows(b).length === POINTS.length, `replay run ${runs} saved`, TURNS);
  await until(() => deleteButtons(b).length === runs, `history lists ${runs} runs`, TURNS);
}

// Covers: MEM-029, MEM-030, MEM-032, MEM-033
// Requirement: the page wiring has one home (flow.js) that app.js calls, and index.html carries
// every element the recall panel, rehearsal history and live passcode need.
describe("page flow seam", () => {
  test("flow.js exports wireApp", () => {
    assert.equal(typeof wireApp(), "function");
  });

  test("index.html has the recall panel, rehearsal history, undo and passcode elements", () => {
    for (const id of ["recall", "recall-start", "recall-typed", "recall-submit", "recall-replay", "recall-results", "rehearsals", "hit-rates", "rehearsal-undo", "passcode"]) {
      assert.match(HTML, new RegExp(`\\bid="${id}"`), `#${id}`);
    }
    const tag = (id) => (HTML.match(new RegExp(`<[a-z]+\\b[^>]*\\bid="${id}"[^>]*>`, "i")) ?? [""])[0];
    for (const id of ["recall", "recall-typed", "rehearsal-undo"]) assert.match(tag(id), /\shidden(?=[\s>=/])/, `#${id} starts hidden`);
    assert.match(tag("recall-typed"), /^<(textarea|input)\b/i, "#recall-typed is a text box");
    assert.match(tag("passcode"), /^<input\b/i);
    assert.match(tag("passcode"), /\btype="password"/);
  });

  test("the replay button names the replay as a recorded session", () => {
    const m = HTML.match(/<button\b[^>]*\bid="recall-replay"[^>]*>([^<]*)<\/button>/i);
    assert.ok(m, "#recall-replay is a <button> with plain-text content");
    assert.ok(m[1].includes(REPLAY_LABEL), `button text ${JSON.stringify(m[1])} includes ${JSON.stringify(REPLAY_LABEL)}`);
  });

  test("app.js hands the page to wireApp from flow.js and no longer wires Load demo itself", () => {
    assert.match(APP_JS, /import\s*\{[^}]*\bwireApp\b[^}]*\}\s*from\s*["']\.\/flow\.js["']/);
    assert.match(APP_JS, /\bwireApp\s*\(/);
    assert.doesNotMatch(APP_JS, /load-demo/, "Load demo is bound only by flow.js (runDemoPalace, not onLoadDemo)");
  });
});

// Covers: MEM-029, MEM-030
// Requirement: "Load demo" runs the fixture palace end to end: route review (unless #auto skips
// it, D19), scenes in #scenes, then the walk view with Previous / Next; the recall panel appears
// only once the palace has been walked to step 1.
describe("Load demo builds and walks the fixture palace", () => {
  test("auto off: review stops the flow until Generate, then scenes and the walk view", async () => {
    const b = boot();
    assert.equal(el(b, "recall").hidden, true, "no recall panel before a palace exists");
    await loadDemo(b, { auto: false });
    await until(() => !el(b, "route-review").hidden, "route review shown", TURNS);
    assert.equal(b.server.count("POST", "/split"), 1, "Load demo runs the demo palace (demo notes split)");
    assert.equal(b.server.count("POST", "/associate"), 0, "nothing generated before Generate");
    b.p.fire(el(b, "generate"), "click");
    await until(() => !el(b, "walk").hidden, "walk view shown", TURNS);
    assert.equal(b.server.count("POST", "/associate"), POINTS.length);
    assert.equal(b.server.count("POST", "/scenes"), POINTS.length);
    for (const c of b.server.calls.filter((c) => c.u === "/scenes")) {
      assert.equal(c.body.sig, `sig_${c.body.record.item}`, "each /scenes request carries its record's /associate sig");
    }
    assert.equal(findAll(el(b, "scenes"), (n) => n.tagName === "IMG").length, POINTS.length, "a scene per locus in #scenes");
    assert.match(visibleText(el(b, "walk-step")), /\b1 of 12\b/);
    assert.equal(el(b, "walk-prev").disabled, true);
    b.p.fire(el(b, "walk-next"), "click");
    assert.match(visibleText(el(b, "walk-step")), /\b2 of 12\b/);
    b.p.fire(el(b, "walk-prev"), "click");
    assert.match(visibleText(el(b, "walk-step")), /\b1 of 12\b/);
    await until(() => !el(b, "recall").hidden, "recall panel shown", TURNS);
  });

  test("auto on: zero review clicks, the walk view and recall panel still appear", async () => {
    const b = boot();
    await loadDemo(b, { auto: true });
    assert.equal(el(b, "route-review").hidden, true);
    assert.equal(b.server.count("POST", "/loci"), 1, "one upload per Load demo click");
    assert.equal(b.server.count("POST", "/associate"), POINTS.length);
    await until(() => !el(b, "recall").hidden, "recall panel shown", TURNS);
  });

  test("a public host shows the passcode banner; localhost does not", () => {
    assert.equal(el(boot({ hostname: "memripal-123.us-central1.run.app" }), "public-banner").hidden, false);
    assert.equal(el(boot({ hostname: "localhost" }), "public-banner").hidden, true);
  });
});

// Covers: MEM-032, MEM-033
// Requirement: without a microphone the recall panel falls back to a typed box judged by the same
// matcher; the offline demo replays the recorded session (labelled as a replay, never sent to the
// relay); each run ends on "what you said vs what is in the palace".
describe("recall panel", () => {
  test("mic denied: Start asks for the mic only on click, then typed answers are judged and shown", async () => {
    const asked = [];
    const b = boot({
      getUserMedia: async (c) => {
        asked.push(c);
        throw new DOMException("denied", "NotAllowedError");
      },
    });
    await loadDemo(b);
    await until(() => !el(b, "recall").hidden, "recall panel shown", TURNS);
    assert.equal(asked.length, 0, "no mic prompt before the user starts recall");
    b.p.fire(el(b, "recall-start"), "click");
    await until(() => !el(b, "recall-typed").hidden, "typed box shown", TURNS);
    assert.equal(asked.length, 1);
    el(b, "recall-typed").value = TYPED;
    b.p.fire(el(b, "recall-submit"), "click");
    await until(() => saidRows(b).length === POINTS.length, "said-vs-palace rendered", TURNS);
    const want = expectedTyped();
    assert.ok(want.some((r) => r.got) && want.some((r) => !r.got), "oracle has hits and misses");
    saidRows(b).forEach((row, i) => {
      assert.ok(visibleText(row).includes(LABELS[i]), `row ${i} label`);
      assert.equal(row.className, want[i].got ? "said-got" : "said-missed", LABELS[i]);
    });
    assert.ok(!visibleText(el(b, "recall-results")).includes(REPLAY_LABEL), "a typed run is not labelled a replay");
    assert.equal(b.server.count("POST", "/recall/audio"), 0);
  });

  test("replay: the recorded demo timeline from /demo/recall.json, labelled as a replay", async () => {
    const b = boot();
    await loadDemo(b);
    await until(() => !el(b, "recall").hidden, "recall panel shown", TURNS);
    await replayOnce(b, 1);
    assert.equal(b.server.count("GET", "/demo/recall.json"), 1);
    assert.equal(b.server.count("POST", "/recall/audio"), 0, "a replay never reaches the speech relay");
    const want = await expectedReplay();
    assert.ok(want.some((r) => r.got) && want.some((r) => !r.got), "demo replay gets >= 1 and misses >= 1");
    saidRows(b).forEach((row, i) => assert.equal(row.className, want[i].got ? "said-got" : "said-missed", LABELS[i]));
    assert.ok(visibleText(el(b, "recall-results")).includes(REPLAY_LABEL), "replay results are labelled on screen");
  });
});

// Covers: MEM-033
// Requirement: every finished recall run is saved as a human-readable rehearsal of that palace and
// the history shows each run plus per-point hit rates (chronic misses flagged), surviving a reload;
// a rehearsal is deleted only after a confirm, and Undo puts it back.
describe("rehearsal history", () => {
  test("a finished run is saved as JSON and listed with per-point hit rates", async () => {
    const b = boot();
    await loadDemo(b);
    await until(() => !el(b, "recall").hidden, "recall panel shown", TURNS);
    await replayOnce(b, 1);
    const want = await expectedReplay();
    const [rec] = stored(b);
    assert.deepEqual(rec.points.map((p) => p.label), LABELS);
    assert.deepEqual(rec.points.map((p) => p.got), want.map((r) => r.got));
    assert.ok(rec.transcript.includes("shopping list"), "transcript kept");
    assert.equal(runRows(b).length >= 1, true);
    for (const r of want) {
      const row = rateRow(b, r.label);
      assert.ok(row, `hit-rate row for ${r.label}`);
      assert.match(visibleText(row), new RegExp(`\\b${r.got ? 1 : 0}/1\\b`), r.label);
      assert.doesNotMatch(visibleText(row), /chronic/i, "one run is never chronic");
    }
  });

  test("two runs: a point missed both times is chronic, one got both times is not", async () => {
    const b = boot();
    await loadDemo(b);
    await until(() => !el(b, "recall").hidden, "recall panel shown", TURNS);
    await replayOnce(b, 1);
    await replayOnce(b, 2);
    const want = await expectedReplay();
    const got = want.find((r) => r.got);
    const missed = want.find((r) => !r.got);
    assert.match(visibleText(rateRow(b, got.label)), /\b2\/2\b/);
    assert.doesNotMatch(visibleText(rateRow(b, got.label)), /chronic/i);
    assert.match(visibleText(rateRow(b, missed.label)), /\b0\/2\b/);
    assert.match(visibleText(rateRow(b, missed.label)), /chronic/i);
  });

  test("history survives a reload of the page", async () => {
    const first = boot();
    const shared = { rehAdapter: first.rehAdapter, palaceAdapter: first.palaceAdapter, clock: clock() };
    await loadDemo(first);
    await until(() => !el(first, "recall").hidden, "recall panel shown", TURNS);
    await replayOnce(first, 1);
    const again = boot(shared);
    await loadDemo(again);
    await until(() => deleteButtons(again).length === 1, "earlier run listed after reload", TURNS);
    const missed = (await expectedReplay()).find((r) => !r.got);
    assert.match(visibleText(rateRow(again, missed.label)), /\b0\/1\b/);
  });

  test("delete needs a confirm; declined keeps the run, accepted offers Undo that restores it", async () => {
    let answer = false;
    const b = boot({ confirm: () => answer });
    await loadDemo(b);
    await until(() => !el(b, "recall").hidden, "recall panel shown", TURNS);
    await replayOnce(b, 1);
    const before = [...b.rehAdapter.map.entries()];

    b.p.fire(deleteButtons(b)[0], "click");
    await until(() => b.confirms.length === 1, "confirm asked", TURNS);
    await settle(50);
    assert.equal(b.rehAdapter.map.size, 1, "declined confirm deletes nothing");
    assert.equal(el(b, "rehearsal-undo").hidden, true, "no Undo without a delete");

    answer = true;
    b.p.fire(deleteButtons(b)[0], "click");
    await until(() => b.rehAdapter.map.size === 0 && !el(b, "rehearsal-undo").hidden, "deleted, Undo shown", TURNS);
    assert.equal(b.confirms.length, 2, "each delete click asks first");
    await until(() => deleteButtons(b).length === 0, "run removed from history", TURNS);

    b.p.fire(el(b, "rehearsal-undo"), "click");
    await until(() => b.rehAdapter.map.size === 1 && deleteButtons(b).length === 1, "run restored and listed", TURNS);
    assert.deepEqual([...b.rehAdapter.map.entries()], before, "Undo restores the identical record");
    assert.equal(el(b, "rehearsal-undo").hidden, true);
  });
});

// Covers: MEM-030, MEM-032
// Requirement: in live mode the passcode typed into the page rides on every model route (the
// server 401s without it, MEM-034) and never on the open /demo/* fixtures.
describe("live passcode", () => {
  const isLive = (c) => LIVE_ROUTES.includes(c.u);

  test("a typed passcode is sent as X-Memripal-Passcode on every model route only", async () => {
    const b = boot();
    el(b, "passcode").value = "s3cret";
    await loadDemo(b);
    const live = b.server.calls.filter(isLive);
    assert.ok(live.length >= 1 + 1 + POINTS.length * 2, live.map((c) => c.u).join(", "));
    for (const c of live) assert.equal(c.headers.get("x-memripal-passcode"), "s3cret", `${c.method} ${c.u}`);
    for (const c of b.server.calls.filter((c) => c.u.startsWith("/demo/"))) {
      assert.equal(c.headers.get("x-memripal-passcode"), null, `${c.u} never carries the passcode`);
    }
    assert.equal(b.server.calls.find((c) => c.u === "/loci").headers.get("content-type"), "image/jpeg", "other headers kept");
    assert.equal(b.server.calls.find((c) => c.u === "/split").headers.get("content-type"), "application/json");
  });

  test("no passcode typed: no passcode header anywhere", async () => {
    const b = boot();
    el(b, "passcode").value = "";
    await loadDemo(b);
    for (const c of b.server.calls) assert.equal(c.headers.get("x-memripal-passcode"), null, `${c.method} ${c.u}`);
  });
});
