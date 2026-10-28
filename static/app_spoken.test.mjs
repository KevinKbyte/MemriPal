// Covers: MEM-032, MEM-033
// Requirement: with the microphone granted, a recall run is spoken: Start records the mic, Done
// (#recall-submit) relays the recording to POST /recall/audio (with the live passcode), judges the
// returned transcript against the palace points, saves the run as a rehearsal and shows what was said
// vs what is in the palace; the mic is released at the end. Any relay failure (budget spent, fixture
// server, network) falls back to the typed box with a visible message naming the failure, and a typed
// answer still finishes the run. Rehearsal and palace records live in IndexedDB when the browser has
// it, else in localStorage.
// Contract (RED; GREEN implements in static/flow.js and static/app.js):
//   wireApp deps gain AudioContext (typeof AudioContext; app.js passes window.AudioContext or
//     webkitAudioContext). No recordClip seam: flow.js records via mic_wav.js recordClip({stream,
//     AudioContext: deps.AudioContext, maxMs}) and relays via postRecallAudio (chunking per
//     MAX_CHUNK_BYTES allowed: one POST per chunk, at least one).
//   #recall-start, mic granted -> recording starts at once (an AudioContext reading the stream); the
//     mic tracks stay live and #recall-typed stays hidden while recording.
//   #recall-submit while recording -> stop the clip, POST its WAV with keywords = the palace point
//     labels and X-Memripal-Passcode when #passcode is non-empty, append each returned text to the
//     session matcher, end the run (rehearsals.save, #recall-results said-vs-palace, no REPLAY_LABEL);
//     every mic track stopped and the AudioContext closed.
//   RecallAudioError (any code) -> no crash, no rehearsal saved, mic tracks stopped, #recall-typed
//     unhidden, some visible page element's text includes error.code; the session is then typed: the
//     next #recall-submit submits #recall-typed.value and ends the run with no further POST.
//   flow.js exports selectStore({indexedDB, localStorage}, {dbName, storeName, prefix}) -> async
//     {get, put, delete, list} adapter: createIdbAdapter(indexedDB, {dbName, storeName}) when indexedDB
//     is present, else localStorageAdapter(prefix, () => localStorage) (localStorage is a Storage-like
//     object, untouched on the IndexedDB path). app.js builds both stores via selectStore.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { fakePage, find, jsonResponse, memoryAdapter, record, until, visibleText } from "./fake_dom_test.mjs";
import { encodeWav } from "./mic_wav.js";
import { createPalaceStore } from "./palace_store.js";
import { REPLAY_LABEL } from "./recall.js";
import { createMatcher } from "./recall_match.js";
import { createRehearsalStore } from "./rehearsals.js";

const flow = await import("./flow.js").catch((err) => ({ __missing: String(err) }));

function exported(name) {
  assert.ok(name in flow, `static/flow.js must export ${name} (${flow.__missing ?? "not exported"})`);
  return flow[name];
}

const HTML = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const APP_JS = readFileSync(new URL("./app.js", import.meta.url), "utf8");

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
const LABELS = POINTS.map((p) => p.label);
const PLACES = ["lamp", "door", "clock", "shelf", "window", "rug", "chair", "desk", "plant", "mirror", "sofa", "vase"];
const LOCI = PLACES.map((label, i) => ({ n: i + 1, label, box: { x1: 10 + i * 60, y1: 10, x2: 60 + i * 60, y2: 200 } }));
const IMAGE = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==";
const PHOTO = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const NOTES = "The method of loci is more than two thousand years old.";
const SPOKEN = "students can use it for exams and try it on your next shopping list";
const TYPED = "spatial memory is strong and engage every sense";
const SAMPLES = [0, 0.5, -0.5, 0.25, -0.25, 1, -1];
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

/** Fake server for the demo palace; /recall/audio answers via `audio(call)` (may throw). */
function demoServer(audio) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers ?? {});
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    const call = { u, method, headers, body };
    calls.push(call);
    if (u === "/demo/photo.jpg") return new Response(PHOTO, { headers: { "content-type": "image/jpeg" } });
    if (u === "/demo/notes.txt") return new Response(NOTES, { headers: { "content-type": "text/plain" } });
    if (u === "/loci") return jsonResponse({ image: IMAGE, width: 800, height: 600, loci: LOCI });
    if (u === "/split") return jsonResponse({ points: POINTS });
    if (u === "/associate") return jsonResponse({ record: record(body.item, body.locus), status: "valid", sig: `sig_${body.item}` });
    if (u === "/scenes") return jsonResponse({ tier: 1, image: IMAGE, width: 800, height: 600 });
    if (u === "/recall/audio" && method === "POST") return audio(call);
    return jsonResponse({ error: "not_found" }, 404);
  };
  const audioCalls = () => calls.filter((c) => c.method === "POST" && c.u === "/recall/audio");
  return { fn, calls, audioCalls };
}

