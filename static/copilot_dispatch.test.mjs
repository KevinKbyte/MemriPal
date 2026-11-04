// Covers: MEM-097
// Requirement: every copilot tool call runs through one UI action dispatcher. An off or unknown tool
// is rejected and absent from the model's tool list; an ask tool runs only after the user confirms;
// each successful action adds exactly one undo entry, and undo restores the prior state. A failed
// action (throws, or gives no inverse) leaves the undo stack untouched.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createDispatcher } from "./copilot_dispatch.js";
import { createToolPolicy } from "./tool_policy.js";
import { createUndoStack } from "./undo_stack.js";

function fakeTool(name, impl) {
  const calls = [];
  return {
    name,
    calls,
    async run(args) {
      calls.push(args);
      return impl ? impl(args) : { result: `${name}-ok`, inverse: () => {} };
    },
  };
}

function setup({ policies, tools, confirmAnswer = true } = {}) {
  const policy = createToolPolicy(policies);
  const undo = createUndoStack();
  const confirmCalls = [];
  const confirm = async (name, args) => {
    confirmCalls.push([name, args]);
    return confirmAnswer;
  };
  const d = createDispatcher({ policy, undo, tools, confirm });
  return { d, policy, undo, confirmCalls };
}

// Covers: MEM-097
// Requirement: off and unknown tools are rejected without running or prompting.
describe("copilot_dispatch rejected", () => {
  test("an off tool is rejected, never run, never confirmed", async () => {
    const t = fakeTool("wipe");
    const { d, undo, confirmCalls } = setup({ policies: { wipe: "off" }, tools: { wipe: t } });
    const r = await d.dispatch("wipe", { all: true });
    assert.equal(r.status, "rejected");
    assert.equal(t.calls.length, 0);
    assert.equal(confirmCalls.length, 0);
    assert.equal(undo.size, 0);
  });

  test("a tool with no policy entry is rejected (fail closed)", async () => {
    const t = fakeTool("mystery");
    const { d, undo } = setup({ policies: {}, tools: { mystery: t } });
    const r = await d.dispatch("mystery", {});
    assert.equal(r.status, "rejected");
    assert.equal(t.calls.length, 0);
    assert.equal(undo.size, 0);
  });

  test("a name with an allow policy but no registered tool is rejected", async () => {
    const { d, undo, confirmCalls } = setup({ policies: { ghost: "allow" }, tools: {} });
    const r = await d.dispatch("ghost", {});
    assert.equal(r.status, "rejected");
    assert.equal(confirmCalls.length, 0);
    assert.equal(undo.size, 0);
  });

  test("a policy flipped to off at runtime rejects the next call", async () => {
    const t = fakeTool("rename");
    const { d, policy } = setup({ policies: { rename: "allow" }, tools: { rename: t } });
    policy.set("rename", "off");
    const r = await d.dispatch("rename", {});
    assert.equal(r.status, "rejected");
    assert.equal(t.calls.length, 0);
  });
});

// Covers: MEM-097
// Requirement: an ask tool prompts first; declined means not run; it runs only after confirm is true.
describe("copilot_dispatch ask", () => {
  test("confirm is called with the tool name and args", async () => {
    const t = fakeTool("move");
    const args = { id: 7 };
    const { d, confirmCalls } = setup({ policies: { move: "ask" }, tools: { move: t } });
    await d.dispatch("move", args);
    assert.deepEqual(confirmCalls, [["move", args]]);
  });

  test("confirm false -> declined, run never called, no undo entry", async () => {
    const t = fakeTool("move");
    const { d, undo } = setup({
      policies: { move: "ask" },
      tools: { move: t },
      confirmAnswer: false,
    });
    const r = await d.dispatch("move", { id: 1 });
    assert.equal(r.status, "declined");
    assert.equal(t.calls.length, 0);
    assert.equal(undo.size, 0);
  });

  test("run waits until confirm resolves true", async () => {
    const t = fakeTool("move");
    let release;
    const gate = new Promise((res) => { release = res; });
    const policy = createToolPolicy({ move: "ask" });
    const undo = createUndoStack();
    const d = createDispatcher({ policy, undo, tools: { move: t }, confirm: () => gate });
    const pending = d.dispatch("move", { id: 2 });
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    assert.equal(t.calls.length, 0, "ran before the user confirmed");
    release(true);
    const r = await pending;
    assert.equal(r.status, "ok");
    assert.deepEqual(t.calls, [{ id: 2 }]);
    assert.equal(undo.size, 1);
  });
});

// Covers: MEM-097
// Requirement: an allowed action runs without prompting, returns its result, adds one undo entry.
describe("copilot_dispatch ok", () => {
  test("allow runs with the args, no confirm, returns the result", async () => {
    const t = fakeTool("pin", () => ({ result: { pinned: 3 }, inverse: () => {} }));
    const { d, confirmCalls } = setup({ policies: { pin: "allow" }, tools: { pin: t } });
    const r = await d.dispatch("pin", { id: 3 });
    assert.equal(r.status, "ok");
    assert.deepEqual(r.result, { pinned: 3 });
    assert.deepEqual(t.calls, [{ id: 3 }]);
    assert.equal(confirmCalls.length, 0);
  });

  test("each ok action pushes exactly one undo entry", async () => {
    const t = fakeTool("pin");
    const { d, undo } = setup({ policies: { pin: "allow" }, tools: { pin: t } });
    await d.dispatch("pin", { id: 1 });
    assert.equal(undo.size, 1);
    await d.dispatch("pin", { id: 2 });
    assert.equal(undo.size, 2);
  });

  test("the undo entry calls the action's inverse", async () => {
    let inverted = 0;
    const t = fakeTool("pin", () => ({ result: null, inverse: () => { inverted += 1; } }));
    const { d, undo } = setup({ policies: { pin: "allow" }, tools: { pin: t } });
    await d.dispatch("pin", {});
    assert.equal(inverted, 0, "inverse ran before undo");
    await undo.undo();
    assert.equal(inverted, 1);
    assert.equal(undo.size, 0);
  });

  test("an async inverse is awaited by undo", async () => {
    let restored = false;
    const t = fakeTool("pin", () => ({
      result: null,
      inverse: async () => { await Promise.resolve(); restored = true; },
    }));
    const { d, undo } = setup({ policies: { pin: "allow" }, tools: { pin: t } });
    await d.dispatch("pin", {});
    await undo.undo();
    assert.equal(restored, true);
  });
});

