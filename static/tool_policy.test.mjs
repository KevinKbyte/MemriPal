// Covers: MEM-097
// Requirement: each copilot tool has a user-set policy allow | ask | off. allow runs, ask needs the
// user's confirm first, off is rejected and hidden from the tool list sent to the model. An unknown
// tool fails closed (treated as off), and a policy value outside allow/ask/off is refused.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { POLICIES, createToolPolicy } from "./tool_policy.js";

// Covers: MEM-097
// Requirement: the policy set is exactly allow, ask, off.
describe("tool_policy POLICIES", () => {
  test("lists allow, ask, off in that order", () => {
    assert.deepEqual([...POLICIES], ["allow", "ask", "off"]);
  });
});

// Covers: MEM-097
// Requirement: get/set read and change a tool's policy; defaults seed it; unknown tools are off.
describe("tool_policy get/set", () => {
  test("get returns the default policy for each seeded tool", () => {
    const p = createToolPolicy({ a: "allow", b: "ask", c: "off" });
    assert.equal(p.get("a"), "allow");
    assert.equal(p.get("b"), "ask");
    assert.equal(p.get("c"), "off");
  });

  test("set changes the policy get returns", () => {
    const p = createToolPolicy({ a: "allow" });
    p.set("a", "off");
    assert.equal(p.get("a"), "off");
    p.set("a", "ask");
    assert.equal(p.get("a"), "ask");
  });

  test("set can add a policy for a tool not in the defaults", () => {
    const p = createToolPolicy({});
    p.set("late", "allow");
    assert.equal(p.get("late"), "allow");
  });

  test("an unknown tool name reads as off (fail closed)", () => {
    const p = createToolPolicy({ a: "allow" });
    assert.equal(p.get("nope"), "off");
  });

  test("works with no defaults argument", () => {
    const p = createToolPolicy();
    assert.equal(p.get("a"), "off");
  });

  test("set with a value outside POLICIES throws and leaves the policy unchanged", () => {
    const p = createToolPolicy({ a: "ask" });
    for (const bad of ["ALLOW", "yes", "", null, undefined, 1]) {
      assert.throws(() => p.set("a", bad));
    }
    assert.equal(p.get("a"), "ask");
  });

  test("defaults with a value outside POLICIES throws", () => {
    assert.throws(() => createToolPolicy({ a: "allow", b: "maybe" }));
  });

  test("defaults are copied, not aliased", () => {
    const defaults = { a: "allow" };
    const p = createToolPolicy(defaults);
    defaults.a = "off";
    assert.equal(p.get("a"), "allow");
  });
});

// Covers: MEM-097
// Requirement: decide maps allow -> run, ask -> confirm, off and unknown -> reject.
describe("tool_policy decide", () => {
  test("allow runs, ask confirms, off rejects", () => {
    const p = createToolPolicy({ a: "allow", b: "ask", c: "off" });
    assert.equal(p.decide("a"), "run");
    assert.equal(p.decide("b"), "confirm");
    assert.equal(p.decide("c"), "reject");
  });

  test("an unknown tool is rejected", () => {
    const p = createToolPolicy({ a: "allow" });
    assert.equal(p.decide("ghost"), "reject");
  });

  test("decide follows set", () => {
    const p = createToolPolicy({ a: "allow" });
    p.set("a", "off");
    assert.equal(p.decide("a"), "reject");
    p.set("a", "ask");
    assert.equal(p.decide("a"), "confirm");
  });
});

// Covers: MEM-097
// Requirement: visibleTools drops off and unknown tools from the list sent to the model.
describe("tool_policy visibleTools", () => {
  const tools = [{ name: "a" }, { name: "b" }, { name: "c" }, { name: "ghost" }];

  test("keeps allow and ask tools in order, drops off and unknown ones", () => {
    const p = createToolPolicy({ a: "allow", b: "off", c: "ask" });
    assert.deepEqual(
      p.visibleTools(tools).map((t) => t.name),
      ["a", "c"],
    );
  });

  test("returns the same tool objects", () => {
    const p = createToolPolicy({ a: "allow" });
    const [only] = p.visibleTools(tools);
    assert.equal(only, tools[0]);
  });

  test("does not mutate the input array", () => {
    const p = createToolPolicy({ a: "allow" });
    const input = [...tools];
    p.visibleTools(input);
    assert.deepEqual(input, tools);
  });

  test("empty input gives empty output", () => {
    const p = createToolPolicy({ a: "allow" });
    assert.deepEqual(p.visibleTools([]), []);
  });

  test("a tool turned off via set disappears from the list", () => {
    const p = createToolPolicy({ a: "allow", c: "ask" });
    p.set("c", "off");
    assert.deepEqual(
      p.visibleTools(tools).map((t) => t.name),
      ["a"],
    );
  });
});