/** Fake Web Audio at 16 kHz (no resampling), like mic_wav.test.mjs; emit() feeds every live processor. */
function fakeAudio() {
  const state = { contexts: 0, closed: 0, sources: [], processors: [] };
  class FakeAudioContext {
    constructor() {
      state.contexts += 1;
      this.sampleRate = 16000;
      this.destination = { kind: "destination" };
      this.state = "running";
    }
    createMediaStreamSource(stream) {
      state.sources.push(stream);
      return { connect() {}, disconnect() {} };
    }
    createScriptProcessor() {
      const listeners = [];
      const node = {
        onaudioprocess: null,
        connect() {},
        disconnect() {},
        addEventListener(type, f) {
          if (type === "audioprocess") listeners.push(f);
        },
        removeEventListener() {},
        listeners,
      };
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

function micStream() {
  const tracks = [0, 1].map(() => ({ kind: "audio", stopped: 0, stop() { this.stopped += 1; } }));
  return { tracks, stream: { id: "mic", getTracks: () => tracks, getAudioTracks: () => tracks } };
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

function boot(audioReply) {
  const p = pageFromHtml();
  const server = demoServer(audioReply);
  const rehAdapter = kvAdapter();
  const audio = fakeAudio();
  const mic = micStream();
  const asked = [];
  wireApp()({
    doc: p.doc,
    fetch: server.fn,
    store: createPalaceStore(memoryAdapter()),
    rehearsals: createRehearsalStore(rehAdapter, clock()),
    getUserMedia: async (c) => {
      asked.push(c);
      return mic.stream;
    },
    AudioContext: audio.AudioContext,
    location: { hostname: "localhost" },
    loadImage: async (src) => ({ src }),
    confirm: () => true,
    wait: async () => {},
  });
  return { p, server, rehAdapter, audio, mic, asked };
}

function wireApp() {
  return exported("wireApp");
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
const stored = (b) => [...b.rehAdapter.map.values()].map((v) => JSON.parse(v));
const pageMentions = (b, text) => Object.values(b.p.els).some((e) => !e.hidden && visibleText(e).includes(text));
const liveTracks = (b) => b.mic.tracks.filter((t) => t.stopped === 0).length;

function expectedFor(text) {
  const m = createMatcher(POINTS);
  m.append(text);
  return m.results();
}

/** Load the demo palace, then Start: resolves once recording is under way. */
async function startSpoken(b, passcode = "") {
  el(b, "passcode").value = passcode;
  el(b, "auto").checked = true;
  b.p.fire(el(b, "load-demo"), "click");
  await until(() => !el(b, "recall").hidden, "recall panel shown", TURNS);
  b.p.fire(el(b, "recall-start"), "click");
  await until(() => b.audio.state.processors.length >= 1, "recording started (a script processor on the mic)", TURNS);
}

function pcmOf(call) {
  const bytes = Buffer.from(call.body.audio, "base64");
  assert.equal(bytes.subarray(0, 4).toString("latin1"), "RIFF", "each POST carries a WAV");
  assert.equal(bytes.subarray(8, 12).toString("latin1"), "WAVE");
  return bytes.subarray(44);
}

/** Collects unhandled rejections for the test's duration (a crash in a click handler shows up here). */
function watchRejections(t) {
  const seen = [];
  const onRejection = (reason) => seen.push(reason);
  process.on("unhandledRejection", onRejection);
  t.after(() => process.off("unhandledRejection", onRejection));
  return seen;
}

// Covers: MEM-032
// Requirement: a granted microphone turns the recall run into a spoken one: the recording is relayed
// to /recall/audio (with the live passcode), the returned transcript is judged against the palace, the
// run is saved and shown as "what you said vs what is in the palace", and the mic is released.
describe("spoken recall relay", () => {
  for (const passcode of ["s3cret", ""]) {
    test(`Start records, Done relays the WAV and ends the run (passcode ${passcode ? "typed" : "empty"})`, async (t) => {
      const rejections = watchRejections(t);
      const b = boot(() => jsonResponse({ text: SPOKEN }));
      await startSpoken(b, passcode);
      assert.equal(b.asked.length, 1, "the mic is asked for once, on Start");
      assert.deepEqual(b.audio.state.sources, [b.mic.stream], "the recording reads the granted mic stream");
      assert.equal(liveTracks(b), b.mic.tracks.length, "mic tracks stay live while recording");
      assert.equal(el(b, "recall-typed").hidden, true, "no typed box while speaking");
      assert.equal(b.server.audioCalls().length, 0, "nothing relayed before Done");

      b.audio.emit(SAMPLES);
      b.p.fire(el(b, "recall-submit"), "click");
      await until(() => saidRows(b).length === POINTS.length, "said-vs-palace rendered", TURNS);

      const posts = b.server.audioCalls();
      assert.ok(posts.length >= 1, "at least one POST /recall/audio");
      for (const c of posts) {
        assert.deepEqual(c.body.keywords, LABELS, "keywords are the palace point labels");
        assert.equal(c.headers.get("x-memripal-passcode"), passcode || null, "passcode only when typed");
      }
      const pcm = Buffer.concat(posts.map(pcmOf));
      assert.deepEqual([...pcm], [...encodeWav(Float32Array.from(SAMPLES), 16000).subarray(44)], "the recorded audio is what was relayed");

      const want = expectedFor(SPOKEN);
      assert.ok(want.some((r) => r.got) && want.some((r) => !r.got), "oracle has hits and misses");
      saidRows(b).forEach((row, i) => assert.equal(row.className, want[i].got ? "said-got" : "said-missed", LABELS[i]));
      assert.ok(!visibleText(el(b, "recall-results")).includes(REPLAY_LABEL), "a spoken run is not labelled a replay");
      await until(() => stored(b).length === 1, "rehearsal saved", TURNS);
      assert.ok(stored(b)[0].transcript.includes("shopping list"), "the relayed transcript is kept");
      assert.equal(liveTracks(b), 0, "every mic track stopped at the end");
      assert.equal(b.audio.state.closed, b.audio.state.contexts, "the AudioContext is closed");
      assert.deepEqual(rejections, []);
    });
  }
});

// Covers: MEM-032
// Requirement: when the speech relay refuses or cannot be reached (budget spent, fixture-only server,
// network down) the page does not crash: the mic is released, the typed box appears with a message
// naming the failure, and a typed answer still finishes and saves the run.
describe("spoken recall relay failure falls back to typed", () => {
  const FAILURES = [
    { code: "budget_exhausted", reply: () => jsonResponse({ error: "budget_exhausted" }, 429) },
    { code: "live_only", reply: () => jsonResponse({ error: "live_only" }, 409) },
    {
      code: "network",
      reply: () => {
        throw new TypeError("Failed to fetch");
      },
    },
  ];
  for (const { code, reply } of FAILURES) {
    test(`${code}: typed box with a visible ${code} message, then typed submit ends the run`, async (t) => {
      const rejections = watchRejections(t);
      const b = boot(reply);
      await startSpoken(b);
      assert.equal(el(b, "recall-typed").hidden, true, "no typed box while speaking");
      assert.equal(pageMentions(b, code), false, `no ${code} message before the failure`);

      b.audio.emit(SAMPLES);
      b.p.fire(el(b, "recall-submit"), "click");
      await until(() => !el(b, "recall-typed").hidden, "typed box shown after the relay failed", TURNS);
      await until(() => pageMentions(b, code), `a visible message naming ${code}`, TURNS);
      assert.equal(b.server.audioCalls().length >= 1, true, "the relay was tried");
      assert.equal(liveTracks(b), 0, "every mic track stopped after the failure");
      assert.equal(stored(b).length, 0, "a failed relay saves no rehearsal");
      assert.equal(saidRows(b).length, 0, "no results before an answer");

      const tried = b.server.audioCalls().length;
      el(b, "recall-typed").value = TYPED;
      b.p.fire(el(b, "recall-submit"), "click");
      await until(() => saidRows(b).length === POINTS.length, "typed run rendered", TURNS);
      await until(() => stored(b).length === 1, "typed run saved", TURNS);
      const want = expectedFor(TYPED);
      assert.ok(want.some((r) => r.got), "oracle has a hit");
      saidRows(b).forEach((row, i) => assert.equal(row.className, want[i].got ? "said-got" : "said-missed", LABELS[i]));
      assert.equal(b.server.audioCalls().length, tried, "a typed answer is never relayed");
      assert.deepEqual(rejections, [], "no unhandled rejection from the click handlers");
    });
  }
});

/** Minimal in-memory IndexedDB factory: one version, out-of-line keys; callbacks on microtasks. */
function fakeIndexedDB() {
  const dbs = new Map();
  const request = () => ({ result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null });
  const connection = (stores) => ({
    createObjectStore: (name) => {
      stores.set(name, new Map());
      return { name };
    },
    transaction: (name) => {
      if (!stores.has(name)) throw new DOMException(`no store ${name}`, "NotFoundError");
      const recs = stores.get(name);
      const tx = { error: null, oncomplete: null, onabort: null };
      const op = (run) => {
        const req = request();
        queueMicrotask(() => {
          req.result = run();
          req.onsuccess?.({});
          queueMicrotask(() => tx.oncomplete?.({}));
        });
        return req;
      };
      const store = {
        get: (k) => op(() => (recs.has(k) ? structuredClone(recs.get(k)) : undefined)),
        put: (v, k) => op(() => (recs.set(k, structuredClone(v)), k)),
        delete: (k) => op(() => void recs.delete(k)),
        getAll: () => op(() => [...recs.keys()].sort().map((k) => structuredClone(recs.get(k)))),
      };
      tx.objectStore = () => store;
      return tx;
    },
    close() {},
  });
  return {
    dbs,
    open(name) {
      const req = request();
      queueMicrotask(() => {
        const fresh = !dbs.has(name);
        if (fresh) dbs.set(name, new Map());
        req.result = connection(dbs.get(name));
        if (fresh) req.onupgradeneeded?.({});
        req.onsuccess?.({});
      });
      return req;
    },
  };
}

function fakeStorage() {
  const map = new Map();
  const writes = [];
  return {
    map,
    writes,
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      writes.push(k);
      map.set(k, String(v));
    },
    removeItem: (k) => void map.delete(k),
  };
}

const OPTS = { dbName: "memripal-test", storeName: "rehearsals", prefix: "memripal.rehearsal:" };

// Covers: MEM-033
// Requirement: the browser keeps rehearsal and palace records in IndexedDB when it has one (so they
// survive a reload), and falls back to localStorage only when IndexedDB is missing.
describe("IndexedDB store selection", () => {
  test("indexedDB present: records land in IndexedDB, never in localStorage", async () => {
    const idb = fakeIndexedDB();
    const ls = fakeStorage();
    const a = exported("selectStore")({ indexedDB: idb, localStorage: ls }, OPTS);
    await a.put("r1", { x: 1 });
    await a.put("r2", { x: 2 });
    assert.deepEqual(idb.dbs.get(OPTS.dbName)?.get(OPTS.storeName)?.get("r1"), { x: 1 }, "written to dbName/storeName");
    assert.deepEqual(await a.get("r1"), { x: 1 });
    assert.deepEqual(await a.list(), [{ x: 1 }, { x: 2 }]);
    await a.delete("r1");
    assert.equal(await a.get("r1"), undefined);
    assert.equal(ls.writes.length, 0, "localStorage untouched");
    assert.equal(ls.length, 0);
  });

  for (const missing of [undefined, null]) {
    test(`indexedDB ${missing}: records land in localStorage under the prefix`, async () => {
      const ls = fakeStorage();
      const a = exported("selectStore")({ indexedDB: missing, localStorage: ls }, OPTS);
      await a.put("r1", { x: 1 });
      assert.equal(ls.getItem(`${OPTS.prefix}r1`), JSON.stringify({ x: 1 }));
      assert.deepEqual(await a.get("r1"), { x: 1 });
      assert.deepEqual(await a.list(), [{ x: 1 }]);
      await a.delete("r1");
      assert.equal(ls.length, 0);
    });
  }

  test("a rehearsal saved through the selected IndexedDB store is listed after a reload", async () => {
    const idb = fakeIndexedDB();
    const env = { indexedDB: idb, localStorage: fakeStorage() };
    const first = createRehearsalStore(exported("selectStore")(env, OPTS), clock());
    const results = expectedFor(SPOKEN);
    await first.save("demo", { transcript: SPOKEN, results });
    const again = createRehearsalStore(exported("selectStore")(env, OPTS), clock());
    const runs = await again.list("demo");
    assert.equal(runs.length, 1);
    assert.deepEqual(runs[0].points.map((p) => p.got), results.map((r) => r.got));
    assert.equal(env.localStorage.length, 0);
  });

  test("app.js builds both stores through selectStore and hands wireApp an AudioContext", () => {
    assert.match(APP_JS, /import\s*\{[^}]*\bselectStore\b[^}]*\}\s*from\s*["']\.\/flow\.js["']/);
    assert.ok((APP_JS.match(/\bselectStore\s*\(/g) ?? []).length >= 2, "palace and rehearsal stores both via selectStore");
    assert.doesNotMatch(APP_JS, /\blocalStorageAdapter\s*\(/, "localStorage only as selectStore's fallback");
    assert.match(APP_JS, /\bAudioContext\b/, "the page passes AudioContext to wireApp");
  });
});
