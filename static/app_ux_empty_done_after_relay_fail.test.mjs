// Covers: MEM-032, MEM-033
// Requirement: when the speech relay fails, the run goes on typed with "Speech relay failed (<code>)"
// on the page (MEM-032). A Done pressed then with nothing typed and no point got must add its prompt
// without wiping that message: the relay failure stays visible, the page still answers the click with
// something new, nothing is saved, the run stays open (typed box shown, Done enabled), and a real answer
// typed afterwards ends and saves the run as usual. Holds whether the relay failed on a live slice or on
// the Done that ended the spoken part. Kev decision Q24(iii): if the spoken part already got a point
// before the relay failed, an empty Done ends the run and saves it with that point got.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  boot, click, el, findAll, jsonResponse, liveBoardRows, loadDemo, pageMentions, POINTS, saidRows, settle,
  stored, TURNS, until, visibleText, watchRejections,
} from "./ux_flow_harness_test.mjs";

const FAILED = "Speech relay failed (budget_exhausted)";
const SAMPLES = [0, 0.5, -0.5, 0.25, -0.25, 1, -1];
const ANSWER = "students can use it for exams";

/** Everything the user can currently read on the page. */
const pageText = (b) => Object.values(b.p.els).filter((e) => !e.hidden).map(visibleText).join("\n");

/** Spoken run whose first relay post answers 429; `fail(b)` triggers that post. */
async function failedSpokenRun(fail) {
  const b = boot({ replies: [() => jsonResponse({ error: "budget_exhausted" }, 429)] });
  await loadDemo(b);
  click(b, "recall-start");
  await until(() => liveBoardRows(b) === POINTS.length, "live board shown", TURNS);
  b.audio.emit(SAMPLES);
  fail(b);
  await until(() => b.server.posts("/recall/audio").length === 1, "relay post sent", TURNS);
  await until(() => !el(b, "recall-typed").hidden, "typed box shown after the relay failed", TURNS);
  await settle(50);
  assert.ok(pageMentions(b, FAILED), "precondition: the relay failure is shown");
  return b;
}

const FAILURES = [
  ["a live slice", (b) => b.timers.fire()],
  ["Done", (b) => click(b, "recall-submit")],
];

// Covers: MEM-032, MEM-033
// Requirement: the empty-Done prompt never overwrites a "Speech relay failed" message (UX 102c).
describe("empty typed Done after the speech relay failed", () => {
  for (const [name, fail] of FAILURES) {
    test(`relay failed on ${name}: the failure stays visible beside the prompt; run open`, async (t) => {
      const rejections = watchRejections(t);
      const b = await failedSpokenRun(fail);
      const before = pageText(b);
      el(b, "recall-typed").value = "  ";
      click(b, "recall-submit");
      await settle(100);
      assert.ok(pageMentions(b, FAILED), `"${FAILED}" must stay visible after an empty Done`);
      assert.notEqual(pageText(b), before, "the page shows something in answer to the empty Done");
      assert.equal(stored(b), 0, "an empty Done saves nothing");
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

const GOT_LABEL = "Students can use it for exams";
const isLit = (n) => n.tagName === "LI" && n.dataset?.state === "got";
const litRows = (b) => findAll(el(b, "recall-live"), isLit).length;

// Covers: MEM-032
// Requirement: Q24(iii) - a spoken run that fell back typed after a relay failure, with a point already
// got, is saved by an empty Done (only an empty Done with nothing got saves nothing).
describe("empty typed Done after the relay failed, with a point already got", () => {
  test("the run ends and is saved with the spoken point got", async (t) => {
    const rejections = watchRejections(t);
    const b = boot({
      replies: [() => jsonResponse({ text: ANSWER }), () => jsonResponse({ error: "budget_exhausted" }, 429)],
    });
    await loadDemo(b);
    click(b, "recall-start");
    await until(() => liveBoardRows(b) === POINTS.length, "live board shown", TURNS);
    b.audio.emit(SAMPLES);
    b.timers.fire();
    await until(() => litRows(b) === 1, "precondition: the first slice lit a point", TURNS);
    b.audio.emit(SAMPLES);
    b.timers.fire();
    await until(() => !el(b, "recall-typed").hidden, "typed box shown after the relay failed", TURNS);
    await settle(50);
    assert.ok(pageMentions(b, FAILED), "precondition: the relay failure is shown");
    assert.equal(stored(b), 0, "precondition: nothing saved yet");

    el(b, "recall-typed").value = "  ";
    click(b, "recall-submit");
    await settle(100);
    assert.equal(stored(b), 1, "an empty Done with a point got must save the rehearsal");
    const saved = JSON.parse([...b.rehAdapter.map.values()].find((v) => typeof v === "string"));
    const got = saved.points.filter((p) => p.got).map((p) => p.label);
    assert.deepEqual(got, [GOT_LABEL], "the spoken point is saved got");
    assert.equal(saidRows(b), POINTS.length, "end screen shown");
    assert.equal(el(b, "recall-submit").disabled, true, "Done disabled once the run ended");
    assert.deepEqual(rejections, []);
  });
});