// Covers: MEM-097
// Requirement: a failed action reports error and pushes nothing onto the undo stack.
describe("copilot_dispatch error", () => {
  test("run throws -> error, dispatch resolves (does not reject), no undo entry", async () => {
    const t = fakeTool("boom", () => { throw new Error("kaput"); });
    const { d, undo } = setup({ policies: { boom: "allow" }, tools: { boom: t } });
    const r = await d.dispatch("boom", {});
    assert.equal(r.status, "error");
    assert.equal(undo.size, 0);
  });

  test("run returns no inverse -> error, no undo entry", async () => {
    const t = fakeTool("noinv", () => ({ result: 1 }));
    const { d, undo } = setup({ policies: { noinv: "allow" }, tools: { noinv: t } });
    const r = await d.dispatch("noinv", {});
    assert.equal(r.status, "error");
    assert.equal(undo.size, 0);
  });

  test("run returns a non-function inverse -> error, no undo entry", async () => {
    const t = fakeTool("badinv", () => ({ result: 1, inverse: "restore" }));
    const { d, undo } = setup({ policies: { badinv: "allow" }, tools: { badinv: t } });
    const r = await d.dispatch("badinv", {});
    assert.equal(r.status, "error");
    assert.equal(undo.size, 0);
  });

  test("run resolves undefined -> error, no undo entry", async () => {
    const t = fakeTool("empty", () => undefined);
    const { d, undo } = setup({ policies: { empty: "allow" }, tools: { empty: t } });
    const r = await d.dispatch("empty", {});
    assert.equal(r.status, "error");
    assert.equal(undo.size, 0);
  });
});

// Covers: MEM-097
// Requirement: the tool list sent to the model omits off and unknown-policy tools.
describe("copilot_dispatch toolList", () => {
  test("returns only tools whose policy is allow or ask", () => {
    const tools = {
      a: fakeTool("a"),
      b: fakeTool("b"),
      c: fakeTool("c"),
      d: fakeTool("d"),
    };
    const { d } = setup({ policies: { a: "allow", b: "off", c: "ask" }, tools });
    assert.deepEqual(
      d.toolList().map((t) => t.name).sort(),
      ["a", "c"],
    );
  });

  test("reflects a policy change made after the dispatcher was created", () => {
    const tools = { a: fakeTool("a"), c: fakeTool("c") };
    const { d, policy } = setup({ policies: { a: "allow", c: "ask" }, tools });
    policy.set("a", "off");
    assert.deepEqual(d.toolList().map((t) => t.name), ["c"]);
  });
});

// Covers: MEM-097
// Requirement: end to end, an action changes state and undo puts the prior state back.
describe("copilot_dispatch end to end undo", () => {
  test("ok action mutates state; undo restores the prior state", async () => {
    const state = { title: "Kendall", stations: ["A", "B"] };
    const rename = {
      name: "rename",
      async run({ title }) {
        const prev = state.title;
        state.title = title;
        return { result: { title }, inverse: () => { state.title = prev; } };
      },
    };
    const addStation = {
      name: "add_station",
      async run({ id }) {
        state.stations.push(id);
        return {
          result: { count: state.stations.length },
          inverse: async () => { state.stations.pop(); },
        };
      },
    };
    const { d, undo } = setup({
      policies: { rename: "allow", add_station: "ask" },
      tools: { rename, add_station: addStation },
      confirmAnswer: true,
    });

    assert.equal((await d.dispatch("rename", { title: "Central" })).status, "ok");
    assert.equal((await d.dispatch("add_station", { id: "C" })).status, "ok");
    assert.deepEqual(state, { title: "Central", stations: ["A", "B", "C"] });
    assert.equal(undo.size, 2);

    await undo.undo();
    assert.deepEqual(state, { title: "Central", stations: ["A", "B"] });
    await undo.undo();
    assert.deepEqual(state, { title: "Kendall", stations: ["A", "B"] });
    assert.equal(undo.canUndo, false);
  });

  test("a rejected or declined call leaves state and the undo stack alone", async () => {
    const state = { n: 0 };
    const bump = {
      name: "bump",
      async run() {
        state.n += 1;
        return { result: state.n, inverse: () => { state.n -= 1; } };
      },
    };
    const declined = setup({ policies: { bump: "ask" }, tools: { bump }, confirmAnswer: false });
    assert.equal((await declined.d.dispatch("bump", {})).status, "declined");
    const rejected = setup({ policies: { bump: "off" }, tools: { bump } });
    assert.equal((await rejected.d.dispatch("bump", {})).status, "rejected");
    assert.equal(state.n, 0);
    assert.equal(declined.undo.size, 0);
    assert.equal(rejected.undo.size, 0);
  });
});
