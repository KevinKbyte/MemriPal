// Covers: MEM-097
// Requirement: every copilot action pushes one inverse onto an undo stack; undo replays the most
// recent inverse (sync or async), removes it and reports its label. An empty stack undoes nothing.
// The stack is bounded: past the limit the oldest entry is dropped.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createUndoStack } from "./undo_stack.js";

// Covers: MEM-097
// Requirement: push records an undoable entry; an entry without an undo function is refused.
describe("undo_stack push", () => {
  test("a new stack is empty", () => {
    const s = createUndoStack();
    assert.equal(s.size, 0);
    assert.equal(s.canUndo, false);
  });

  test("push grows size and enables undo", () => {
    const s = createUndoStack();
    s.push({ label: "one", undo: () => {} });
    assert.equal(s.size, 1);
    assert.equal(s.canUndo, true);
    s.push({ label: "two", undo: () => {} });
    assert.equal(s.size, 2);
  });

  test("push without a function undo throws and adds nothing", () => {
    const s = createUndoStack();
    assert.throws(() => s.push({ label: "x" }));
    assert.throws(() => s.push({ label: "x", undo: "not a function" }));
    assert.throws(() => s.push({ label: "x", undo: null }));
    assert.throws(() => s.push(undefined));
    assert.equal(s.size, 0);
    assert.equal(s.canUndo, false);
  });
});

// Covers: MEM-097
// Requirement: undo runs the latest entry's inverse, awaits it, pops it, resolves its label.
describe("undo_stack undo", () => {
  test("empty stack resolves null", async () => {
    const s = createUndoStack();
    assert.equal(await s.undo(), null);
    assert.equal(s.size, 0);
  });

  test("undoes in last-in-first-out order and resolves each label", async () => {
    const s = createUndoStack();
    const ran = [];
    s.push({ label: "first", undo: () => ran.push("first") });
    s.push({ label: "second", undo: () => ran.push("second") });
    assert.equal(await s.undo(), "second");
    assert.deepEqual(ran, ["second"]);
    assert.equal(s.size, 1);
    assert.equal(await s.undo(), "first");
    assert.deepEqual(ran, ["second", "first"]);
    assert.equal(s.size, 0);
    assert.equal(s.canUndo, false);
    assert.equal(await s.undo(), null);
  });

  test("awaits an async undo before resolving", async () => {
    const s = createUndoStack();
    let done = false;
    s.push({
      label: "async",
      undo: async () => {
        await Promise.resolve();
        await Promise.resolve();
        done = true;
      },
    });
    const label = await s.undo();
    assert.equal(label, "async");
    assert.equal(done, true);
  });

  test("undo returns a promise even for a sync inverse", () => {
    const s = createUndoStack();
    s.push({ label: "sync", undo: () => {} });
    const r = s.undo();
    assert.equal(typeof r?.then, "function");
    return r;
  });

  test("each entry's inverse runs exactly once", async () => {
    const s = createUndoStack();
    let n = 0;
    s.push({ label: "once", undo: () => { n += 1; } });
    await s.undo();
    await s.undo();
    assert.equal(n, 1);
  });
});

// Covers: MEM-097
// Requirement: the stack keeps at most `limit` entries (default 50), dropping the oldest.
describe("undo_stack limit", () => {
  test("default limit is 50", () => {
    const s = createUndoStack();
    for (let i = 0; i < 60; i += 1) s.push({ label: `e${i}`, undo: () => {} });
    assert.equal(s.size, 50);
  });

  test("exceeding the limit drops the oldest entries", async () => {
    const s = createUndoStack({ limit: 3 });
    for (const l of ["a", "b", "c", "d", "e"]) s.push({ label: l, undo: () => {} });
    assert.equal(s.size, 3);
    const labels = [];
    while (s.canUndo) labels.push(await s.undo());
    assert.deepEqual(labels, ["e", "d", "c"]);
  });

  test("exactly at the limit keeps every entry", () => {
    const s = createUndoStack({ limit: 3 });
    for (const l of ["a", "b", "c"]) s.push({ label: l, undo: () => {} });
    assert.equal(s.size, 3);
  });
});

// Covers: MEM-097
// Requirement: clear empties the stack without running any inverse.
describe("undo_stack clear", () => {
  test("clear empties the stack and runs no inverse", async () => {
    const s = createUndoStack();
    let ran = false;
    s.push({ label: "x", undo: () => { ran = true; } });
    s.clear();
    assert.equal(s.size, 0);
    assert.equal(s.canUndo, false);
    assert.equal(await s.undo(), null);
    assert.equal(ran, false);
  });
});
