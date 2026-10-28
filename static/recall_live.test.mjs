// Covers: MEM-037
// Requirement: palace points light up while Kev is still speaking: a board shows every point (badged LIVE or
// recorded replay), and a relay posts a 5 s audio slice per tick through the unchanged recall relay, lighting
// whatever the matcher newly finds, and stopping cleanly on a relay failure or when the run ends.
// Contract (RED; GREEN implements in static/recall_live.js):
//   LIVE_SLICE_MS === 5000.
//   renderLiveBoard(points, doc, {label}) -> {el, light(indices)}
//     el holds p.live-badge (text = label) and ol.live-board, one li per point in palace order showing its
//     label; textContent only. light(indices): those rows get class "lit" and data-state "got"; unknown or
//     out-of-range indices ignored; idempotent.
//   createLiveRelay({clip, post, matcher, onMatch, onFail, every, setInterval, clearInterval}) -> {stop()}
//     setInterval(tick, every ?? 5000). Tick: skip while a post is in flight; else clip.take(); null -> no
//     post; else post(wav) -> {text} -> onMatch(matcher.append(text)). RecallAudioError from post ->
//     clearInterval(handle), onFail(err), no further posts. stop() clears the interval and resolves only
//     after any in-flight post settles; idempotent.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import * as live from "./recall_live.js";
import { RecallAudioError } from "./mic_wav.js";
import { createMatcher } from "./recall_match.js";

const POINTS = [
  ["The method is over two thousand years old", "The method of loci is more than two thousand years"],
  ["Place each item at a familiar spot", "place each thing you want to remember at a familiar spot"],
  ["Vivid images stick better than plain facts", "Vivid images stick better than plain facts."],
  ["Students can use it for exams", "Students can use it for exams"],
].map(([label, source_quote]) => ({ label, source_quote }));
const VIVID = 2;

/** Fake document: class/data-state writes through any API land in one place; HTML-string writes are logged. */
function fakePage() {
  const htmlWrites = [];
  const created = [];
  const textOf = (node) => (typeof node === "string" ? node : node.textContent);
  const camel = (name) => name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  function el(tag) {
    let own = "";
    let tokens = [];
    const e = {
      tagName: String(tag).toUpperCase(),
      children: [],
      attrs: {},
      dataset: {},
      hidden: false,
      id: "",
      get className() {
        return tokens.join(" ");
      },
      set className(v) {
        tokens = String(v).split(/\s+/).filter(Boolean);
      },
      classList: {
        add: (...c) => c.forEach((x) => tokens.includes(x) || tokens.push(x)),
        remove: (...c) => (tokens = tokens.filter((x) => !c.includes(x))),
        toggle: (x, force) => {
          const on = force === undefined ? !tokens.includes(x) : Boolean(force);
          tokens = tokens.filter((y) => y !== x);
          if (on) tokens.push(x);
          return on;
        },
        contains: (x) => tokens.includes(x),
      },
      get textContent() {
        return own + this.children.map(textOf).join("");
      },
      set textContent(v) {
        own = String(v);
        this.children = [];
      },
      append(...c) {
        this.children.push(...c);
      },
      appendChild(c) {
        this.children.push(c);
        return c;
      },
      replaceChildren(...c) {
        own = "";
        this.children = c;
      },
      setAttribute(k, v) {
        if (k === "class") e.className = v;
        else if (k.startsWith("data-")) e.dataset[camel(k)] = String(v);
        else this.attrs[k] = String(v);
      },
      getAttribute(k) {
        if (k === "class") return e.className;
        if (k.startsWith("data-")) return e.dataset[camel(k)] ?? null;
        return this.attrs[k] ?? null;
      },
      insertAdjacentHTML(pos, html) {
        htmlWrites.push(["insertAdjacentHTML", String(html)]);
      },
    };
    e.tokens = () => [...tokens];
    for (const prop of ["innerHTML", "outerHTML"]) {
      Object.defineProperty(e, prop, {
        get: () => "",
        set: (v) => htmlWrites.push([prop, String(v)]),
      });
    }
    return e;
  }
  const doc = {
    getElementById: () => null,
    createElement: (tag) => {
      created.push(String(tag).toLowerCase());
      return el(tag);
    },
    createTextNode: (t) => String(t),
    createDocumentFragment: () => el("#fragment"),
  };
  return { doc, htmlWrites, created };
}

