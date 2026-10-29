// Covers: MEM-032, MEM-037
// Requirement: when the browser fails to close the recording's audio context (AudioContext.close()
// rejects), a spoken run is not lost and nothing fails silently: Done falls back to the typed box with
// "type what you remember instead", the mic is released, no unhandled rejection escapes, and a typed
// answer then ends and saves the run. A live relay failure (429) with a failing close falls back to
// typed the same way, with no unhandled rejection.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { boot, click, el, jsonResponse, liveBoardRows, loadDemo, pageMentions, POINTS, saidRows, settle, stored, TURNS, until, watchRejections } from "./ux_flow_harness_test.mjs";

const TYPE_INSTEAD = "type what you remember instead";
const SAMPLES = [0, 0.5, -0.5, 0.25, -0.25, 1, -1];

/** Load the demo palace, Start, and wait for the LIVE board. */
async function startLive(b) {
  await loadDemo(b);
  click(b, "recall-start");
  await until(() => b.audio.state.processors.length >= 1, "recording started", TURNS);
  await until(() => liveBoardRows(b) === POINTS.length, "live board shown", TURNS);
}

// Covers: MEM-032, MEM-037
// Requirement: a failing AudioContext.close() never strands a spoken run (UX F4).
describe("AudioContext.close() rejects during a spoken run", () => {
  test("Done falls back to typed with no unhandled rejection; a typed answer then saves the run", async (t) => {
    const rejections = watchRejections(t);
    const b = boot({ closeRejects: true });
    await startLive(b);
    b.audio.emit(SAMPLES);
    click(b, "recall-submit");
    await settle(100);
    assert.equal(el(b, "recall-typed").hidden, false, "Done with a failing close shows the typed box");
    assert.ok(pageMentions(b, TYPE_INSTEAD), `a visible "${TYPE_INSTEAD}" message`);
    assert.deepEqual(rejections, [], "no unhandled rejection from the failing close");
    assert.equal(stored(b), 0, "nothing saved before the typed answer");

    el(b, "recall-typed").value = "spatial memory is strong and engage every sense";
    click(b, "recall-submit");
    await until(() => saidRows(b) === POINTS.length, "typed answer ends the run", TURNS);
    await until(() => stored(b) === 1, "typed run saved", TURNS);
    await settle(30);
    assert.equal(stored(b), 1, "one run saved");
    assert.equal(b.mic.liveTracks(), 0, "no mic track left live");
    assert.deepEqual(rejections, []);
  });

  test("a 429 on the first relay slice falls back to typed with no unhandled rejection", async (t) => {
    const rejections = watchRejections(t);
    const b = boot({ closeRejects: true, replies: [() => jsonResponse({ error: "budget_exhausted" }, 429)] });
    await startLive(b);
    b.audio.emit(SAMPLES);
    b.timers.fire();
    await until(() => b.server.posts("/recall/audio").length === 1, "first slice relayed", TURNS);
    await until(() => !el(b, "recall-typed").hidden, "typed box shown after the relay failed", TURNS);
    await settle(100);
    assert.ok(pageMentions(b, "Speech relay failed (budget_exhausted)"), "the relay failure is shown");
    assert.equal(b.mic.liveTracks(), 0, "no mic track left live");
    assert.equal(stored(b), 0, "a failed relay saves no rehearsal");
    assert.deepEqual(rejections, [], "no unhandled rejection from the failing close in the typed fallback");
  });
});
