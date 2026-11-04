// @ts-check
// Copilot undo stack (MEM-097): every copilot action pushes one inverse; undo replays the newest.
// Bounded so a long session cannot grow it without limit; past the limit the oldest entry drops.

/** @typedef {{ label: string, undo: () => unknown }} UndoEntry */

/**
 * @param {{ limit?: number }} [options]
 */
export function createUndoStack({ limit = 50 } = {}) {
  /** @type {UndoEntry[]} */
  let entries = [];

  /** @param {UndoEntry} entry */
  function push(entry) {
    if (typeof entry?.undo !== "function") throw new Error("undo entry needs an undo function");
    entries.push({ label: entry.label, undo: entry.undo });
    if (entries.length > limit) entries.splice(0, entries.length - limit);
  }

  /** @returns {Promise<string | null>} the undone entry's label, or null when empty */
  async function undo() {
    // Pop before running so the inverse runs at most once even if undo is re-entered meanwhile.
    const entry = entries.pop();
    if (!entry) return null;
    await entry.undo();
    return entry.label;
  }

  function clear() {
    entries = [];
  }

  return {
    push,
    undo,
    clear,
    get size() {
      return entries.length;
    },
    get canUndo() {
      return entries.length > 0;
    },
  };
}
