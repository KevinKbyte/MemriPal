// Covers: MEM-033
// Requirement: when the rehearsal store cannot be read or written (IndexedDB fails to open), the page
// still works and says so: the history section shows "History unavailable" instead of failing
// silently, Load demo and the recorded replay still run and show their said-vs-palace end screen, and
// no unhandled rejection escapes. A stored entry that is not a valid rehearsal record (unparseable JSON,
// or JSON null) is skipped, so the valid runs beside it are still listed.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { boot, click, el, kvAdapter, loadDemo, pageMentions, POINTS, saidRows, settle, historyRows, TURNS, until, visibleText, watchRejections } from "./ux_flow_harness_test.mjs";
import { createRehearsalStore } from "./rehearsals.js";

const flow = await import("./flow.js");

const UNAVAILABLE = "History unavailable";

/** An IndexedDB factory whose every open() fails (onerror in a microtask, req.error set). */
function failingIdb() {
  return {
    open() {
      const req = { error: null, result: undefined, onerror: null, onsuccess: null, onupgradeneeded: null };
      queueMicrotask(() => {
        req.error = new Error("boom");
        if (typeof req.onerror === "function") req.onerror();
      });
      return req;
    },
  };
}

const brokenStore = () => flow.selectStore({ indexedDB: failingIdb() }, { dbName: "memripal-rehearsals", storeName: "rehearsals", prefix: "memripal-reh:" });

const VALID = {
  id: "ok",
  palace_id: "demo",
  timestamp: "2026-10-30T09:00:00.000Z",
  transcript: "students can use it for exams",
  points: POINTS.map((p) => ({ ...p, got: false, override: false, span: null })),
};
const MIXED = () => [["bad", "not json{"], ["nul", "null"], ["ok", JSON.stringify(VALID)]];

// Covers: MEM-033
// Requirement: a rehearsal store that fails to open degrades to "History unavailable" (UX F5).
describe("rehearsal store unavailable (IndexedDB open fails)", () => {
  test("on open: no unhandled rejection, #history visible with \"History unavailable\"", async (t) => {
    const rejections = watchRejections(t);
    const b = boot({ rehAdapter: brokenStore() });
    await settle(100);
    assert.deepEqual(rejections, [], "a failing history read must not escape as an unhandled rejection");
    assert.equal(el(b, "history").hidden, false, "#history is shown so the failure is visible");
    assert.ok(visibleText(el(b, "history")).includes(UNAVAILABLE), `#history says "${UNAVAILABLE}"`);
  });

  test("Load demo still shows the recall panel, with no unhandled rejection", async (t) => {
    const rejections = watchRejections(t);
    const b = boot({ rehAdapter: brokenStore() });
    await loadDemo(b);
    await settle(100);
    assert.equal(el(b, "recall").hidden, false, "recall panel shown");
    assert.deepEqual(rejections, [], "a failing history re-render after Load demo must not escape");
  });

  test("replay with a failing save still renders the said-vs-palace end screen", async (t) => {
    const rejections = watchRejections(t);
    const b = boot({ rehAdapter: brokenStore() });
    await loadDemo(b);
    click(b, "recall-replay");
    await settle(200);
    assert.equal(saidRows(b), POINTS.length, "one said-vs-palace row per point even though the save failed");
    assert.deepEqual(rejections, [], "a failing save must not escape as an unhandled rejection");
  });
});

// Covers: MEM-033
// Requirement: one corrupt stored entry never hides the valid rehearsals beside it (UX F5).
describe("corrupt stored rehearsal entries are skipped", () => {
  test("page: the valid run is listed and no \"History unavailable\" is shown", async (t) => {
    const rejections = watchRejections(t);
    const b = boot({ rehAdapter: kvAdapter(MIXED()) });
    await settle(100);
    assert.equal(historyRows(b), 1, "the one valid run gets a history row");
    assert.equal(pageMentions(b, UNAVAILABLE), false, "a readable store is not reported unavailable");
    assert.deepEqual(rejections, []);
  });

  test("createRehearsalStore(adapter).list(\"demo\") returns only the valid record", async () => {
    const store = createRehearsalStore(kvAdapter(MIXED()));
    assert.deepEqual(await store.list("demo"), [VALID]);
  });
});
