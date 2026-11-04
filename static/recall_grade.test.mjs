// Covers: MEM-136
// Requirement: an opt-in "Grade recall with Spark" setting sends grade: true with each recall slice; a valid
// Spark grade lights paraphrased points on top of the keyword matcher; a malformed or absent grade leaves
// keyword scoring exactly as before; when Spark is unavailable the board says it fell back to keyword match
// once, offering the visitor's own-key prompt, and the notice can be dismissed.
// Contract (RED; GREEN implements):
//   static/recall_settings.js: GRADE_SETTING_KEY === "memripal.gradeWithSpark"; gradeWithSpark(storage) ->
//     boolean (default false; getItem throws -> false); setGradeWithSpark(storage, on) persists, never throws.
//   static/mic_wav.js postRecallAudio({fetch, wav, keywords, passcode, grade}): body gains `grade: true` only
//     when grade is true (else body stays exactly {audio, keywords}); reply {text, grade} with a valid grade
//     ({provider: string, latency_ms: int >= 0, items: [{index: int >= 0, verdict: correct|partial|miss,
//     reason: string}]}) -> {text, grade}; malformed grade -> {text}; grade_error present -> {text,
//     gradeError: true}.
//   static/recall_match.js createMatcher(points).gradeGot(i): got = true, override stays false, start =
//     current token count (so countInOrder still orders it); already-got or out-of-range -> no change.
//   static/recall_live.js createLiveRelay({..., onGrade, onDowngrade}): per reply, matcher.append(text)
//     hits plus every "correct" grade index (matcher.gradeGot(i)) -> one onMatch(ascending unique indices);
//     partial/miss never count; onGrade(grade) when a grade arrives; gradeError -> onDowngrade() once per
//     relay. renderLiveBoard(...) board.tag(grade) -> one .grade-tag element, text
//     "Spark - <provider> - <latency_ms> ms"; board.downgrade(onAddKey) -> one .grade-downgrade notice whose
//     text has "Spark is unavailable" and "keyword match", a .grade-downgrade-key button calling onAddKey and
//     a .grade-downgrade-dismiss button that hides the notice (hidden = true or removed).
//   static/byok.js exports showKeyPrompt (the existing own-key prompt) for the notice's key button.
//   static/index.html #tab-settings holds input#grade-with-spark[type=checkbox] labelled
//     "Grade recall with Spark".
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as mic from "./mic_wav.js";
import * as live from "./recall_live.js";
import * as byok from "./byok.js";
import { countInOrder, createMatcher } from "./recall_match.js";

const POINTS = [
  ["The method is over two thousand years old", "The method of loci is more than two thousand years"],
  ["Place each item at a familiar spot", "place each thing you want to remember at a familiar spot"],
  ["Vivid images stick better than plain facts", "Vivid images stick better than plain facts."],
  ["Students can use it for exams", "Students can use it for exams"],
].map(([label, source_quote]) => ({ label, source_quote }));
const VIVID = 2;
const GRADE = Object.freeze({
  provider: "fireworks",
  latency_ms: 412,
  items: [
    { index: 0, verdict: "partial", reason: "close" },
    { index: 3, verdict: "correct", reason: "exams paraphrased" },
  ],
});

async function settings() {
  return import("./recall_settings.js");
}

function memoryStorage() {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

const throwing = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceeded");
  },
  removeItem: () => {
    throw new Error("SecurityError");
  },
};

describe("recall_settings: gradeWithSpark", () => {
  test("defaults to false and round-trips under memripal.gradeWithSpark", async () => {
    const s = await settings();
    assert.equal(s.GRADE_SETTING_KEY, "memripal.gradeWithSpark");
    const store = memoryStorage();
    assert.equal(s.gradeWithSpark(store), false);
    s.setGradeWithSpark(store, true);
    assert.ok(store.map.has("memripal.gradeWithSpark"));
    assert.equal(s.gradeWithSpark(store), true);
    s.setGradeWithSpark(store, false);
    assert.equal(s.gradeWithSpark(store), false);
  });

  test("a throwing storage reads false and set swallows", async () => {
    const s = await settings();
    assert.equal(s.gradeWithSpark(throwing), false);
    assert.doesNotThrow(() => s.setGradeWithSpark(throwing, true));
  });

  test("a junk stored value reads false", async () => {
    const s = await settings();
    const store = memoryStorage();
    store.setItem("memripal.gradeWithSpark", "maybe");
    assert.equal(s.gradeWithSpark(store), false);
  });
});

