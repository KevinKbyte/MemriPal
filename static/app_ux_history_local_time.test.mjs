// Covers: MEM-033
// Requirement: a history row names its run by when it happened in the user's own terms: the stored
// UTC ISO timestamp (e.g. "2026-10-30T09:00:00.000Z") is shown as the browser's locale-formatted
// local date and time, exactly `new Date(timestamp).toLocaleString()`, never as the raw ISO string.
// The row still reads "<time>: <got>/<n> recalled". The stored record keeps its ISO timestamp.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { boot, el, findAll, historyRows, kvAdapter, POINTS, settle, TURNS, until, visibleText } from "./ux_flow_harness_test.mjs";

const ISO = "2026-10-30T09:00:00.000Z";
const RUN = {
  id: "run-1",
  palace_id: "demo",
  timestamp: ISO,
  transcript: "students can use it for exams",
  points: POINTS.map((p, i) => ({ ...p, got: i === 9, override: false, span: i === 9 ? "students can use it for exams" : null })),
};

// Covers: MEM-033
// Requirement: history rows show a locale-formatted local time, not the raw UTC ISO string (UX F14).
describe("history row timestamp", () => {
  test("row shows new Date(iso).toLocaleString(), not the ISO string", async () => {
    const local = new Date(ISO).toLocaleString();
    assert.notEqual(local, ISO, "precondition: the locale form differs from the ISO form");
    const rehAdapter = kvAdapter([[RUN.id, JSON.stringify(RUN)]]);
    const b = boot({ rehAdapter });
    await until(() => historyRows(b) === 1, "stored run listed on load", TURNS);
    await settle(20);
    const row = findAll(el(b, "rehearsals"), (n) => n.tagName === "LI", { visibleOnly: true })[0];
    const text = visibleText(row);
    assert.ok(!text.includes(ISO), `row "${text}" must not show the raw ISO timestamp`);
    assert.ok(text.includes(`${local}: 1/${POINTS.length} recalled`), `row "${text}" must read "${local}: 1/${POINTS.length} recalled"`);
    assert.equal(JSON.parse(rehAdapter.map.get(RUN.id)).timestamp, ISO, "the stored record keeps its ISO timestamp");
  });
});
