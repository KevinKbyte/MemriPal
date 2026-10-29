// Covers: MEM-033
// Requirement: two "Mark got it" clicks on different missed rows can overlap (the second click lands
// while the first write is still pending). When the first write then fails and the second succeeds,
// the end screen and the stored record must agree on every point: a row shows "marked got it"
// exactly when the stored point is got, the second point is got in both, the history still matches
// what is stored, and no unhandled rejection escapes.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  boot, click, deferred, el, find, findAll, kvAdapter, loadDemo, POINTS, saidRows, settle, stored, TURNS,
  until, visibleText, watchRejections,
} from "./ux_flow_harness_test.mjs";

const ANSWER = "students can use it for exams";

/** In-memory rehearsal adapter; once `hold` is set each put waits until the test settles it. */
function heldAdapter() {
  const a = kvAdapter();
  const put = a.put;
  a.hold = false;
  a.pending = [];
  a.put = async (k, v) => {
    if (!a.hold) return put(k, v);
    const d = deferred();
    a.pending.push(d);
    await d.promise;
    return put(k, v);
  };
  return a;
}

const isRow = (n) => n.tagName === "LI" && /^said-/.test(String(n.className));
const endRows = (b) => findAll(el(b, "recall-results"), isRow, { visibleOnly: true });
const rowLabel = (li) => find(li, (n) => n.className === "said-label").textContent;
const markButton = (li) => find(li, (n) => n.tagName === "BUTTON" && n.dataset.action === "mark-got");
const rowFor = (b, label) => endRows(b).find((li) => rowLabel(li) === label);
const storedRecord = (b) => JSON.parse([...b.rehAdapter.map.values()][0]);

// Covers: MEM-033
// Requirement: overlapping mark-got writes never leave the screen and the store disagreeing (UX 102d).
describe("two overlapping Mark got it clicks, the first write fails", () => {
  test("end screen, history and stored record agree on every point", async (t) => {
    const rejections = watchRejections(t);
    const rehAdapter = heldAdapter();
    const b = boot({ mic: { deny: true }, rehAdapter });
    await loadDemo(b);
    click(b, "recall-start");
    await until(() => !el(b, "recall-typed").hidden, "typed box shown", TURNS);
    el(b, "recall-typed").value = ANSWER;
    click(b, "recall-submit");
    await until(() => stored(b) === 1 && saidRows(b) === POINTS.length, "run saved, end screen shown", TURNS);
    await settle(30);

    const [first, second] = endRows(b).filter((li) => markButton(li)).map(rowLabel);
    assert.ok(first && second, "two missed rows to mark");
    rehAdapter.hold = true;
    b.p.fire(markButton(rowFor(b, first)), "click");
    await until(() => rehAdapter.pending.length === 1, "first write pending", TURNS);
    b.p.fire(markButton(rowFor(b, second)), "click");
    await until(() => rehAdapter.pending.length === 2, "second write pending", TURNS);
    rehAdapter.pending[0].reject(new Error("write boom"));
    await settle(50);
    rehAdapter.pending[1].resolve();
    await settle(100);

    const record = storedRecord(b);
    for (const point of record.points) {
      const shown = visibleText(rowFor(b, point.label)).includes("marked got it");
      const marked = point.got === true && point.override === true;
      const say = (v) => (v ? "got" : "missed");
      assert.equal(shown, marked, `"${point.label}": screen says ${say(shown)}, store says ${say(marked)}`);
    }
    const secondPoint = record.points.find((p) => p.label === second);
    assert.equal(secondPoint.got, true, "the second (successful) mark is stored");
    assert.ok(visibleText(rowFor(b, second)).includes("marked got it"), "the second mark shows as got");
    const got = record.points.filter((p) => p.got).length;
    const history = visibleText(el(b, "rehearsals"));
    assert.ok(history.includes(`${got}/${POINTS.length} recalled`), `history matches the store: ${history}`);
    assert.deepEqual(rejections, []);
  });
});
