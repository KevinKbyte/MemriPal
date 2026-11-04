// Covers: MEM-133
// Requirement: the curated demo routes are generated, not hand-authored (MEM-133, ADR 0079): scripts/gen_demo_routes.mjs
// exports generateDemoRoutes({graph, pois}), which runs planRoute over the committed Kendall graph + POIs and is
// deterministic (same data -> same routes, fixed ids), and the committed static/data/demo_routes.json is exactly
// its output, so regenerating changes nothing. Importing the script writes nothing.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const gen = await import("./gen_demo_routes.mjs").catch((err) => ({ __missing: String(err) }));
const data = (f) => JSON.parse(readFileSync(new URL(`../static/data/${f}`, import.meta.url), "utf8"));

// Covers: MEM-133
// Requirement: generateDemoRoutes is deterministic and matches the committed demo_routes.json.
describe("MEM-133 gen_demo_routes", () => {
  const run = () => {
    assert.equal(typeof gen.generateDemoRoutes, "function", `scripts/gen_demo_routes.mjs must export generateDemoRoutes (${gen.__missing ?? "not exported"})`);
    return gen.generateDemoRoutes({ graph: data("kendall_walk_graph.json"), pois: data("kendall_pois.json") });
  };

  test("two runs give the same routes", () => {
    const a = run();
    const b = run();
    assert.deepEqual(a, b);
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });

  test("output deep-equals the committed static/data/demo_routes.json", () => {
    assert.deepEqual(run(), data("demo_routes.json"));
  });
});
