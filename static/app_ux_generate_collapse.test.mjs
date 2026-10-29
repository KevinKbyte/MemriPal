// Covers: MEM-030
// Requirement: once generation completes (Generate clicked after route review, or the Auto run), the
// walk is not buried under the page: the association cards (#associations) and the scene panel
// (#scenes) are collapsed, so none of their per-point content is visible (their content is kept, not
// deleted; a collapse toggle inside them may stay visible), the walk view (#walk) is shown, and the
// page scrolls the walk or recall section into view. MEM-030 only says "walk view at step 1"; it
// does not require the cards to stay expanded, so this does not contradict the spec.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { boot, click, el, loadDemo, POINTS, settle, TURNS, until, visibleText, watchRejections } from "./ux_flow_harness_test.mjs";

/** Records scrollIntoView calls on the walk and recall sections (the fake page has no layout). */
function spyScroll(b) {
  const scrolled = [];
  for (const id of ["walk", "recall"]) el(b, id).scrollIntoView = () => scrolled.push(id);
  return scrolled;
}

/** Point labels the user can still read inside page element `id`. */
const visibleLabels = (b, id) => {
  const text = visibleText(el(b, id));
  return POINTS.map((p) => p.label).filter((label) => text.includes(label));
};

function assertCollapsedAndScrolled(b, scrolled) {
  for (const id of ["associations", "scenes"]) {
    assert.ok(POINTS.some((p) => el(b, id).textContent.includes(p.label)), `#${id} still holds its cards (collapsed, not deleted)`);
    assert.deepEqual(visibleLabels(b, id), [], `#${id} is collapsed after Generate: no per-point card visible`);
  }
  assert.equal(el(b, "walk").hidden, false, "the walk view is shown");
  assert.ok(scrolled.length > 0, "the walk (or recall) section is scrolled into view after Generate");
}

// Covers: MEM-030
// Requirement: after Generate, associations and scenes collapse and the walk scrolls into view (UX F7).
describe("after Generate the walk is not buried", () => {
  test("route review -> Generate: cards collapsed, walk scrolled into view", async (t) => {
    const rejections = watchRejections(t);
    const b = boot();
    const scrolled = spyScroll(b);
    click(b, "load-demo");
    await until(() => !el(b, "route-review").hidden, "route review shown", TURNS);
    assert.deepEqual(scrolled, [], "nothing scrolls before Generate");
    click(b, "generate");
    await until(() => !el(b, "recall").hidden, "recall panel shown", TURNS);
    await settle(50);
    assertCollapsedAndScrolled(b, scrolled);
    assert.deepEqual(rejections, []);
  });

  test("Auto run (no review): cards collapsed, walk scrolled into view", async (t) => {
    const rejections = watchRejections(t);
    const b = boot();
    const scrolled = spyScroll(b);
    await loadDemo(b);
    await settle(50);
    assertCollapsedAndScrolled(b, scrolled);
    assert.deepEqual(rejections, []);
  });
});