function* walk(node) {
  if (!node || typeof node === "string") return;
  yield node;
  for (const c of node.children ?? []) yield* walk(c);
}

const find = (root, tag, cls) =>
  [...walk(root)].filter((n) => n.tagName === tag.toUpperCase() && (!cls || n.tokens().includes(cls)));

function board(points, label = "LIVE") {
  const page = fakePage();
  const out = live.renderLiveBoard(points, page.doc, { label });
  const [ol] = find(out.el, "ol", "live-board");
  const rows = ol ? find(ol, "li") : [];
  return { ...page, out, ol, rows };
}

const isLit = (row) => row.tokens().includes("lit") && row.dataset.state === "got";
const isUnlit = (row) => !row.tokens().includes("lit") && row.dataset.state === undefined;

// Covers: MEM-037
// Requirement: recall_live.js exports the board, the relay and the 5 s slice length.
describe("recall_live exports", () => {
  test("exports renderLiveBoard, createLiveRelay and LIVE_SLICE_MS = 5000", () => {
    assert.equal(typeof live.renderLiveBoard, "function");
    assert.equal(typeof live.createLiveRelay, "function");
    assert.equal(live.LIVE_SLICE_MS, 5000);
  });
});

// Covers: MEM-037
// Requirement: the live board lists every palace point in order under a badge saying whether this is LIVE or a
// recorded replay, rendering model text as plain text only.
describe("renderLiveBoard: badge and rows", () => {
  for (const label of ["LIVE", "recorded replay"]) {
    test(`badge p.live-badge reads "${label}"`, () => {
      const { out } = board(POINTS, label);
      const badges = find(out.el, "p", "live-badge");
      assert.equal(badges.length, 1, "expected exactly one p.live-badge");
      assert.equal(badges[0].textContent, label);
    });
  }

  test("ol.live-board has one li per point in palace order, each showing its label, none lit", () => {
    const { ol, rows } = board(POINTS);
    assert.ok(ol, "no ol.live-board in el");
    assert.equal(rows.length, POINTS.length);
    rows.forEach((row, i) => {
      assert.ok(row.textContent.includes(POINTS[i].label), `row ${i} lacks its label`);
      assert.ok(isUnlit(row), `row ${i} starts lit`);
    });
  });

  test("an HTML-shaped label stays text: no HTML-string write, no element created from it", () => {
    const evil = "<img src=x onerror=1>";
    const { rows, htmlWrites, created } = board([{ label: evil, source_quote: "q" }, POINTS[0]]);
    assert.deepEqual(htmlWrites, []);
    assert.ok(!created.includes("img"), "an img element was created");
    assert.ok(rows[0].textContent.includes(evil));
  });

  test("an empty palace renders an empty board and light() is a no-op", () => {
    const { ol, rows, out } = board([]);
    assert.ok(ol, "no ol.live-board in el");
    assert.equal(rows.length, 0);
    out.light([0]);
  });
});

