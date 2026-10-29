// Covers: MEM-033
// Requirement: when the user confirms Delete on a history row but the rehearsal store rejects the
// delete, nothing escapes as an unhandled rejection, the row is kept (the run is still stored and
// still listed), no "Undo delete" is offered for a delete that did not happen, and a visible message
// says the delete failed (text matching /could not|couldn't|failed|not deleted/i).
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { boot, el, find, historyRows, kvAdapter, POINTS, settle, visibleText, watchRejections } from "./ux_flow_harness_test.mjs";

const ERROR = /could not|couldn't|failed|not deleted/i;

const RUN = {
  id: "run-1",
  palace_id: "demo",
  timestamp: "2026-10-30T09:00:00.000Z",
  transcript: "students can use it for exams",
  points: POINTS.map((p) => ({ ...p, got: false, override: false, span: null })),
};

/** Lines (one per page element) a user can read. */
const pageLines = (b) => Object.values(b.p.els).filter((e) => !e.hidden).map(visibleText);

// Covers: MEM-033
// Requirement: a failing history Delete keeps the row and says so (UX R-delete).
describe("history Delete when the store delete fails", () => {
  test("no unhandled rejection, the row kept, no Undo, a visible error", async (t) => {
    const rejections = watchRejections(t);
    const rehAdapter = kvAdapter([[RUN.id, JSON.stringify(RUN)]]);
    rehAdapter.delete = async () => {
      throw new Error("delete boom");
    };
    const b = boot({ rehAdapter });
    await settle(100);
    assert.equal(historyRows(b), 1, "the stored run is listed");
    const before = new Set(pageLines(b));

    const del = find(el(b, "rehearsals"), (n) => n.tagName === "BUTTON" && n.dataset.action === "delete-rehearsal");
    b.p.fire(del, "click");
    await settle(100);

    assert.deepEqual(rejections, [], "a failing delete must not escape as an unhandled rejection");
    assert.equal(historyRows(b), 1, "the row is kept");
    assert.ok(rehAdapter.map.has(RUN.id), "the run is still stored");
    assert.equal(el(b, "rehearsal-undo").hidden, true, "no Undo for a delete that did not happen");
    const fresh = pageLines(b).filter((line) => !before.has(line));
    assert.ok(fresh.some((line) => ERROR.test(line)), `a visible message reports the failed delete (new page text: ${JSON.stringify(fresh)})`);
  });
});
