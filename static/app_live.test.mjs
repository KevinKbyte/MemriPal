// Covers: MEM-037
// Requirement: during a spoken recall run the palace points light up while Kev is still speaking:
// Start shows a "LIVE" board with one row per point, every 5 s slice of the recording is relayed to
// POST /recall/audio and the points it names light at once, before Done. A relay failure mid-run
// falls back to the typed box like a failed Done (mic released, message naming the failure, no more
// relaying) and keeps what was already lit. Done finishes the run from the live slices plus the
// untaken remainder and saves it once. The offline replay lights its board ("recorded replay") chunk
// by chunk. Typed mode shows no board.
// Contract (RED; GREEN implements in static/flow.js, static/recall_live.js, static/mic_wav.js,
// static/index.html):
//   ASSUMPTION: wireApp deps accept injected setInterval / clearInterval (falling back to
//     globalThis.setInterval / clearInterval when absent), passed to createLiveRelay, so these tests
//     fire relay ticks by hand. The relay interval period is LIVE_SLICE_MS (5000).
//   index.html: <div id="recall-live"> inside <section id="recall">. The harness adds the root to its
//     fake page if index.html lacks it, so the page-level tests fail on behaviour, not on a missing
//     root; a separate test pins the markup.
//   Board: renderLiveBoard renders into #recall-live: p.live-badge ("LIVE" or "recorded replay") and
//     ol.live-board with one li per point in palace order; a lit point's li has class "lit".
//   Recording: still mic_wav.js recordClip (no seam); take() slices since the last mark; stop() returns
//     the untaken remainder, or null when a take() ran and nothing is new since it.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { deferred, fakePage, find, findAll, jsonResponse, memoryAdapter, record, settle, until, visibleText } from "./fake_dom_test.mjs";
import { createPalaceStore } from "./palace_store.js";
import { createMatcher } from "./recall_match.js";
import { createRehearsalStore } from "./rehearsals.js";

const flow = await import("./flow.js").catch((err) => ({ __missing: String(err) }));

function wireApp() {
  assert.ok("wireApp" in flow, `static/flow.js must export wireApp (${flow.__missing ?? "not exported"})`);
  return flow.wireApp;
}

const HTML = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const TIMELINE = JSON.parse(readFileSync(new URL("../fixtures/demo/recall_timeline.json", import.meta.url), "utf8"));

// Recorded demo split reply (MEM-023), as in app_spoken.test.mjs.
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
// First live slice names point 9; the Done remainder names point 11.
const SLICE_A = "um students can use it for exams";
const SLICE_B = "and try it on your next shopping list";
const TYPED = "spatial memory is strong and engage every sense";
const SAMPLES = [0, 0.5, -0.5, 0.25, -0.25, 1, -1];
const MORE = [0.1, -0.1, 0.2, -0.2];
const FAILED = "Speech relay failed (budget_exhausted)";
const LIVE_SLICE_MS = 5000;
const TURNS = 5000;

/** Page roots as index.html declares them, plus #recall-live if the markup lacks it (see Contract). */
function pageFromHtml() {
  const ids = [];
  const hidden = [];
  for (const m of HTML.matchAll(/<[a-z][a-z0-9]*\b[^>]*>/gi)) {
    const id = /\bid="([^"]+)"/.exec(m[0]);
    if (!id) continue;
    ids.push(id[1]);
    if (/\shidden(?=[\s>=/])/.test(m[0])) hidden.push(id[1]);
  }
  if (!ids.includes("recall-live")) ids.push("recall-live");
  return fakePage(ids, { hidden });
}

/** Fake server; the n-th POST /recall/audio answers replies[n]() (default: empty transcript). */
function demoServer(replies) {
  const calls = [];
  const audioCalls = () => calls.filter((c) => c.method === "POST" && c.u === "/recall/audio");
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
    if (u === "/recall/audio" && method === "POST") {
      const n = audioCalls().length - 1;
      return replies[n] ? replies[n]() : jsonResponse({ text: "" });
    }
    return jsonResponse({ error: "not_found" }, 404);
  };
  return { fn, calls, audioCalls };
}