function fakeFetch(body) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  return { fetch, calls };
}

describe("postRecallAudio: Spark grade", () => {
  const wav = mic.encodeWav(new Float32Array([0, 0.5]), 16000);

  test("grade: true adds grade: true to the body and passes a valid grade through", async () => {
    const { fetch, calls } = fakeFetch({ text: "exams", grade: GRADE });
    const out = await mic.postRecallAudio({ fetch, wav, keywords: ["a"], passcode: "", grade: true });
    assert.deepEqual(out, { text: "exams", grade: GRADE });
    const sent = JSON.parse(calls[0].init.body);
    assert.equal(sent.grade, true);
    assert.deepEqual(sent.keywords, ["a"]);
  });

  test("grade off: no grade field is sent", async () => {
    for (const grade of [false, undefined]) {
      const { fetch, calls } = fakeFetch({ text: "x" });
      await mic.postRecallAudio({ fetch, wav, keywords: ["a"], passcode: "", grade });
      assert.deepEqual(Object.keys(JSON.parse(calls[0].init.body)).sort(), ["audio", "keywords"]);
    }
  });

  const MALFORMED = [
    null,
    "fireworks",
    { provider: "fireworks", latency_ms: 412 },
    { provider: "fireworks", latency_ms: 412, items: "nope" },
    { provider: 7, latency_ms: 412, items: [] },
    { provider: "fireworks", latency_ms: "412", items: [] },
    { provider: "fireworks", latency_ms: 412, items: [{ index: "3", verdict: "correct", reason: "" }] },
    { provider: "fireworks", latency_ms: 412, items: [{ index: -1, verdict: "correct", reason: "" }] },
    { provider: "fireworks", latency_ms: 412, items: [{ index: 1.5, verdict: "correct", reason: "" }] },
    { provider: "fireworks", latency_ms: 412, items: [{ index: 1, verdict: "yes", reason: "" }] },
  ];
  for (const [i, grade] of MALFORMED.entries()) {
    test(`malformed grade #${i} is dropped: returns {text} only`, async () => {
      const { fetch } = fakeFetch({ text: "exams", grade });
      const out = await mic.postRecallAudio({ fetch, wav, keywords: ["a"], passcode: "", grade: true });
      assert.deepEqual(out, { text: "exams" });
    });
  }

  test("grade_error -> {text, gradeError: true}", async () => {
    const { fetch } = fakeFetch({ text: "exams", grade_error: "unavailable" });
    const out = await mic.postRecallAudio({ fetch, wav, keywords: ["a"], passcode: "", grade: true });
    assert.deepEqual(out, { text: "exams", gradeError: true });
  });
});

describe("createMatcher: gradeGot", () => {
  test("marks the point got (not override) at the current token count; countInOrder still orders it", () => {
    const m = createMatcher(POINTS);
    assert.deepEqual(m.append("vivid images stick better than plain facts"), [VIVID]);
    m.append("and then something else entirely");
    m.gradeGot(3);
    const r = m.results()[3];
    assert.equal(r.got, true);
    assert.equal(r.override, false);
    const starts = m.starts();
    assert.equal(typeof starts[3], "number");
    assert.ok(starts[3] > starts[VIVID]);
    assert.equal(countInOrder(starts)[3], true);
  });

  test("an already-got point keeps its speech start; out-of-range is ignored", () => {
    const m = createMatcher(POINTS);
    m.append("vivid images stick better than plain facts");
    const before = m.starts()[VIVID];
    m.append("more words here");
    m.gradeGot(VIVID);
    assert.equal(m.starts()[VIVID], before);
    assert.doesNotThrow(() => {
      m.gradeGot(99);
      m.gradeGot(-1);
      m.gradeGot(1.5);
    });
    assert.equal(m.results().filter((p) => p.got).length, 1);
  });
});

function fakeTimers() {
  const intervals = [];
  const cleared = [];
  return {
    intervals,
    setInterval: (fn, ms) => {
      const handle = { id: intervals.length + 1 };
      intervals.push({ fn, ms, handle });
      return handle;
    },
    clearInterval: (h) => cleared.push(h),
    fire() {
      for (const it of intervals) if (!cleared.includes(it.handle)) it.fn();
    },
  };
}

const settle = () => new Promise((r) => setImmediate(r));
const wavBytes = (n) => new Uint8Array([82, 73, 70, 70, n]);

