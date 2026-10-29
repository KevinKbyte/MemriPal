// Covers: MEM-032
// Requirement: on a fixture-mode (demo) server the speech relay always answers 409 "live_only", so
// asking for the microphone there only costs the user a permission prompt that can never pay off.
// When /healthz reports mode "fixture", Start recall goes straight to typed recall: the typed box is
// shown and getUserMedia is never called; a typed answer then ends and saves the run as usual. On a
// live ("meta") server Start still asks for the microphone, on that click only.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { boot, click, el, loadDemo, settle, stored, TURNS, until, visibleText, watchRejections } from "./ux_flow_harness_test.mjs";

const FIXTURE = { status: "ok", mode: "fixture" };
const LIVE = { status: "ok", mode: "meta" };

/** Boot, wait for the health line to report `mode`, then Load demo. */
async function ready(health) {
  const b = boot({ health });
  await until(() => visibleText(el(b, "status")).includes(`${health.mode} mode`), "health line shows the mode", TURNS);
  await loadDemo(b);
  return b;
}

// Covers: MEM-032
// Requirement: in fixture/demo mode Start recall opens typed recall without touching the mic (UX F10).
describe("Start recall on a fixture-mode server", () => {
  test("no getUserMedia call; the typed box is shown", async (t) => {
    const rejections = watchRejections(t);
    const b = await ready(FIXTURE);
    click(b, "recall-start");
    await settle(50);
    assert.equal(b.mic.calls(), 0, "fixture mode must not ask for the microphone");
    assert.equal(el(b, "recall-typed").hidden, false, "typed box shown straight away");
    assert.deepEqual(rejections, []);
  });

  test("a typed answer then ends and saves the run, still with no mic request", async () => {
    const b = await ready(FIXTURE);
    click(b, "recall-start");
    await until(() => !el(b, "recall-typed").hidden, "typed box shown", TURNS);
    el(b, "recall-typed").value = "students can use it for exams";
    click(b, "recall-submit");
    await until(() => stored(b) === 1, "typed run saved", TURNS);
    assert.equal(b.mic.calls(), 0, "no mic request at any point");
  });
});

// Covers: MEM-032
// Requirement: a live server keeps the spoken path: Start asks for the mic once (UX F10 control).
describe("Start recall on a live (meta) server", () => {
  test("asks for the microphone once", async () => {
    const b = await ready(LIVE);
    click(b, "recall-start");
    await until(() => b.mic.calls() === 1, "mic asked on Start", TURNS);
    await settle(30);
    assert.equal(b.mic.calls(), 1);
  });
});