/** Fake Web Audio at 16 kHz, as in app_spoken.test.mjs; emit() feeds every live processor. */
function fakeAudio() {
  const state = { contexts: 0, closed: 0, sources: [], processors: [] };
  class FakeAudioContext {
    constructor() {
      state.contexts += 1;
      Object.assign(this, { sampleRate: 16000, destination: { kind: "destination" }, state: "running" });
    }
    createMediaStreamSource(stream) {
      state.sources.push(stream);
      return { connect() {}, disconnect() {} };
    }
    createScriptProcessor() {
      const listeners = [];
      const add = (type, f) => type === "audioprocess" && listeners.push(f);
      const node = { onaudioprocess: null, connect() {}, disconnect() {}, addEventListener: add, removeEventListener() {}, listeners };
      state.processors.push(node);
      return node;
    }
    async resume() {}
    async close() {
      state.closed += 1;
      this.state = "closed";
    }
  }
  const emit = (values) => {
    const frame = Float32Array.from(values);
    const event = { inputBuffer: { numberOfChannels: 1, sampleRate: 16000, length: frame.length, getChannelData: () => frame } };
    for (const node of state.processors) {
      if (typeof node.onaudioprocess === "function") node.onaudioprocess(event);
      for (const f of node.listeners) f(event);
    }
  };
  return { AudioContext: FakeAudioContext, state, emit };
}

/** Hand-driven interval timers: fire() runs every interval not yet cleared; no wall clock. */
function fakeTimers() {
  const live = new Map();
  const periods = [];
  let next = 1;
  return {
    setInterval: (fn, ms) => (periods.push(ms), live.set(next, fn), next++),
    clearInterval: (id) => void live.delete(id),
    fire: () => [...live.values()].forEach((fn) => fn()),
    active: () => live.size,
    periods,
  };
}

function micStream() {
  const tracks = [0, 1].map(() => ({ kind: "audio", stopped: 0, stop() { this.stopped += 1; } }));
  return { tracks, stream: { id: "mic", getTracks: () => tracks, getAudioTracks: () => tracks } };
}

function kvAdapter() {
  const map = new Map();
  return { map, get: async (k) => map.get(k), put: async (k, v) => void map.set(k, v), delete: async (k) => void map.delete(k), list: async () => [...map.values()] };
}

function clock() {
  let t = Date.UTC(2026, 9, 31, 9, 0, 0);
  let n = 0;
  return { now: () => (t += 60_000), newId: () => `reh-${++n}` };
}

function boot(opts = {}) {
  const p = pageFromHtml();
  const server = demoServer(opts.replies ?? []);
  const rehAdapter = kvAdapter();
  const audio = fakeAudio();
  const mic = micStream();
  const timers = fakeTimers();
  wireApp()({
    doc: p.doc,
    fetch: server.fn,
    store: createPalaceStore(memoryAdapter()),
    rehearsals: createRehearsalStore(rehAdapter, clock()),
    getUserMedia: "getUserMedia" in opts ? opts.getUserMedia : async () => mic.stream,
    AudioContext: "AudioContext" in opts ? opts.AudioContext : audio.AudioContext,
    location: { hostname: "localhost" },
    loadImage: async (src) => ({ src }),
    confirm: () => true,
    wait: opts.wait ?? (async () => {}),
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  });
  return { p, server, rehAdapter, audio, mic, timers };
}

