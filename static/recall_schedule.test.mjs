// Covers: MEM-090
// Requirement: a memorized item gets review times before its deadline (ADR 0049 schedule (a), countdown
// doubling). With start S = the injected clock's now and deadline T: anchors T-1d, T-2d, T-4d, T-8d ... kept
// while >= S+1d, plus S+10min and S+1h on day S. No deadline = S + 1, 3, 7, 14, 30, 60, 120 d. T within 1d of
// S = same-day S+10m / S+1h / S+4h. T already passed = no schedule ([]). The ADR's simulated values are
// reproduced exactly: S = 11-03 18:00, T = 11-21 -> 18:10, 19:00, 11-05, 11-13, 11-17, 11-19, 11-20;
// T = S+12h -> 18:10, 19:00, 22:00; passed -> [].
// Contract (RED; GREEN implements static/recall_schedule.js, pure, no Date.now / local-calendar reads):
//   recallSchedule(deadline, { now }) -> number[]
//     deadline: epoch ms, or null / undefined for "no deadline" (MemorizeItem.remember_by is optional).
//     now: () => number, the injected clock (epoch ms); S = now().
//     returns review times as epoch ms, strictly ascending.
// Timezone convention: every instant is epoch ms built with Date.UTC and read back with toISOString, so the
// test is independent of the process TZ; a "day" is a fixed 86_400_000 ms (no local-calendar arithmetic).
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { recallSchedule } from "./recall_schedule.js";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// S = 2026-11-03 18:00 (UTC instant).
const S = Date.UTC(2026, 10, 3, 18, 0);
const clockAt = (ms) => () => ms;
const iso = (times) => times.map((ms) => new Date(ms).toISOString());

function assertStrictlyAscendingNumbers(times) {
  for (const t of times) assert.equal(typeof t, "number");
  for (let i = 1; i < times.length; i += 1) assert.ok(times[i] > times[i - 1], `not ascending at ${i}`);
}

describe("recallSchedule reproduces ADR 0049's simulated schedules", () => {
  test("(1) S = 2026-11-03 18:00, T = 2026-11-21: countdown doubling with the S+1d floor", () => {
    const T = Date.UTC(2026, 10, 21, 0, 0);
    const out = recallSchedule(T, { now: clockAt(S) });
    assert.deepEqual(iso(out), [
      "2026-11-03T18:10:00.000Z",
      "2026-11-03T19:00:00.000Z",
      "2026-11-05T00:00:00.000Z",
      "2026-11-13T00:00:00.000Z",
      "2026-11-17T00:00:00.000Z",
      "2026-11-19T00:00:00.000Z",
      "2026-11-20T00:00:00.000Z",
    ]);
    assertStrictlyAscendingNumbers(out);
  });

  test("(2) no deadline (null): S + 1, 3, 7, 14, 30, 60, 120 days", () => {
    const out = recallSchedule(null, { now: clockAt(S) });
    assert.deepEqual(out, [1, 3, 7, 14, 30, 60, 120].map((d) => S + d * DAY));
    assertStrictlyAscendingNumbers(out);
  });

  test("(2b) no deadline (undefined, remember_by omitted) is the same as null", () => {
    assert.deepEqual(
      recallSchedule(undefined, { now: clockAt(S) }),
      recallSchedule(null, { now: clockAt(S) }),
    );
  });

  test("(3) T = S + 12 h: same-day S+10m, S+1h, S+4h only", () => {
    const out = recallSchedule(S + 12 * HOUR, { now: clockAt(S) });
    assert.deepEqual(iso(out), [
      "2026-11-03T18:10:00.000Z",
      "2026-11-03T19:00:00.000Z",
      "2026-11-03T22:00:00.000Z",
    ]);
  });

  test("(4) T already passed: no schedule", () => {
    assert.deepEqual(recallSchedule(S - DAY, { now: clockAt(S) }), []);
    assert.deepEqual(recallSchedule(S - 1, { now: clockAt(S) }), []);
  });
});

describe("recallSchedule reads time only from the injected clock", () => {
  test("shifting the clock and deadline by the same amount shifts every review by that amount", () => {
    const T = Date.UTC(2026, 10, 21, 0, 0);
    const base = recallSchedule(T, { now: clockAt(S) });
    for (const shift of [-400 * DAY, 37 * DAY + 5 * HOUR, 3650 * DAY]) {
      const moved = recallSchedule(T + shift, { now: clockAt(S + shift) });
      assert.deepEqual(moved, base.map((t) => t + shift), `shift ${shift}`);
    }
  });

  test("the same inputs give the same output on repeated calls", () => {
    const T = Date.UTC(2026, 10, 21, 0, 0);
    assert.deepEqual(recallSchedule(T, { now: clockAt(S) }), recallSchedule(T, { now: clockAt(S) }));
  });

  test("every review with a deadline falls after S and before T", () => {
    for (const T of [Date.UTC(2026, 10, 21, 0, 0), S + 12 * HOUR, S + 200 * DAY]) {
      const out = recallSchedule(T, { now: clockAt(S) });
      assert.ok(out.length > 0, `empty for T=${new Date(T).toISOString()}`);
      for (const t of out) assert.ok(t > S && t < T, `${new Date(t).toISOString()} outside (S, T)`);
    }
  });
});
