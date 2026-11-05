// Covers: MEM-140
// Requirement: a route made from the Pal chat gets Spark-picked landmark emoji when Spark is available, and the
// offline picks (emojiFor) otherwise; the pick happens before the route is saved, so the stored stations carry it.
// Contract (RED; GREEN extends static/chat_route.js createRouteTool): optional dep spark; before seedRoute each
// station emoji = await pickLandmarkEmoji({ name }, { spark }) (static/landmark_emoji_spark.js).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createRouteTool } from "./chat_route.js";
import { emojiFor } from "./landmark_emoji.js";
import { createRouteStore } from "./route_store.js";
import { memoryAdapter } from "./route_store_fakes_test.mjs";

const GRAPH = JSON.parse(readFileSync(new URL("./data/kendall_walk_graph.json", import.meta.url), "utf8"));
const POIS = JSON.parse(readFileSync(new URL("./data/kendall_pois.json", import.meta.url), "utf8"));
const MUSEUM = "\u{1F3DB}";

async function seeded(spark) {
  const routes = createRouteStore(memoryAdapter());
  const deps = { routes, load: async () => ({ graph: GRAPH, pois: POIS }), newId: () => "chat-route-1" };
  if (spark) deps.spark = spark;
  const out = await createRouteTool(deps).run({ from: "Kendall T", to: "Meta office" });
  assert.equal(out.result.ok, true, "precondition: the route plans");
  const [route] = await routes.listRoutes();
  return route.stations;
}

// Covers: MEM-140
// Requirement: Spark's emoji lands in the saved stations; without Spark the offline picks are kept.
describe("MEM-140 createRouteTool landmark emoji", () => {
  test("a fake spark's emoji lands in every seeded station; spark sees each station name", async () => {
    const asked = [];
    const stations = await seeded(async (lm) => { asked.push(lm.name); return MUSEUM; });
    assert.ok(stations.length >= 2);
    for (const st of stations) assert.equal(st.emoji, MUSEUM, st.name);
    assert.deepEqual(asked, stations.map((st) => st.name));
  });

  test("no spark: each station keeps emojiFor's pick", async () => {
    const stations = await seeded(null);
    for (const st of stations) assert.equal(st.emoji, emojiFor({ name: st.name }), st.name);
  });
});
