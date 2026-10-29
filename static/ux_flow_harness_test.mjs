// Shared page harness for the UX regression tests (app_ux_*.test.mjs). Not a test file itself (no
// describe/test); same fake page and demo server shape as app_live.test.mjs, plus hooks to hold a
// request or the mic pending (deferreds, never wall-clock sleeps) and to make AudioContext.close() or
// the rehearsal store fail.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { deferred, fakePage, find, findAll, jsonResponse, memoryAdapter, record, settle, until, visibleText } from "./fake_dom_test.mjs";
import { createPalaceStore } from "./palace_store.js";
import { createRehearsalStore } from "./rehearsals.js";

export { deferred, find, findAll, jsonResponse, settle, until, visibleText };

const flow = await import("./flow.js").catch((err) => ({ __missing: String(err) }));

const HTML = readFileSync(new URL("./index.html", import.meta.url), "utf8");
export const TIMELINE = JSON.parse(readFileSync(new URL("../fixtures/demo/recall_timeline.json", import.meta.url), "utf8"));

export const POINTS = [
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
export const TURNS = 5000;

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

/**
 * Demo server. Optional hooks: photo() / recall() / split() return the answer (a Response or a
 * promise of one; a fresh Response per call); replies[n]() answers the n-th POST /recall/audio;
 * health is the GET /healthz JSON body (e.g. {status: "ok", mode: "fixture"}; default 404).
 */
function demoServer(opts) {
  const calls = [];
  const posts = (u) => calls.filter((c) => c.method === "POST" && c.u === u);
  const fn = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method ?? "GET").toUpperCase();
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ u, method, body });
    if (u === "/demo/photo.jpg") {
      return opts.photo ? opts.photo() : new Response(PHOTO, { headers: { "content-type": "image/jpeg" } });
    }
    if (u === "/healthz" && opts.health) return jsonResponse(opts.health);
    if (u === "/demo/notes.txt") return new Response("notes", { headers: { "content-type": "text/plain" } });
    if (u === "/demo/recall.json") return opts.recall ? opts.recall() : jsonResponse(TIMELINE);
    if (u === "/loci") return jsonResponse({ image: IMAGE, width: 800, height: 600, loci: LOCI });
    if (u === "/split") return opts.split ? opts.split() : jsonResponse({ points: POINTS });
    if (u === "/associate") return jsonResponse({ record: record(body.item, body.locus), status: "valid", sig: `sig_${body.item}` });
    if (u === "/scenes") return jsonResponse({ tier: 1, image: IMAGE, width: 800, height: 600 });
    if (u === "/recall/audio" && method === "POST") {
      const n = posts(u).length - 1;
      return opts.replies?.[n] ? opts.replies[n]() : jsonResponse({ text: "" });
    }
    return jsonResponse({ error: "not_found" }, 404);
  };
  return { fn, calls, posts };
}

/** Fake Web Audio at 16 kHz; closeRejects makes every AudioContext.close() reject. */
function fakeAudio({ closeRejects = false } = {}) {
  const state = { contexts: 0, closeCalls: 0, processors: [] };
  class FakeAudioContext {
    constructor() {
      state.contexts += 1;
      Object.assign(this, { sampleRate: 16000, destination: { kind: "destination" }, state: "running" });
    }
    createMediaStreamSource() {
      return { connect() {}, disconnect() {} };
    }
    createScriptProcessor() {
      const node = { onaudioprocess: null, connect() {}, disconnect() {}, addEventListener() {}, removeEventListener() {} };
      state.processors.push(node);
      return node;
    }
    async resume() {}
    async close() {
      state.closeCalls += 1;
      if (closeRejects) throw new Error("close boom");
      this.state = "closed";
    }
  }
  const emit = (values) => {
    const frame = Float32Array.from(values);
    const event = { inputBuffer: { numberOfChannels: 1, sampleRate: 16000, length: frame.length, getChannelData: () => frame } };
    for (const node of state.processors) if (typeof node.onaudioprocess === "function") node.onaudioprocess(event);
  };
  return { AudioContext: FakeAudioContext, state, emit };
}

/** Hand-driven interval timers: fire() runs every interval not yet cleared. */
function fakeTimers() {
  const live = new Map();
  let next = 1;
  return {
    setInterval: (fn) => (live.set(next, fn), next++),
    clearInterval: (id) => void live.delete(id),
    fire: () => [...live.values()].forEach((fn) => fn()),
    active: () => live.size,
  };
}

