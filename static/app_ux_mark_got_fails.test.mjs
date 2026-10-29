// Covers: MEM-033
// Requirement: when a run was saved but rewriting it for "Mark got it" fails (the rehearsal store
// rejects the write), the page does not claim the override took: the end screen row keeps showing the
// point as missed (no "marked got it"), the history still matches what is stored, the stored record is
// unchanged, a visible message says the change was not saved (text matching
// /could not|couldn't|failed|not saved/i), and no unhandled rejection escapes.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { boot, click, el, find, findAll, kvAdapter, loadDemo, POINTS, saidRows, settle, stored, TURNS, until, visibleText, watchRejections } from "./ux_flow_harness_test.mjs";

const ANSWER = "students can use it for exams";
const ERROR = /could not|couldn't|failed|not saved/i;

/** Lines (one per page element) a user can read. */
const pageLines = (b) => Object.values(b.p.els).filter((e) => !e.hidden).map(visibleText);

/** In-memory rehearsal adapter whose writes reject once failPuts is set. */
function flakyAdapter() {
  const a = kvAdapter();
  const put = a.put;
  a.failPuts = false;
  a.put = async (k, v) => {
    if (a.failPuts) throw new Error("write boom");
    return put(k, v);
  };
  return a;
}

const endRows = (b) => findAll(el(b, "recall-results"), (n) => n.tagName === "LI" && /^said-/.test(String(n.className)), { visibleOnly: true });
const rowLabel = (li) => find(li, (n) => n.className === "said-label").textContent;
const markButton = (li) => find(li, (n) => n.tagName === "BUTTON" && n.dataset.action === "mark-got");

// Covers: MEM-033
// Requirement: a failed "Mark got it" write is reported, never shown as a success (UX R-mark-got).
describe("Mark got it when the store write fails after a good save", () => {
  test("row stays missed, history and store unchanged, a visible error, no unhandled rejection", async (t) => {
    const rejections = watchRejections(t);
    const rehAdapter = flakyAdapter();
    const b = boot({ mic: { deny: true }, rehAdapter });
    await loadDemo(b);
    click(b, "recall-start");
    await until(() => !el(b, "recall-typed").hidden, "typed box shown", TURNS);
    el(b, "recall-typed").value = ANSWER;
    click(b, "recall-submit");
    await until(() => stored(b) === 1 && saidRows(b) === POINTS.length, "run saved, end screen shown", TURNS);
    await settle(30);
    const storedBefore = [...rehAdapter.map.values()][0];
    const historyBefore = visibleText(el(b, "rehearsals"));
    const before = new Set(pageLines(b));

    const row = endRows(b).find((li) => markButton(li));
    const label = rowLabel(row);
    rehAdapter.failPuts = true;
    b.p.fire(markButton(row), "click");
    await settle(100);

    const after = endRows(b).find((li) => rowLabel(li) === label);
    assert.ok(!visibleText(after).includes("marked got it"), `the end screen must not claim "${label}" was marked got it`);
    assert.equal(visibleText(el(b, "rehearsals")), historyBefore, "history still shows the stored run");
    assert.equal([...rehAdapter.map.values()][0], storedBefore, "stored record unchanged");
    const fresh = pageLines(b).filter((line) => !before.has(line));
    assert.ok(fresh.some((line) => ERROR.test(line)), `a visible message reports the failed save (new page text: ${JSON.stringify(fresh)})`);
    assert.deepEqual(rejections, []);
  });
});