const el = (b, id) => {
  const e = b.p.els[id];
  assert.ok(e, `index.html must contain #${id}`);
  return e;
};
const hasClass = (n, c) => n.classList.contains(c) || String(n.className).split(/\s+/).includes(c);
const board = (b) => find(el(b, "recall-live"), (n) => n.tagName === "OL" && hasClass(n, "live-board"), { visibleOnly: true });
const boardItems = (b) => board(b)?.children.filter((c) => typeof c === "object" && c.tagName === "LI") ?? [];
const litIndices = (b) => boardItems(b).flatMap((li, i) => (hasClass(li, "lit") ? [i] : []));
const badgeText = (b) => {
  const badge = find(el(b, "recall-live"), (n) => n.tagName === "P" && hasClass(n, "live-badge"), { visibleOnly: true });
  return badge ? visibleText(badge).trim() : null;
};
const anyBoard = (b) => Object.values(b.p.els).some((e) => findAll(e, (n) => n.tagName === "OL" && hasClass(n, "live-board")).length > 0);
const saidRows = (b) => {
  const list = find(el(b, "recall-results"), (n) => n.tagName === "OL" && n.className === "said-vs-palace");
  return list ? list.children.filter((c) => typeof c === "object" && c.tagName === "LI") : [];
};
const stored = (b) => [...b.rehAdapter.map.values()].map((v) => JSON.parse(v));
const pageMentions = (b, text) => Object.values(b.p.els).some((e) => !e.hidden && visibleText(e).includes(text));
const liveTracks = (b) => b.mic.tracks.filter((t) => t.stopped === 0).length;
const gotIndices = (results) => results.flatMap((r, i) => (r.got ? [i] : []));
const assertRows = (b, want) =>
  saidRows(b).forEach((row, i) => assert.equal(row.className, want[i].got ? "said-got" : "said-missed", LABELS[i]));

/** Matcher oracle over the texts in order. */
function expectedFor(...texts) {
  const m = createMatcher(POINTS);
  for (const t of texts) m.append(t);
  return m.results();
}

async function loadDemo(b, passcode = "") {
  el(b, "passcode").value = passcode;
  el(b, "auto").checked = true;
  b.p.fire(el(b, "load-demo"), "click");
  await until(() => !el(b, "recall").hidden, "recall panel shown", TURNS);
}

/** Load the demo palace, Start, and wait for the recording and the live board. */
async function startLive(b, passcode = "") {
  await loadDemo(b, passcode);
  b.p.fire(el(b, "recall-start"), "click");
  await until(() => b.audio.state.processors.length >= 1, "recording started (a script processor on the mic)", TURNS);
  await until(() => boardItems(b).length === POINTS.length, "live board with one li per point in #recall-live", TURNS);
}

/** Feed audio, fire one relay tick, wait for the n-th POST /recall/audio. */
async function sliceTick(b, samples, posts) {
  b.audio.emit(samples);
  b.timers.fire();
  await until(() => b.server.audioCalls().length === posts, `relay tick posted slice ${posts}`, TURNS);
}

function watchRejections(t) {
  const seen = [];
  const onRejection = (reason) => seen.push(reason);
  process.on("unhandledRejection", onRejection);
  t.after(() => process.off("unhandledRejection", onRejection));
  return seen;
}

