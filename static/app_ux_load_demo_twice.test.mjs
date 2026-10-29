// Covers: MEM-030
// Requirement: a second Load demo click while the first demo load is still running is a no-op: the
// Load demo control is disabled while a load is pending, so the palace gets one card and one /scenes
// POST per point (12, not 24). It is enabled again once the load ends, whether it succeeded or failed.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { boot, click, deferred, el, POINTS, settle, TURNS, until, watchRejections } from "./ux_flow_harness_test.mjs";

const PHOTO = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

/** Boot with every /demo/photo.jpg answer held until gate.resolve(). */
function bootHeld(opts = {}) {
  const gate = deferred();
  const b = boot({ ...opts, photo: () => gate.promise.then(() => new Response(PHOTO, { headers: { "content-type": "image/jpeg" } })) });
  el(b, "auto").checked = true;
  return { b, gate };
}

const cards = (b) => el(b, "associations").children.filter((c) => typeof c === "object" && c.tagName === "SECTION").length;
const scenePosts = (b) => b.server.posts("/scenes").length;

// Covers: MEM-030
// Requirement: double-clicking Load demo builds the demo palace once (UX F2).
describe("Load demo clicked twice while the first load is pending", () => {
  test("12 cards and 12 /scenes POSTs, one /loci and one /split", async (t) => {
    const rejections = watchRejections(t);
    const { b, gate } = bootHeld();
    click(b, "load-demo");
    await settle(10);
    click(b, "load-demo");
    await settle(10);
    gate.resolve();
    await until(() => !el(b, "recall").hidden, "recall panel shown", TURNS);
    await until(() => scenePosts(b) >= POINTS.length, "scenes requested", TURNS);
    await settle(200);
    assert.equal(cards(b), POINTS.length, "one association card per point");
    assert.equal(scenePosts(b), POINTS.length, "one /scenes POST per point");
    assert.equal(b.server.posts("/loci").length, 1, "one /loci POST");
    assert.equal(b.server.posts("/split").length, 1, "one /split POST");
    assert.deepEqual(rejections, []);
  });

  test("Load demo is disabled while pending and enabled again after a successful load", async () => {
    const { b, gate } = bootHeld();
    click(b, "load-demo");
    await settle(10);
    assert.equal(el(b, "load-demo").disabled, true, "Load demo disabled while the demo load is pending");
    gate.resolve();
    await until(() => !el(b, "recall").hidden, "recall panel shown", TURNS);
    await until(() => !el(b, "load-demo").disabled, "Load demo enabled again after the load", TURNS);
  });

  test("Load demo is enabled again after a failed load, so the user can retry", async () => {
    const { b, gate } = bootHeld({ split: () => new Response("down", { status: 500 }) });
    click(b, "load-demo");
    await settle(10);
    assert.equal(el(b, "load-demo").disabled, true, "Load demo disabled while the demo load is pending");
    gate.resolve();
    await until(() => el(b, "upload-status").textContent.includes("Demo failed"), "failure shown", TURNS);
    await until(() => !el(b, "load-demo").disabled, "Load demo enabled again after a failed load", TURNS);
  });
});
