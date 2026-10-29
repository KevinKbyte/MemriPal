// Covers: MEM-030
// Requirement: in the route review (#route), moving a place with its Up or Down button keeps keyboard
// focus on that same place's same button at its new position, so a keyboard user can press it again
// to keep moving the place; focus is never left on a removed button. Chosen scope: moves that leave
// the button enabled (not into the first/last slot, where that button becomes disabled).
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { boot, click, el, find, findAll, TURNS, until, watchRejections } from "./ux_flow_harness_test.mjs";

/** Track focus like a browser: focus() makes the element doc.activeElement, blur() clears it. */
function trackFocus(b) {
  const doc = b.p.doc;
  doc.activeElement = null;
  const make = doc.createElement;
  doc.createElement = (tag) => {
    const e = make(tag);
    e.focus = () => void (doc.activeElement = e);
    e.blur = () => void (doc.activeElement === e && (doc.activeElement = null));
    return e;
  };
}

const rows = (b) => findAll(el(b, "route"), (n) => n.tagName === "LI");
const labelOf = (li) => li.children.find((c) => typeof c === "object" && c.tagName === "SPAN").textContent;
const rowOf = (b, label) => rows(b).find((li) => labelOf(li) === label);
const control = (li, action) => find(li, (n) => n.tagName === "BUTTON" && n.dataset.action === action);
const inRoute = (b, node) => {
  for (let n = node; n; n = n.parent) if (n === el(b, "route")) return true;
  return false;
};

async function review() {
  const b = boot();
  trackFocus(b);
  click(b, "load-demo");
  await until(() => !el(b, "route-review").hidden && rows(b).length > 0, "route review shown", TURNS);
  return b;
}

// Covers: MEM-030
// Requirement: reordering a place keeps focus on its moved control (UX F12).
describe("route review keeps keyboard focus on the moved place", () => {
  for (const [action, from, to] of [["up", 2, 1], ["down", 1, 2]]) {
    test(`${action}: focus follows the place to slot ${to} on its ${action} button`, async (t) => {
      const rejections = watchRejections(t);
      const b = await review();
      const label = labelOf(rows(b)[from]);
      const button = control(rows(b)[from], action);
      button.focus();
      b.p.fire(button, "click");
      assert.equal(labelOf(rows(b)[to]), label, `the place moved to slot ${to}`);
      const moved = control(rowOf(b, label), action);
      assert.equal(moved.disabled, false, `the moved place's ${action} button is still enabled`);
      assert.ok(b.p.doc.activeElement === moved && inRoute(b, moved), `focus is on the ${action} button of "${label}" in #route`);

      // The user can keep pressing the focused button.
      b.p.fire(b.p.doc.activeElement, "click");
      assert.equal(labelOf(rows(b)[to + (action === "up" ? -1 : 1)]), label, "a second press moves the same place again");
      assert.deepEqual(rejections, []);
    });
  }
});