function rig(replies) {
  const timers = fakeTimers();
  const log = { matches: [], grades: [], downgrades: 0, fails: [] };
  const queue = [...replies];
  let n = 0;
  const matcher = createMatcher(POINTS);
  live.createLiveRelay({
    clip: { take: async () => wavBytes((n += 1)) },
    post: async () => queue.shift(),
    matcher,
    onMatch: (idx) => log.matches.push(idx),
    onFail: (err) => log.fails.push(err),
    onGrade: (g) => log.grades.push(g),
    onDowngrade: () => {
      log.downgrades += 1;
    },
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  });
  const tick = async () => {
    timers.fire();
    await settle();
    await settle();
  };
  return { tick, log, matcher };
}

describe("createLiveRelay: Spark grade", () => {
  test("onMatch gets the union of keyword hits and grade-correct indices; partial never counts", async () => {
    const { tick, log, matcher } = rig([{ text: "vivid images stick better than plain facts", grade: GRADE }]);
    await tick();
    assert.deepEqual(log.matches, [[VIVID, 3]]);
    assert.deepEqual(log.grades, [GRADE]);
    const got = matcher.results().map((p) => p.got);
    assert.deepEqual(got, [false, false, true, true]);
    assert.deepEqual(log.fails, []);
  });

  test("a paraphrase the keyword matcher misses still lights from the grade", async () => {
    const grade = { provider: "baseten", latency_ms: 9, items: [{ index: 1, verdict: "correct", reason: "" }] };
    const { tick, log } = rig([{ text: "the bang-bang sky lights", grade }]);
    await tick();
    assert.deepEqual(log.matches, [[1]]);
  });

  test("no grade: keyword scoring exactly as before, onGrade and onDowngrade untouched", async () => {
    const { tick, log } = rig([{ text: "vivid images stick better than plain facts" }]);
    await tick();
    assert.deepEqual(log.matches, [[VIVID]]);
    assert.deepEqual(log.grades, []);
    assert.equal(log.downgrades, 0);
  });

  test("gradeError -> onDowngrade once per relay, keyword scoring still runs", async () => {
    const { tick, log } = rig([
      { text: "vivid images stick better than plain facts", gradeError: true },
      { text: "nothing", gradeError: true },
    ]);
    await tick();
    await tick();
    assert.deepEqual(log.matches, [[VIVID], []]);
    assert.equal(log.downgrades, 1);
    assert.deepEqual(log.fails, []);
  });
});

/** Minimal fake document with click listeners, parents and hidden. */
function fakeDoc() {
  const htmlWrites = [];
  function el(tag) {
    let own = "";
    let tokens = [];
    const listeners = {};
    const e = {
      tagName: String(tag).toUpperCase(),
      children: [],
      parent: null,
      dataset: {},
      attrs: {},
      hidden: false,
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
        return own + e.children.map((c) => (typeof c === "string" ? c : c.textContent)).join("");
      },
      set textContent(v) {
        own = String(v);
        e.children = [];
      },
      _adopt(nodes) {
        for (const c of nodes) if (c && typeof c === "object") c.parent = e;
        return nodes;
      },
      append(...c) {
        e.children.push(...e._adopt(c));
      },
      appendChild(c) {
        e.children.push(...e._adopt([c]));
        return c;
      },
      prepend(...c) {
        e.children.unshift(...e._adopt(c));
      },
      replaceChildren(...c) {
        own = "";
        e.children = e._adopt(c);
      },
      insertBefore(c, ref) {
        const i = e.children.indexOf(ref);
        e.children.splice(i < 0 ? e.children.length : i, 0, ...e._adopt([c]));
        return c;
      },
      after(...c) {
        const p = e.parent;
        if (!p) return;
        p.children.splice(p.children.indexOf(e) + 1, 0, ...p._adopt(c));
      },
      before(...c) {
        const p = e.parent;
        if (!p) return;
        p.children.splice(p.children.indexOf(e), 0, ...p._adopt(c));
      },
      remove() {
        if (e.parent) e.parent.children = e.parent.children.filter((x) => x !== e);
        e.parent = null;
      },
      setAttribute(k, v) {
        if (k === "class") e.className = v;
        else if (k === "hidden") e.hidden = true;
        else e.attrs[k] = String(v);
      },
      removeAttribute(k) {
        if (k === "hidden") e.hidden = false;
        else delete e.attrs[k];
      },
      getAttribute: (k) => (k === "class" ? e.className : (e.attrs[k] ?? null)),
      addEventListener(type, fn) {
        (listeners[type] ??= []).push(fn);
      },
      click() {
        for (const fn of listeners.click ?? []) fn({ type: "click", preventDefault() {}, target: e });
      },
      tokens: () => [...tokens],
    };
    for (const prop of ["innerHTML", "outerHTML"]) {
      Object.defineProperty(e, prop, { get: () => "", set: (v) => htmlWrites.push([prop, String(v)]) });
    }
    return e;
  }
  const doc = {
    createElement: (tag) => el(tag),
    createTextNode: (t) => String(t),
    createDocumentFragment: () => el("#fragment"),
    getElementById: () => null,
  };
  return { doc, htmlWrites };
}