// Covers: MEM-037
// Requirement: Start with a microphone shows a "LIVE" board listing every palace point, and a point
// lights up as soon as a 5 s slice of what Kev said names it, before he presses Done.
describe("live recall board lights points while speaking", () => {
  test("index.html has <div id=\"recall-live\"> inside #recall", () => {
    const section = /<section\b[^>]*\bid="recall"[^>]*>([\s\S]*?)<\/section>/i.exec(HTML);
    assert.ok(section, "index.html has <section id=\"recall\">");
    assert.match(section[1], /<div\b[^>]*\bid="recall-live"/, "#recall-live is a div inside #recall");
  });

  test("Start renders the LIVE board; a relayed slice lights its point before Done", async (t) => {
    const rejections = watchRejections(t);
    const want = gotIndices(expectedFor(SLICE_A));
    assert.ok(want.length >= 1 && want.length < POINTS.length, "oracle: slice A names some points, not all");
    const b = boot({ replies: [() => jsonResponse({ text: SLICE_A })] });
    await startLive(b, "s3cret");
    assert.equal(badgeText(b), "LIVE");
    boardItems(b).forEach((li, i) => assert.ok(li.textContent.includes(LABELS[i]), `row ${i} shows its label`));
    assert.deepEqual(litIndices(b), [], "nothing lit before any slice");
    assert.ok(b.timers.periods.includes(LIVE_SLICE_MS), "the relay ticks every 5 s");
    assert.equal(b.server.audioCalls().length, 0, "nothing relayed before the first tick");

    await sliceTick(b, SAMPLES, 1);
    await until(() => litIndices(b).length === want.length, "slice A's point lit", TURNS);
    assert.deepEqual(litIndices(b), want);
    const post = b.server.audioCalls()[0];
    assert.deepEqual(post.body.keywords, LABELS, "keywords are the palace point labels");
    assert.equal(post.headers.get("x-memripal-passcode"), "s3cret", "the live passcode rides on each slice");
    assert.equal(saidRows(b).length, 0, "the run has not ended");
    assert.equal(stored(b).length, 0, "nothing saved before Done");
    assert.equal(liveTracks(b), b.mic.tracks.length, "the mic stays live while speaking");
    assert.equal(el(b, "recall-typed").hidden, true, "no typed box while speaking");
    assert.deepEqual(rejections, []);
  });

  test("a tick with no new audio since the last slice posts nothing", async (t) => {
    const rejections = watchRejections(t);
    const b = boot({ replies: [() => jsonResponse({ text: SLICE_A })] });
    await startLive(b);
    await sliceTick(b, SAMPLES, 1);
    b.timers.fire();
    await settle(50);
    assert.equal(b.server.audioCalls().length, 1, "an empty slice is never relayed");
    assert.deepEqual(rejections, []);
  });
});

// Covers: MEM-037
// Requirement: if the speech relay fails mid-run (e.g. the call budget is spent) the page behaves as a
// failed Done: the mic is released, the typed box appears with "Speech relay failed (<code>)", no
// further slices are sent, and the points already lit stay lit; a typed answer still ends the run.
describe("live relay failure falls back to typed", () => {
  test("429 on a slice: typed box, message, mic released, lit points kept, relaying stops", async (t) => {
    const rejections = watchRejections(t);
    const lit = gotIndices(expectedFor(SLICE_A));
    const b = boot({
      replies: [() => jsonResponse({ text: SLICE_A }), () => jsonResponse({ error: "budget_exhausted" }, 429)],
    });
    await startLive(b);
    await sliceTick(b, SAMPLES, 1);
    await until(() => litIndices(b).length === lit.length, "slice A lit", TURNS);
    assert.equal(pageMentions(b, FAILED), false, "no failure message before the failure");

    await sliceTick(b, MORE, 2);
    await until(() => !el(b, "recall-typed").hidden, "typed box shown after the live relay failed", TURNS);
    await until(() => pageMentions(b, FAILED), `a visible "${FAILED}" message`, TURNS);
    assert.equal(liveTracks(b), 0, "every mic track stopped after the failure");
    assert.equal(b.audio.state.closed, b.audio.state.contexts, "the recording is stopped (AudioContext closed)");
    assert.deepEqual(litIndices(b), lit, "points lit before the failure stay lit");
    assert.equal(stored(b).length, 0, "a failed relay saves no rehearsal");

    for (let i = 0; i < 3; i++) {
      b.audio.emit(MORE);
      b.timers.fire();
    }
    await settle(50);
    assert.equal(b.server.audioCalls().length, 2, "no slice is relayed after the failure");
    assert.equal(b.timers.active(), 0, "the relay timer is cleared");

    el(b, "recall-typed").value = TYPED;
    b.p.fire(el(b, "recall-submit"), "click");
    await until(() => saidRows(b).length === POINTS.length, "typed answer ends the run", TURNS);
    await until(() => stored(b).length === 1, "typed run saved", TURNS);
    assert.equal(b.server.audioCalls().length, 2, "the typed answer is never relayed");
    assert.deepEqual(rejections, [], "no unhandled rejection from the relay or click handlers");
  });
});

