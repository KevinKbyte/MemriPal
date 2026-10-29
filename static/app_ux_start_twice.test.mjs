// Covers: MEM-032, MEM-037
// Requirement: a second Start recall click while the first is still waiting for the microphone is a
// no-op: the mic is asked for once, one live run starts, and after Done no mic track and no relay
// timer is left running. Once the first Start has settled, Start asks for the mic again as usual.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { boot, click, el, liveBoardRows, loadDemo, POINTS, settle, stored, TURNS, until, watchRejections } from "./ux_flow_harness_test.mjs";

// Covers: MEM-032, MEM-037
// Requirement: double-clicking Start recall never opens a second microphone or relay (UX F1).
describe("Start recall clicked twice while the mic request is pending", () => {
  test("one getUserMedia; after Done no track and no relay timer is left live", async (t) => {
    const rejections = watchRejections(t);
    const b = boot({ mic: { hold: true } });
    await loadDemo(b);
    click(b, "recall-start");
    await until(() => b.mic.calls() === 1, "first Start asked for the mic", TURNS);
    click(b, "recall-start");
    await settle(30);
    b.mic.release();
    await until(() => liveBoardRows(b) === POINTS.length, "live board shown", TURNS);
    await settle(30);
    b.mic.release();
    await settle(30);
    assert.equal(b.mic.calls(), 1, "a second Start while the first is pending must not ask for the mic again");
    assert.equal(b.timers.active(), 1, "exactly one live relay runs");

    click(b, "recall-submit");
    await until(() => stored(b) === 1, "Done saved the run", TURNS);
    await settle(30);
    assert.equal(b.mic.liveTracks(), 0, "no mic track left live after Done");
    assert.equal(b.timers.active(), 0, "no relay timer left running after Done");
    assert.equal(stored(b), 1, "one run saved");
    assert.deepEqual(rejections, []);
  });

  test("after the first Start settled (mic denied -> typed), Start asks for the mic again", async (t) => {
    const rejections = watchRejections(t);
    const b = boot({ mic: { deny: true } });
    await loadDemo(b);
    click(b, "recall-start");
    await until(() => !el(b, "recall-typed").hidden, "typed fallback after a denied mic", TURNS);
    click(b, "recall-start");
    await until(() => b.mic.calls() === 2, "second Start asks for the mic again", TURNS);
    assert.deepEqual(rejections, []);
  });
});