function* walk(node) {
  if (!node || typeof node === "string") return;
  yield node;
  for (const c of node.children ?? []) yield* walk(c);
}

const byClass = (root, cls) => [...walk(root)].filter((n) => n.tokens().includes(cls));
const visible = (root, cls) =>
  [...walk(root)].filter((n) => n.tokens().includes(cls) && ![n, ...ancestors(n)].some((a) => a.hidden));
function ancestors(n) {
  const out = [];
  for (let p = n.parent; p; p = p.parent) out.push(p);
  return out;
}

function board() {
  const page = fakeDoc();
  const out = live.renderLiveBoard(POINTS, page.doc, { label: "LIVE" });
  return { ...page, out };
}

describe("renderLiveBoard: grade tag", () => {
  test('tag(grade) renders one .grade-tag reading "Spark - fireworks - 412 ms"', () => {
    const { out, htmlWrites } = board();
    out.tag(GRADE);
    const tags = visible(out.el, "grade-tag");
    assert.equal(tags.length, 1);
    assert.equal(tags[0].textContent, "Spark - fireworks - 412 ms");
    assert.deepEqual(htmlWrites, []);
  });

  test("a later tag replaces the text; still one .grade-tag", () => {
    const { out } = board();
    out.tag(GRADE);
    out.tag({ ...GRADE, provider: "baseten", latency_ms: 87 });
    const tags = byClass(out.el, "grade-tag");
    assert.equal(tags.length, 1);
    assert.equal(tags[0].textContent, "Spark - baseten - 87 ms");
  });

  test("an HTML-shaped provider stays text", () => {
    const { out, htmlWrites } = board();
    out.tag({ ...GRADE, provider: "<img src=x>" });
    assert.equal(byClass(out.el, "grade-tag")[0].textContent, "Spark - <img src=x> - 412 ms");
    assert.deepEqual(htmlWrites, []);
  });

  test("no tag before any grade", () => {
    const { out } = board();
    assert.equal(visible(out.el, "grade-tag").length, 0);
  });
});

describe("renderLiveBoard: downgrade notice", () => {
  test("downgrade(onAddKey) shows one notice naming the keyword fallback, with an own-key button", () => {
    const { out, htmlWrites } = board();
    let asked = 0;
    out.downgrade(() => {
      asked += 1;
    });
    out.downgrade(() => {
      asked += 1;
    });
    const notes = visible(out.el, "grade-downgrade");
    assert.equal(notes.length, 1);
    assert.match(notes[0].textContent, /Spark is unavailable/);
    assert.match(notes[0].textContent, /keyword match/);
    const [key] = byClass(notes[0], "grade-downgrade-key");
    assert.ok(key, "no .grade-downgrade-key button");
    key.click();
    assert.equal(asked, 1);
    assert.deepEqual(htmlWrites, []);
  });

  test("dismiss hides the notice", () => {
    const { out } = board();
    out.downgrade(() => {});
    const [note] = visible(out.el, "grade-downgrade");
    const [dismiss] = byClass(note, "grade-downgrade-dismiss");
    assert.ok(dismiss, "no .grade-downgrade-dismiss button");
    dismiss.click();
    assert.equal(visible(out.el, "grade-downgrade").length, 0);
  });

  test("byok.js exports showKeyPrompt for the notice's own-key button", () => {
    assert.equal(typeof byok.showKeyPrompt, "function");
  });
});

describe("index.html: Grade recall with Spark setting", () => {
  test("#tab-settings holds checkbox #grade-with-spark labelled Grade recall with Spark", () => {
    const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
    const start = html.indexOf('id="tab-settings"');
    assert.ok(start >= 0, "no #tab-settings");
    const end = html.indexOf("</section>", start);
    const panel = html.slice(start, end);
    const input = panel.match(/<input\b[^>]*\bid="grade-with-spark"[^>]*>/);
    assert.ok(input, "no input#grade-with-spark inside #tab-settings");
    assert.match(input[0], /type="checkbox"/);
    assert.match(panel, /Grade recall with Spark/);
  });
});