// Covers: MEM-037
// Requirement: Done ends a live run with everything Kev said: the points matched by the live slices
// plus those matched only in the untaken remainder, lit on the board and judged in the results; the
// run is saved exactly once and the mic and relay timer are released.
describe("Done after live slices", () => {
  test("results combine live slices and the remainder post; saved once", async (t) => {
    const rejections = watchRejections(t);
    const want = expectedFor(SLICE_A, SLICE_B);
    const fromA = gotIndices(expectedFor(SLICE_A));
    const onlyB = gotIndices(want).filter((i) => !fromA.includes(i));
    assert.ok(fromA.length >= 1 && onlyB.length >= 1 && want.some((r) => !r.got), "oracle: A hits, B-only hits, misses");
    const b = boot({ replies: [() => jsonResponse({ text: SLICE_A }), () => jsonResponse({ text: SLICE_B })] });
    await startLive(b);
    await sliceTick(b, SAMPLES, 1);
    await until(() => litIndices(b).length === fromA.length, "slice A lit", TURNS);

    b.audio.emit(MORE);
    b.p.fire(el(b, "recall-submit"), "click");
    await until(() => saidRows(b).length === POINTS.length, "said-vs-palace rendered", TURNS);
    assert.ok(b.server.audioCalls().length >= 2, "the untaken remainder is posted on Done");
    assertRows(b, want);
    assert.deepEqual(litIndices(b), gotIndices(want), "the remainder's matches light too");
    await until(() => stored(b).length === 1, "rehearsal saved", TURNS);
    await settle(50);
    assert.equal(stored(b).length, 1, "the run is saved exactly once");
    assert.deepEqual(stored(b)[0].points.map((p) => p.got), want.map((r) => r.got));
    assert.equal(liveTracks(b), 0, "every mic track stopped at the end");
    assert.equal(b.audio.state.closed, b.audio.state.contexts, "the AudioContext is closed");
    assert.equal(b.timers.active(), 0, "the relay timer is cleared");
    assert.deepEqual(rejections, []);
  });

  test("Done while a slice is in flight waits for it before posting the remainder", async (t) => {
    const rejections = watchRejections(t);
    const want = expectedFor(SLICE_A, SLICE_B);
    const inFlight = deferred();
    const b = boot({ replies: [() => inFlight.promise, () => jsonResponse({ text: SLICE_B })] });
    await startLive(b);
    await sliceTick(b, SAMPLES, 1);

    b.audio.emit(MORE);
    b.p.fire(el(b, "recall-submit"), "click");
    await settle(50);
    assert.equal(b.server.audioCalls().length, 1, "the remainder waits for the in-flight slice");
    assert.equal(saidRows(b).length, 0, "the run waits for the in-flight slice");

    inFlight.resolve(jsonResponse({ text: SLICE_A }));
    await until(() => saidRows(b).length === POINTS.length, "said-vs-palace rendered", TURNS);
    assert.ok(b.server.audioCalls().length >= 2, "the remainder is posted after the slice");
    assertRows(b, want);
    await until(() => stored(b).length === 1, "rehearsal saved", TURNS);
    await settle(50);
    assert.equal(stored(b).length, 1, "the run is saved exactly once");
    assert.deepEqual(rejections, []);
  });

  test("Done with nothing new since the last slice posts no remainder", async (t) => {
    const rejections = watchRejections(t);
    const want = expectedFor(SLICE_A);
    const b = boot({ replies: [() => jsonResponse({ text: SLICE_A })] });
    await startLive(b);
    await sliceTick(b, SAMPLES, 1);
    await until(() => litIndices(b).length === gotIndices(want).length, "slice A lit", TURNS);

    b.p.fire(el(b, "recall-submit"), "click");
    await until(() => saidRows(b).length === POINTS.length, "said-vs-palace rendered", TURNS);
    assert.equal(b.server.audioCalls().length, 1, "no empty remainder is relayed");
    assertRows(b, want);
    await until(() => stored(b).length === 1, "rehearsal saved", TURNS);
    assert.equal(liveTracks(b), 0, "every mic track stopped at the end");
    assert.deepEqual(rejections, []);
  });
});