/**
 * A microphone handing out a fresh 2-track stream per getUserMedia call. hold: each call stays
 * pending until release(); deny: each call rejects (permission denied).
 */
function micDevice({ hold = false, deny = false } = {}) {
  const streams = [];
  const held = [];
  const getUserMedia = async () => {
    const tracks = [0, 1].map(() => ({ kind: "audio", stopped: 0, stop() { this.stopped += 1; } }));
    const stream = { id: `mic-${streams.length + 1}`, getTracks: () => tracks, getAudioTracks: () => tracks };
    streams.push(stream);
    if (deny) throw new DOMException("denied", "NotAllowedError");
    if (!hold) return stream;
    const d = deferred();
    held.push(() => d.resolve(stream));
    return d.promise;
  };
  return {
    getUserMedia,
    calls: () => streams.length,
    release: () => held.splice(0).forEach((go) => go()),
    liveTracks: () => streams.flatMap((s) => s.getTracks()).filter((t) => t.stopped === 0).length,
  };
}

export function kvAdapter(initial = []) {
  const map = new Map(initial);
  return { map, get: async (k) => map.get(k), put: async (k, v) => void map.set(k, v), delete: async (k) => void map.delete(k), list: async () => [...map.values()] };
}

function clock() {
  let t = Date.UTC(2026, 9, 31, 9, 0, 0);
  let n = 0;
  return { now: () => (t += 60_000), newId: () => `reh-${++n}` };
}

/**
 * Wire the page. opts: photo / recall / split / replies / health (server hooks), mic ({hold, deny}),
 * closeRejects, rehAdapter (rehearsal store adapter; default an in-memory map).
 */
export function boot(opts = {}) {
  assert.ok("wireApp" in flow, `static/flow.js must export wireApp (${flow.__missing ?? "not exported"})`);
  const p = pageFromHtml();
  const server = demoServer(opts);
  const rehAdapter = opts.rehAdapter ?? kvAdapter();
  const audio = fakeAudio({ closeRejects: opts.closeRejects });
  const mic = micDevice(opts.mic);
  const timers = fakeTimers();
  flow.wireApp({
    doc: p.doc,
    fetch: server.fn,
    store: createPalaceStore(memoryAdapter()),
    rehearsals: createRehearsalStore(rehAdapter, clock()),
    getUserMedia: mic.getUserMedia,
    AudioContext: audio.AudioContext,
    location: { hostname: "localhost" },
    loadImage: async (src) => ({ src }),
    confirm: () => true,
    wait: async () => {},
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  });
  return { p, server, rehAdapter, audio, mic, timers };
}

export const el = (b, id) => {
  const e = b.p.els[id];
  assert.ok(e, `index.html must contain #${id}`);
  return e;
};
export const click = (b, id) => b.p.fire(el(b, id), "click");
export const stored = (b) => [...b.rehAdapter.map.values()].filter((v) => typeof v === "string").length;
export const historyRows = (b) => findAll(el(b, "rehearsals"), (n) => n.tagName === "LI", { visibleOnly: true }).length;
export const saidRows = (b) => {
  const list = find(el(b, "recall-results"), (n) => n.tagName === "OL" && n.className === "said-vs-palace");
  return list ? list.children.filter((c) => typeof c === "object" && c.tagName === "LI").length : 0;
};
export const liveBoardRows = (b) => {
  const list = find(el(b, "recall-live"), (n) => n.tagName === "OL" && String(n.className).includes("live-board"), { visibleOnly: true });
  return list ? list.children.filter((c) => typeof c === "object" && c.tagName === "LI").length : 0;
};
export const pageMentions = (b, text) => Object.values(b.p.els).some((e) => !e.hidden && visibleText(e).includes(text));

/** Tick the Auto box and click Load demo; resolves once the recall panel shows. */
export async function loadDemo(b) {
  el(b, "auto").checked = true;
  click(b, "load-demo");
  await until(() => !el(b, "recall").hidden, "recall panel shown", TURNS);
  await settle(20);
}

/** Collects unhandled rejections for the rest of the test. */
export function watchRejections(t) {
  const seen = [];
  const onRejection = (reason) => seen.push(reason);
  process.on("unhandledRejection", onRejection);
  t.after(() => process.off("unhandledRejection", onRejection));
  return seen;
}