// Covers: MEM-037
// Requirement: a recalled point lights (class "lit", data-state "got") and stays lit; bad indices never break
// the board.
describe("renderLiveBoard: light(indices)", () => {
  test("lights exactly the given rows; the rest stay unlit", () => {
    const { out, rows } = board(POINTS);
    out.light([1, 3]);
    assert.deepEqual(
      rows.map((r) => (isLit(r) ? "lit" : isUnlit(r) ? "unlit" : "mixed")),
      ["unlit", "lit", "unlit", "lit"],
    );
  });

  test("successive calls accumulate", () => {
    const { out, rows } = board(POINTS);
    out.light([0]);
    out.light([2]);
    assert.deepEqual(rows.map(isLit), [true, false, true, false]);
  });

  test("unknown and out-of-range indices are ignored", () => {
    const { out, rows } = board(POINTS);
    out.light([-1, POINTS.length, 99, 1.5]);
    out.light([]);
    assert.ok(rows.every(isUnlit));
    out.light([99, 0]);
    assert.deepEqual(rows.map(isLit), [true, false, false, false]);
  });

  test("lighting a row twice is idempotent", () => {
    const { out, rows } = board(POINTS);
    out.light([2]);
    out.light([2, 2]);
    assert.deepEqual(
      rows[2].tokens().filter((c) => c === "lit"),
      ["lit"],
    );
    assert.equal(rows[2].dataset.state, "got");
    assert.equal(rows.length, POINTS.length);
  });
});

/** Fake timer pair: records setInterval calls; fire() runs live (uncleared) intervals only. */
function fakeTimers() {
  const intervals = [];
  const cleared = [];
  return {
    intervals,
    cleared,
    setInterval: (fn, ms) => {
      const handle = { id: intervals.length + 1 };
      intervals.push({ fn, ms, handle });
      return handle;
    },
    clearInterval: (handle) => {
      cleared.push(handle);
    },
    fire() {
      for (const it of intervals) if (!cleared.includes(it.handle)) it.fn();
    },
  };
}

const settle = () => new Promise((r) => setImmediate(r));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Builds a relay over fakes; posts resolve via the queue `replies` (a value, an Error, or a deferred). */
function rig({ wavs = [], replies = [], matcher, every } = {}) {
  const timers = fakeTimers();
  const log = { takes: 0, posts: [], matches: [], fails: [], appended: [] };
  const clip = {
    take: async () => {
      log.takes += 1;
      return wavs.length ? wavs.shift() : null;
    },
  };
  const post = (...args) => {
    log.posts.push(args);
    const r = replies.shift();
    if (r && typeof r.promise === "object") return r.promise;
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
  };
  const m = matcher ?? {
    append: (text) => {
      log.appended.push(text);
      return [log.appended.length * 10];
    },
  };
  const opts = {
    clip,
    post,
    matcher: m,
    onMatch: (idx) => log.matches.push(idx),
    onFail: (err) => log.fails.push(err),
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  };
  if (every !== undefined) opts.every = every;
  const relay = live.createLiveRelay(opts);
  return { relay, timers, log };
}

const wav = (n) => new Uint8Array([82, 73, 70, 70, n]);

// Covers: MEM-037
// Requirement: every 5 s (by default) the relay takes the newest audio slice, sends it through the recall
// relay, and lights whatever the matcher newly recognises; silence sends nothing.
describe("createLiveRelay: ticks", () => {
  test("starts one interval at LIVE_SLICE_MS (5000) by default", () => {
    const { timers } = rig();
    assert.equal(timers.intervals.length, 1);
    assert.equal(timers.intervals[0].ms, 5000);
  });

  test("a custom every is passed to setInterval", () => {
    const { timers } = rig({ every: 1234 });
    assert.deepEqual(
      timers.intervals.map((i) => i.ms),
      [1234],
    );
  });

  test("no take or post happens before the first tick", async () => {
    const { log } = rig({ wavs: [wav(1)], replies: [{ text: "x" }] });
    await settle();
    assert.equal(log.takes, 0);
    assert.equal(log.posts.length, 0);
  });

  test("tick: take() -> post(wav) -> onMatch(matcher.append(text))", async () => {
    const a = wav(1);
    const { timers, log } = rig({ wavs: [a], replies: [{ text: "hello there" }] });
    timers.fire();
    await settle();
    assert.equal(log.takes, 1);
    assert.equal(log.posts.length, 1);
    assert.equal(log.posts[0][0], a, "post did not receive the taken wav");
    assert.deepEqual(log.appended, ["hello there"]);
    assert.deepEqual(log.matches, [[10]]);
    assert.deepEqual(log.fails, []);
  });

  test("with a real matcher, a spoken point reaches onMatch as its index", async () => {
    const { timers, log } = rig({
      wavs: [wav(1), wav(2)],
      replies: [{ text: "vivid images stick better than plain facts" }, { text: "and that is all" }],
      matcher: createMatcher(POINTS),
    });
    timers.fire();
    await settle();
    timers.fire();
    await settle();
    assert.deepEqual(log.matches, [[VIVID], []]);
  });

  test("take() resolving null posts nothing and calls onMatch nothing", async () => {
    const { timers, log } = rig({ wavs: [], replies: [{ text: "never" }] });
    timers.fire();
    await settle();
    assert.equal(log.takes, 1);
    assert.equal(log.posts.length, 0);
    assert.deepEqual(log.matches, []);
  });

  test("a tick while a post is in flight is skipped (no second take); the next tick after it settles takes", async () => {
    const slow = deferred();
    const { timers, log } = rig({ wavs: [wav(1), wav(2)], replies: [slow, { text: "second" }] });
    timers.fire();
    await settle();
    assert.equal(log.posts.length, 1);
    timers.fire();
    await settle();
    assert.equal(log.takes, 1, "a tick during an in-flight post called take()");
    assert.equal(log.posts.length, 1);
    slow.resolve({ text: "first" });
    await settle();
    timers.fire();
    await settle();
    assert.equal(log.takes, 2);
    assert.equal(log.posts.length, 2);
    assert.deepEqual(log.appended, ["first", "second"]);
  });
});

