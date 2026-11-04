// Covers: MEM-132
// Requirement: the page wires the Pal chat to route creation (MEM-132, ADR 0079). Once wireApp has a route store,
// static/copilot_bridge.js getActor() is the chat route actor: "route from Kendall T to Meta office" saves the route
// (graph + POIs come from the committed static/data files through deps.fetch), its card lists on the Routes tab and
// the route opens; "hello" is left to the normal chat reply (null).
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { boot, el, findAll, kvAdapter, settle, TURNS, until, watchRejections } from "./ux_flow_harness_test.mjs";
import { memoryAdapter } from "./route_store_fakes_test.mjs";
import { createRouteStore } from "./route_store.js";

const bridge = await import("./copilot_bridge.js").catch((err) => ({ __missing: String(err) }));

function start() {
  const routes = createRouteStore(memoryAdapter());
  const realMap = { mount: () => Promise.resolve(null) };
  const b = boot({ routes, realMap, rehAdapter: kvAdapter(), health: { status: "ok", mode: "fixture" } });
  assert.equal(typeof bridge.getActor, "function", `static/copilot_bridge.js must export getActor (${bridge.__missing ?? "not exported"})`);
  const actor = bridge.getActor();
  assert.ok(actor && typeof actor.act === "function", "wireApp sets a chat actor with act(text)");
  return { b, routes, actor };
}

const cards = (b) => findAll(el(b, "routes-list"), (n) => n.tagName === "LI", { visibleOnly: true });

// Covers: MEM-132
// Requirement: the Pal chat route actor is live on the page once wireApp runs with a route store.
describe("MEM-132 Pal chat creates a route through the page wiring", () => {
  test("route text saves the route, lists its card and opens it; the reply names it", async (t) => {
    const rejections = watchRejections(t);
    const { b, routes, actor } = start();
    await settle(20);
    const reply = await actor.act("route from Kendall T to Meta office");
    const list = await routes.listRoutes();
    assert.equal(list.length, 1, "one route created");
    assert.equal(reply, `Made your route Kendall/MIT T to Meta office with ${list[0].stations.length} stops. It's on the Routes tab.`);
    await until(() => cards(b).length === 1, "the new route's card on the Routes tab", TURNS);
    await until(() => !el(b, "route-view").hidden, "the new route opens", TURNS);
    assert.deepEqual(rejections, []);
  });

  test("hello is not a route: act resolves null and nothing is saved", async () => {
    const { routes, actor } = start();
    assert.equal(await actor.act("hello"), null);
    assert.deepEqual(await routes.listRoutes(), []);
  });
});
