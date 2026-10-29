// Covers: MEM-032, MEM-033
// Requirement: a second click on the recorded-session replay while the first replay is still running
// is a no-op: the run is replayed and saved once, so the history gains one row, not two. Once the
// first replay has finished, the replay button works again and saves a second run.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { boot, click, deferred, historyRows, jsonResponse, loadDemo, POINTS, saidRows, settle, stored, TIMELINE, TURNS, until, watchRejections } from "./ux_flow_harness_test.mjs";

/** Boot with every /demo/recall.json answer held until gate.resolve(); a fresh Response per call. */
function bootHeld() {
  const gate = deferred();
  const b = boot({ recall: () => gate.promise.then(() => jsonResponse(TIMELINE)) });
  return { b, gate };
}

// Covers: MEM-032, MEM-033
// Requirement: double-clicking the replay button saves the recorded session once (UX F3).
describe("Replay clicked twice while the first replay is pending", () => {
  test("one saved run and one history row", async (t) => {
    const rejections = watchRejections(t);
    const { b, gate } = bootHeld();
    await loadDemo(b);
    click(b, "recall-replay");
    await settle(10);
    click(b, "recall-replay");
    await settle(10);
    gate.resolve();
    await until(() => saidRows(b) === POINTS.length, "replay end screen shown", TURNS);
    await until(() => historyRows(b) >= 1, "history row shown", TURNS);
    await settle(200);
    assert.equal(stored(b), 1, "a second replay click while the first is pending must not save a second run");
    assert.equal(historyRows(b), 1, "one history row for one replay");
    assert.deepEqual(rejections, []);
  });

  test("a replay started after the first one finished saves a second run", async (t) => {
    const rejections = watchRejections(t);
    const { b, gate } = bootHeld();
    gate.resolve();
    await loadDemo(b);
    click(b, "recall-replay");
    await until(() => stored(b) === 1, "first replay saved", TURNS);
    await until(() => historyRows(b) === 1, "first history row", TURNS);
    await settle(30);
    click(b, "recall-replay");
    await until(() => stored(b) === 2, "second replay saved", TURNS);
    await until(() => historyRows(b) === 2, "second history row", TURNS);
    assert.deepEqual(rejections, []);
  });
});
