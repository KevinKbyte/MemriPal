// Covers: MEM-030, MEM-081
// Requirement: in the route review (#route), moving a place with ArrowUp or ArrowDown on its grip
// keeps keyboard focus on that same place's grip at its new position, so a keyboard user can press
// the key again to keep moving the place; focus is never left on a removed or stale grip (MEM-081
// replaced the Up/Down buttons of MEM-030 with a drag grip that takes the arrow keys).
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { boot, click, el, find, findAll, TURNS, until, watchRejections } from "./ux_flow_harness_test.mjs";

const hasClass = (n, c) =>
  Boolean(n && typeof n === "object") &&
  (n.classList.contains(c) || String(n.className ?? "").split(/\s+/).includes(c));
const rows = (b) => findAll(el(b, "route"), (n) => n.tagName === "LI");
const labelOf = (li) => find(li, (n) => hasClass(n, "route-label"))?.textContent ?? "";
const order = (b) => rows(b).map(labelOf);
const rowOf = (b, label) => rows(b).find((li) => labelOf(li) === label);
const grip = (li) => (li ? find(li, (n) => n.tagName === "BUTTON" && n.dataset.action === "drag") : null);
const press = (b, node, key) => b.p.fire(node, "keydown", { key, code: key, preventDefault() {} });
const inRoute = (b, node) => {
  for (let n = node; n; n = n.parent) if (n === el(b, "route")) return true;
  return false;
};

async function review() {
  const b = boot();
  click(b, "load-demo");
  await until(() => !el(b, "route-review").hidden && rows(b).length > 0, "route review shown", TURNS);
  return b;
}

// Covers: MEM-030, MEM-081
// Requirement: reordering a place from the keyboard keeps focus on its moved grip (UX F12).
describe("route review keeps keyboard focus on the moved place's grip (MEM-081)", () => {
  for (const [key, from, to, step] of [["ArrowUp", 2, 1, -1], ["ArrowDown", 1, 2, 1]]) {
    test(`${key}: focus follows the place to slot ${to} on its grip`, async (t) => {
      const rejections = watchRejections(t);
      const b = await review();
      const label = labelOf(rows(b)[from]);
      const g = grip(rows(b)[from]);
      assert.ok(g, `row ${from} ("${label}") has a grip button with data-action drag`);
      g.focus();
      press(b, g, key);
      await until(() => order(b)[to] === label, `"${label}" moved to slot ${to}`, TURNS);
      const moved = grip(rowOf(b, label));
      assert.ok(moved, `"${label}" still has a grip after the move`);
      assert.ok(b.p.doc.activeElement === moved && inRoute(b, moved), `focus is on the grip of "${label}" in #route`);

      // The user can keep pressing the key on the focused grip.
      press(b, b.p.doc.activeElement, key);
      await until(() => order(b)[to + step] === label, "a second press moves the same place again", TURNS);
      assert.ok(b.p.doc.activeElement === grip(rowOf(b, label)), `focus is still on the grip of "${label}"`);
      assert.deepEqual(rejections, []);
    });
  }
});
