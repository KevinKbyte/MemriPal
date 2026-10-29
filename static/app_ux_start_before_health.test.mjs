// Covers: MEM-032
// Requirement: Start recall picks typed or spoken by the server's mode (UX F10), so it must not
// decide before /healthz has answered. A Start clicked while /healthz is still pending asks for no
// microphone yet; once /healthz answers mode "fixture" the run opens typed (typed box shown) and
// getUserMedia is never called, and a typed answer then saves the run. If /healthz answers mode
// "meta" instead, that same click goes on to ask for the microphone exactly once.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  boot, click, deferred, el, jsonResponse, loadDemo, settle, stored, TURNS, until, watchRejections,
} from "./ux_flow_harness_test.mjs";

/** Boot with GET /healthz held pending, Load demo, then click Start while it is still pending. */
async function startBeforeHealth() {
  const health = deferred();
  const b = boot({ healthReply: () => health.promise });
  await loadDemo(b);
  click(b, "recall-start");
  await settle(50);
  return { b, answer: (mode) => health.resolve(jsonResponse({ status: "ok", mode })) };
}

// Covers: MEM-032
// Requirement: a Start racing a slow /healthz never takes the mic path on a demo server (UX 102b).
describe("Start recall clicked before /healthz answers", () => {
  test("fixture mode: no getUserMedia before or after the answer; typed box shown", async (t) => {
    const rejections = watchRejections(t);
    const { b, answer } = await startBeforeHealth();
    assert.equal(b.mic.calls(), 0, "Start must not ask for the mic while /healthz is still pending");
    answer("fixture");
    await until(() => !el(b, "recall-typed").hidden, "typed box shown once /healthz says fixture", TURNS);
    await settle(30);
    assert.equal(b.mic.calls(), 0, "a fixture-mode run never asks for the microphone");
    assert.deepEqual(rejections, []);
  });

  test("fixture mode: a typed answer then ends and saves the run, still with no mic request", async () => {
    const { b, answer } = await startBeforeHealth();
    answer("fixture");
    await until(() => !el(b, "recall-typed").hidden, "typed box shown", TURNS);
    el(b, "recall-typed").value = "students can use it for exams";
    click(b, "recall-submit");
    await until(() => stored(b) === 1, "typed run saved", TURNS);
    assert.equal(b.mic.calls(), 0, "no mic request at any point");
  });

  test("meta mode: the same click asks for the microphone once, after /healthz answers", async () => {
    const { b, answer } = await startBeforeHealth();
    assert.equal(b.mic.calls(), 0, "no mic request while /healthz is still pending");
    answer("meta");
    await until(() => b.mic.calls() === 1, "mic asked once /healthz says meta", TURNS);
    await settle(30);
    assert.equal(b.mic.calls(), 1);
  });
});