// Covers: MEM-037
// Requirement: the offline replay shows the same board, labelled "recorded replay", and lights each
// chunk's points as the recording plays, ending with exactly the points the results count as got.
describe("replay lights the board as it plays", () => {
  test("board labelled recorded replay; lit set grows chunk by chunk to the final results", async (t) => {
    const rejections = watchRejections(t);
    const oracle = createMatcher(POINTS);
    const cumulative = TIMELINE.chunks.map((chunk) => (oracle.append(chunk.text), gotIndices(oracle.results())));
    assert.ok(cumulative[0].length >= 1, "oracle: the first chunk names a point");
    assert.ok(cumulative.at(-1).length > cumulative[0].length, "oracle: later chunks light more");

    const waits = [];
    const b = boot({ wait: () => new Promise((resolve) => waits.push(resolve)) });
    await loadDemo(b);
    b.p.fire(el(b, "recall-replay"), "click");
    await until(() => boardItems(b).length === POINTS.length, "replay board with one li per point in #recall-live", TURNS);
    assert.equal(badgeText(b), "recorded replay");
    await until(() => waits.length === 1, "replay waiting before its first chunk", TURNS);
    assert.deepEqual(litIndices(b), [], "nothing lit before the first chunk plays");

    for (let k = 0; k < TIMELINE.chunks.length; k++) {
      waits[k]();
      const last = k === TIMELINE.chunks.length - 1;
      await until(() => (last ? saidRows(b).length === POINTS.length : waits.length === k + 2), `chunk ${k} played`, TURNS);
      assert.deepEqual(litIndices(b), cumulative[k], `lit after chunk ${k}`);
    }
    const gotRows = saidRows(b).flatMap((row, i) => (row.className === "said-got" ? [i] : []));
    assert.deepEqual(litIndices(b), gotRows, "lit points == points got in the end results");
    assert.equal(badgeText(b), "recorded replay");
    assert.equal(b.server.audioCalls().length, 0, "a replay never reaches the speech relay");
    assert.deepEqual(rejections, []);
  });
});

// Covers: MEM-037
// Requirement: when the run is typed (no microphone, mic denied, or no Web Audio) there is nothing
// live to show, so no board appears and nothing is relayed.
describe("typed mode has no live board", () => {
  const denied = async () => {
    throw new DOMException("Permission denied", "NotAllowedError");
  };
  const CASES = [
    { name: "no getUserMedia", opts: { getUserMedia: undefined } },
    { name: "mic denied", opts: { getUserMedia: denied } },
    { name: "no AudioContext", opts: { AudioContext: undefined } },
  ];
  for (const { name, opts } of CASES) {
    test(`${name}: typed box, no ol.live-board, no relay timer`, async (t) => {
      const rejections = watchRejections(t);
      const b = boot(opts);
      await loadDemo(b);
      b.p.fire(el(b, "recall-start"), "click");
      await until(() => !el(b, "recall-typed").hidden, "typed box shown", TURNS);
      await settle(50);
      assert.equal(anyBoard(b), false, "no live board in typed mode");
      assert.equal(b.timers.active(), 0, "no relay timer in typed mode");

      el(b, "recall-typed").value = TYPED;
      b.p.fire(el(b, "recall-submit"), "click");
      await until(() => saidRows(b).length === POINTS.length, "typed run rendered", TURNS);
      assert.equal(anyBoard(b), false, "still no live board after the typed run");
      assert.equal(b.server.audioCalls().length, 0, "a typed run is never relayed");
      assert.deepEqual(rejections, []);
    });
  }
});
