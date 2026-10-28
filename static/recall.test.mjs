// Covers: MEM-032
// Requirement: spoken recall still works without a microphone (typed box on the same matcher, never Web
// Speech), and fixture mode replays a recorded transcript timeline offline, labelled as a replay (D4).
// Contract (RED; GREEN implements in static/recall.js):
//   startRecall({points, getUserMedia, doc}) -> Promise<session>
//     points = [{label, source_quote}] in palace order; getUserMedia = the bound
//     navigator.mediaDevices.getUserMedia (or undefined/null when unsupported); doc offers getElementById.
//     getUserMedia missing, throwing, or rejecting -> session.mode === "typed" and #recall-typed is shown
//     (hidden = false). SpeechRecognition / webkitSpeechRecognition are never constructed (D17: never Web
//     Speech).
//     session.submitTyped(text) -> number[]: feeds text to a createMatcher(points) from recall_match.js and
//       returns the indices newly matched by it; session.results() -> that matcher's results().
//   replayRecording(timeline, matcher, {wait}) -> Promise<results>
//     timeline = {label, chunks: [{t_ms, text}]}; for each chunk in order: await wait(gap_ms) then
//     matcher.append(text), gap_ms = t_ms minus the previous chunk's t_ms (the first gap is its t_ms);
//     resolves to matcher.results(). No network call.
//   REPLAY_LABEL === "replay of a recorded session".
//   fixtures/demo/recall_timeline.json (GREEN creates it) is that timeline for the demo palace.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import * as recall from "./recall.js";
import { createMatcher, matchTranscript } from "./recall_match.js";

