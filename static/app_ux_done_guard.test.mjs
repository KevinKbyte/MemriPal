// Covers: MEM-032, MEM-033
// Requirement: Done (#recall-submit) only acts on an open recall run. Chosen expectation: with no
// run open (after Load demo but before Start recall, and again once a run has ended and been saved)
// Done is disabled, so it never looks clickable while doing nothing; Start recall enables it. A typed
// Done with nothing typed (empty or whitespace-only) saves no rehearsal and shows no 0/N result:
// the page shows a visible prompt instead, the run stays open (typed box shown, Done enabled), and a
// real answer typed afterwards ends and saves the run as usual.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { boot, click, el, historyRows, loadDemo, POINTS, saidRows, settle, stored, TURNS, until, visibleText, watchRejections } from "./ux_flow_harness_test.mjs";

const ANSWER = "students can use it for exams";

/** Everything the user can currently read on the page. */
const pageText = (b) => Object.values(b.p.els).filter((e) => !e.hidden).map(visibleText).join("\n");

/** Load demo, then Start recall with the mic denied, so the run is typed. */
async function typedRun() {
  const b = boot({ mic: { deny: true } });
  await loadDemo(b);
  click(b, "recall-start");
  await until(() => !el(b, "recall-typed").hidden, "typed box shown", TURNS);
  return b;
}

// Covers: MEM-032
// Requirement: Done is disabled whenever no recall run is open (UX F11).
describe("Done without an open recall run", () => {
  test("disabled before Start recall, enabled once a run starts", async (t) => {
    const rejections = watchRejections(t);
    const b = boot({ mic: { deny: true } });
    await loadDemo(b);
    assert.equal(el(b, "recall-submit").disabled, true, "Done is disabled before Start recall");
    click(b, "recall-start");
    await until(() => !el(b, "recall-typed").hidden, "typed box shown", TURNS);
    assert.equal(el(b, "recall-submit").disabled, false, "Done is enabled while a run is open");
    assert.deepEqual(rejections, []);
  });

  test("disabled again once the run has ended and been saved", async () => {
    const b = await typedRun();
    el(b, "recall-typed").value = ANSWER;
    click(b, "recall-submit");
    await until(() => stored(b) === 1, "typed run saved", TURNS);
    await settle(30);
    assert.equal(el(b, "recall-submit").disabled, true, "Done is disabled after the run ended");
  });
});

// Covers: MEM-033
// Requirement: an empty typed Done saves no 0/N rehearsal and keeps the run open (UX F11).
describe("Done with nothing typed", () => {
  for (const [name, typed] of [["empty", ""], ["whitespace-only", "   \n\t "]]) {
    test(`${name}: nothing saved, a visible prompt, the run stays open`, async (t) => {
      const rejections = watchRejections(t);
      const b = await typedRun();
      const before = pageText(b);
      el(b, "recall-typed").value = typed;
      click(b, "recall-submit");
      await settle(100);
      assert.equal(stored(b), 0, "an empty Done must not save a rehearsal");
      assert.equal(historyRows(b), 0, "no 0/N history row");
      assert.equal(saidRows(b), 0, "no 0/N said-vs-palace end screen");
      assert.notEqual(pageText(b), before, "the page shows something in answer to the click");
      assert.equal(el(b, "recall-typed").hidden, false, "typed box still shown");
      assert.equal(el(b, "recall-submit").disabled, false, "Done still enabled");

      el(b, "recall-typed").value = ANSWER;
      click(b, "recall-submit");
      await until(() => stored(b) === 1, "a real answer afterwards saves the run", TURNS);
      await until(() => saidRows(b) === POINTS.length, "end screen shown", TURNS);
      assert.deepEqual(rejections, []);
    });
  }
});
