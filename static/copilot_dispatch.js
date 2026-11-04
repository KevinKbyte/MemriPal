// @ts-check
// Copilot UI action dispatcher (MEM-097): the one path every copilot tool call takes. It enforces the
// per-tool policy, asks the user for ask tools, and records exactly one inverse per successful action.
// An action that throws or gives no inverse is an error and leaves the undo stack untouched, so every
// entry on the stack is guaranteed reversible.

/**
 * @typedef {{
 *   name: string,
 *   run: (args: unknown) => Promise<{ result?: unknown, inverse: () => unknown } | undefined>,
 * }} CopilotTool
 * @typedef {{ status: "ok" | "rejected" | "declined" | "error", result?: unknown }} DispatchResult
 */

/**
 * @param {{
 *   policy: ReturnType<typeof import("./tool_policy.js").createToolPolicy>,
 *   undo: ReturnType<typeof import("./undo_stack.js").createUndoStack>,
 *   tools: Record<string, CopilotTool>,
 *   confirm: (name: string, args: unknown) => boolean | Promise<boolean>,
 * }} deps
 */
export function createDispatcher({ policy, undo, tools, confirm }) {
  /**
   * @param {string} name
   * @param {unknown} args
   * @returns {Promise<DispatchResult>} never rejects
   */
  async function dispatch(name, args) {
    const tool = Object.hasOwn(tools, name) ? tools[name] : undefined;
    const decision = policy.decide(name);
    if (!tool || decision === "reject") return { status: "rejected" };
    try {
      if (decision === "confirm" && (await confirm(name, args)) !== true) return { status: "declined" };
      const out = await tool.run(args);
      if (typeof out?.inverse !== "function") return { status: "error" };
      undo.push({ label: name, undo: out.inverse });
      return { status: "ok", result: out.result };
    } catch (err) {
      return { status: "error", result: err instanceof Error ? err.message : String(err) };
    }
  }

  /** @returns {CopilotTool[]} the registered tools the model may see */
  function toolList() {
    return policy.visibleTools(Object.values(tools));
  }

  return { dispatch, toolList };
}