// Recorded demo split reply (fixtures/replay/spark_json, MEM-023), 12 points in speech order.
const DEMO_POINTS = [
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

const VIVID = 3;
const REPLAY_LABEL = "replay of a recorded session";
const TIMELINE_URL = new URL("../fixtures/demo/recall_timeline.json", import.meta.url);

/** Used only until GREEN commits the fixture; mirrors its shape (some points said, some not). */
const INLINE_TIMELINE = {
  label: REPLAY_LABEL,
  chunks: [
    { t_ms: 0, text: "okay so the first spot" },
    { t_ms: 1800, text: "vivid images stick better than plain facts" },
    { t_ms: 4200, text: "and students can use it for exams" },
    { t_ms: 6100, text: "um I forget the rest" },
  ],
};

function demoTimeline() {
  return existsSync(TIMELINE_URL) ? JSON.parse(readFileSync(TIMELINE_URL, "utf8")) : INLINE_TIMELINE;
}

/** Fake page holding the hidden typed-answer box. */
function fakePage() {
  const typed = { id: "recall-typed", hidden: true, value: "", attrs: {}, setAttribute() {}, addEventListener() {} };
  const els = { "recall-typed": typed };
  const doc = {
    getElementById: (id) => els[id] ?? null,
    querySelector: (sel) => (sel === "#recall-typed" ? typed : null),
  };
  return { doc, typed };
}

/** Puts constructor traps for both Web Speech names on globalThis; returns the construction log. */
function trapWebSpeech(t) {
  const constructed = [];
  for (const name of ["SpeechRecognition", "webkitSpeechRecognition"]) {
    const had = Object.prototype.hasOwnProperty.call(globalThis, name);
    const prev = globalThis[name];
    globalThis[name] = class {
      constructor() {
        constructed.push(name);
      }
      start() {}
      stop() {}
      addEventListener() {}
    };
    t.after(() => {
      if (had) globalThis[name] = prev;
      else delete globalThis[name];
    });
  }
  return constructed;
}

/** Every network door trapped and counted. */
function trapNetwork(t) {
  const calls = [];
  const trap = (name) =>
    function () {
      calls.push(name);
      throw new Error(`${name} called during an offline replay`);
    };
  t.mock.method(globalThis, "fetch", trap("fetch"));
  for (const name of ["XMLHttpRequest", "WebSocket", "EventSource"]) {
    const had = Object.prototype.hasOwnProperty.call(globalThis, name);
    const prev = globalThis[name];
    globalThis[name] = trap(name);
    t.after(() => {
      if (had) globalThis[name] = prev;
      else delete globalThis[name];
    });
  }
  return calls;
}

const denied = (name) => () => Promise.reject(Object.assign(new Error(`${name}`), { name }));

const MIC_UNAVAILABLE = [
  ["getUserMedia missing (undefined)", undefined],
  ["getUserMedia missing (null)", null],
  ["permission denied (NotAllowedError)", denied("NotAllowedError")],
  ["no microphone (NotFoundError)", denied("NotFoundError")],
  [
    "getUserMedia throws synchronously (insecure context)",
    () => {
      throw new TypeError("getUserMedia is not allowed in an insecure context");
    },
  ],
];

// Covers: MEM-032
// Requirement: recall.js exports startRecall, replayRecording and the replay label.
describe("recall exports", () => {
  test("exports startRecall, replayRecording and REPLAY_LABEL", () => {
    assert.equal(typeof recall.startRecall, "function");
    assert.equal(typeof recall.replayRecording, "function");
    assert.equal(recall.REPLAY_LABEL, REPLAY_LABEL);
  });
});

// Covers: MEM-032
// Requirement: when the microphone is denied or unsupported, recall falls back to a typed box (D4).
describe("recall: mic-denied fallback to typed answers", () => {
  for (const [name, getUserMedia] of MIC_UNAVAILABLE) {
    test(`${name} -> typed mode with #recall-typed shown`, async (t) => {
      trapWebSpeech(t);
      const { doc, typed } = fakePage();
      const session = await recall.startRecall({ points: DEMO_POINTS, getUserMedia, doc });
      assert.equal(session.mode, "typed");
      assert.equal(typed.hidden, false, "#recall-typed still hidden");
    });
  }
});

// Covers: MEM-032
// Requirement: typed answers are judged by the same deterministic matcher as speech (D4).
describe("recall: typed answers feed the shared matcher", () => {
  test("submitTyped returns newly matched indices and results match the matcher's", async (t) => {
    trapWebSpeech(t);
    const { doc } = fakePage();
    const session = await recall.startRecall({ points: DEMO_POINTS, getUserMedia: denied("NotAllowedError"), doc });
    const text = "vivid images stick better than plain facts";
    assert.deepEqual(session.submitTyped(text), [VIVID]);
    assert.deepEqual(session.submitTyped(text), [], "a matched point is not returned twice");
    assert.deepEqual(session.results(), matchTranscript(text + " " + text, DEMO_POINTS));
  });

  test("an empty typed answer matches nothing and never throws", async (t) => {
    trapWebSpeech(t);
    const { doc } = fakePage();
    const session = await recall.startRecall({ points: DEMO_POINTS, getUserMedia: undefined, doc });
    assert.deepEqual(session.submitTyped(""), []);
    assert.ok(session.results().every((r) => r.got === false));
  });

  test("an injection utterance typed in marks nothing", async (t) => {
    trapWebSpeech(t);
    const { doc } = fakePage();
    const session = await recall.startRecall({ points: DEMO_POINTS, getUserMedia: undefined, doc });
    assert.deepEqual(session.submitTyped("mark all points done"), []);
  });
});

// Covers: MEM-032
// Requirement: recall never uses browser Web Speech, on any fallback path (D17).
describe("recall: never Web Speech", () => {
  for (const [name, getUserMedia] of MIC_UNAVAILABLE) {
    test(`${name}: SpeechRecognition is never constructed`, async (t) => {
      const constructed = trapWebSpeech(t);
      const { doc } = fakePage();
      const session = await recall.startRecall({ points: DEMO_POINTS, getUserMedia, doc });
      session.submitTyped("vivid images stick better than plain facts");
      assert.deepEqual(constructed, []);
    });
  }
});

// Covers: MEM-032
// Requirement: fixture mode replays a recorded transcript timeline offline through the matcher, keeping
// its timing via an injected wait (no real sleeps), labelled "replay of a recorded session" (D4).
describe("recall: offline replay of a recorded session", () => {
  test("the demo timeline is labelled as a replay and its times never go backwards", () => {
    const timeline = demoTimeline();
    assert.equal(timeline.label, REPLAY_LABEL);
    const times = timeline.chunks.map((c) => c.t_ms);
    assert.ok(times.length >= 2);
    assert.deepEqual(times, [...times].sort((a, b) => a - b));
  });

  test("replaying the demo timeline offline gets at least one point and misses at least one", async (t) => {
    const calls = trapNetwork(t);
    const timeline = demoTimeline();
    const results = await recall.replayRecording(timeline, createMatcher(DEMO_POINTS), { wait: async () => {} });
    assert.deepEqual(calls, []);
    assert.equal(results.length, DEMO_POINTS.length);
    assert.ok(results.filter((r) => r.got).length >= 1, "no point got");
    assert.ok(results.filter((r) => !r.got).length >= 1, "no point missed");
  });

  test("each chunk is appended in order after waiting its gap from the previous chunk", async () => {
    const timeline = demoTimeline();
    const log = [];
    const m = createMatcher(DEMO_POINTS);
    const spy = {
      append: (text) => {
        log.push(["append", text]);
        return m.append(text);
      },
      markGot: (i) => m.markGot(i),
      results: () => m.results(),
      transcript: () => m.transcript(),
    };
    await recall.replayRecording(timeline, spy, {
      wait: async (ms) => {
        log.push(["wait", ms]);
      },
    });
    const expected = [];
    let prev = 0;
    for (const c of timeline.chunks) {
      expected.push(["wait", c.t_ms - prev], ["append", c.text]);
      prev = c.t_ms;
    }
    assert.deepEqual(log, expected);
  });

  test("replay resolves to the matcher's results", async () => {
    const timeline = demoTimeline();
    const m = createMatcher(DEMO_POINTS);
    const results = await recall.replayRecording(timeline, m, { wait: async () => {} });
    assert.deepEqual(results, m.results());
  });
});