// Covers: MEM-037
// Requirement: a relay failure (RecallAudioError) ends live lighting once: the interval is cleared, the page is
// told exactly once, and no further audio is sent.
describe("createLiveRelay: relay failure", () => {
  test("RecallAudioError -> clearInterval(handle), onFail(err) once, later ticks post nothing", async () => {
    const err = new RecallAudioError("budget_exhausted", 429);
    const { timers, log } = rig({ wavs: [wav(1), wav(2), wav(3)], replies: [err, { text: "x" }, { text: "y" }] });
    timers.fire();
    await settle();
    assert.ok(timers.cleared.includes(timers.intervals[0].handle), "interval not cleared");
    assert.deepEqual(log.fails, [err]);
    assert.deepEqual(log.matches, []);
    timers.fire();
    await settle();
    timers.fire();
    await settle();
    assert.equal(log.posts.length, 1);
    assert.deepEqual(log.fails, [err]);
  });
});

// Covers: MEM-037
// Requirement: ending the run stops the slices and waits for the slice already in the air, so Done never races
// a live post; stopping twice is harmless.
describe("createLiveRelay: stop()", () => {
  test("stop() clears the interval handle and later ticks post nothing", async () => {
    const { relay, timers, log } = rig({ wavs: [wav(1)], replies: [{ text: "x" }] });
    await relay.stop();
    assert.ok(timers.cleared.includes(timers.intervals[0].handle), "interval not cleared");
    timers.fire();
    await settle();
    assert.equal(log.posts.length, 0);
  });

  test("stop() resolves only after an in-flight post settles", async () => {
    const slow = deferred();
    const { relay, timers, log } = rig({ wavs: [wav(1)], replies: [slow] });
    timers.fire();
    await settle();
    assert.equal(log.posts.length, 1);
    let stopped = false;
    const done = relay.stop().then(() => {
      stopped = true;
    });
    await settle();
    await settle();
    assert.equal(stopped, false, "stop() resolved while a post was still in flight");
    slow.resolve({ text: "late" });
    await done;
    assert.equal(stopped, true);
  });

  test("stop() with nothing in flight resolves", async () => {
    const { relay } = rig();
    await relay.stop();
  });

  test("stop() is idempotent", async () => {
    const { relay, timers, log } = rig({ wavs: [wav(1)], replies: [{ text: "x" }] });
    await relay.stop();
    await relay.stop();
    timers.fire();
    await settle();
    assert.equal(log.posts.length, 0);
    assert.deepEqual(log.fails, []);
  });
});
