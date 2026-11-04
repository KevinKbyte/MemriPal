// Covers: MEM-132
// Requirement: typing "route from X to Y" in the Pal chat creates a walking route (MEM-132, ADR 0079). The text is
// parsed client-side (static/chat_route.js parseRouteIntent), planned by the MEM-088 planner extracted into pure
// static/route_plan.js planRoute over the committed Kendall graph + POIs, and run as the copilot tool create_route
// through static/copilot_dispatch.js, so undo removes the route. Non-route text is left to the normal chat reply;
// an unmapped place gets the demo-area miss text; nothing here ever throws into the chat.
// Contract (RED; GREEN adds static/chat_route.js, static/route_plan.js, static/copilot_bridge.js):
//   parseRouteIntent(text) -> {from, to} | null
//   planRoute(fromPhrase, toPhrase, {graph, pois}) -> {ok: true, from, to, stations, name, walk} | {ok: false, text}
//   createRouteTool({routes, load, newId}) -> {name: "create_route", run({from, to})}; load() resolves {graph, pois};
//     run resolves {result: {ok, id, name, text}, inverse} (dispatcher CopilotTool shape) or, on a plan miss,
//     {result: {ok: false, text}} with no inverse.
//   createChatRouteActor({dispatcher, onCreated}) -> {act(text)}: act resolves a reply string or null.
//   copilot_bridge.js: setActor(actor) / getActor() (null until set).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createDispatcher } from "./copilot_dispatch.js";
import { createRouteStore } from "./route_store.js";
import { memoryAdapter } from "./route_store_fakes_test.mjs";
import { createToolPolicy } from "./tool_policy.js";
import { createUndoStack } from "./undo_stack.js";

const missing = (err) => ({ __missing: String(err) });
const chatRoute = await import("./chat_route.js").catch(missing);
const routePlan = await import("./route_plan.js").catch(missing);
const bridge = await import("./copilot_bridge.js").catch(missing);

/** @param {any} mod @param {string} name @param {string} file */
function fn(mod, name, file) {
  assert.equal(typeof mod[name], "function", `static/${file} must export ${name} (${mod.__missing ?? "not exported"})`);
  return mod[name];
}

const GRAPH = JSON.parse(readFileSync(new URL("./data/kendall_walk_graph.json", import.meta.url), "utf8"));
const POIS = JSON.parse(readFileSync(new URL("./data/kendall_pois.json", import.meta.url), "utf8"));
const DATA = { graph: GRAPH, pois: POIS };
const NAME = "Kendall/MIT T to Meta office";
const FAIL = "I couldn't make that route. Try again.";

// Covers: MEM-132
// Requirement: only the listed route phrasings (any case, optional leading "please", optional trailing punctuation)
// are a route intent; X and Y are trimmed and split on the last " to "; anything else is not a route.
describe("MEM-132 parseRouteIntent", () => {
  const parse = (t) => fn(chatRoute, "parseRouteIntent", "chat_route.js")(t);

  test("every listed verb parses to {from, to}", () => {
    for (const verb of ["route", "walk", "directions", "take me", "walking route"]) {
      assert.deepEqual(parse(`${verb} from Kendall T to Meta office`), { from: "Kendall T", to: "Meta office" }, verb);
    }
  });

  test("case-insensitive, with an optional leading please and trailing punctuation", () => {
    assert.deepEqual(parse("ROUTE FROM Kendall T TO Meta office"), { from: "Kendall T", to: "Meta office" });
    assert.deepEqual(parse("Please walk from Kendall T to Meta office."), { from: "Kendall T", to: "Meta office" });
    assert.deepEqual(parse("please take me from Kendall T to Meta office?"), { from: "Kendall T", to: "Meta office" });
    assert.deepEqual(parse("Directions from Kendall T to Meta office!"), { from: "Kendall T", to: "Meta office" });
  });

  test("X and Y are trimmed; the last ' to ' splits them", () => {
    assert.deepEqual(parse("route from   Kendall T   to   Meta office  "), { from: "Kendall T", to: "Meta office" });
    assert.deepEqual(parse("walk from Main St to Third St to Meta office"), { from: "Main St to Third St", to: "Meta office" });
  });

  test("non-route text, blank and non-string input -> null", () => {
    for (const t of ["hello", "", "   ", "route me home", "can you route from Kendall T to Meta office", "what is a route?"]) {
      assert.equal(parse(t), null, JSON.stringify(t));
    }
    for (const t of [null, undefined, 42, {}, ["route from a to b"]]) assert.equal(parse(t), null, String(t));
  });

  test("a missing X or Y -> null", () => {
    for (const t of ["route from to Meta office", "route from Kendall T to", "route from Kendall T to   ", "route from   to Meta", "route from Kendall T"]) {
      assert.equal(parse(t), null, JSON.stringify(t));
    }
  });
});

// Covers: MEM-132
// Requirement: planRoute is the MEM-088 Find core as a pure function: both phrases geocode on the committed POIs,
// the walk follows the committed graph, stations run start -> landmarks -> end, the name is "From to To" cut to
// 40 characters; a blank phrase or an unmapped place gives ok:false with text naming suggestions, never an error.
describe("MEM-132 planRoute on the committed Kendall data", () => {
  const plan = (a, b) => fn(routePlan, "planRoute", "route_plan.js")(a, b, DATA);

  test("Kendall T -> Meta office: ok, named, start and end stations with coords", () => {
    const r = plan("Kendall T", "Meta office");
    assert.equal(r.ok, true, JSON.stringify(r).slice(0, 200));
    assert.equal(r.from.name, "Kendall/MIT T");
    assert.equal(r.to.name, "Meta office");
    assert.equal(r.name, NAME);
    assert.ok(Array.isArray(r.stations) && r.stations.length >= 2, "at least start and end");
    assert.equal(r.stations[0].name, "Kendall/MIT T");
    assert.equal(r.stations.at(-1).name, "Meta office");
    assert.deepEqual(r.stations.map((s) => s.n), r.stations.map((_, i) => i + 1));
    for (const s of r.stations) assert.ok(Number.isFinite(s.coords?.lat) && Number.isFinite(s.coords?.lon), s.name);
    assert.ok(r.walk && Number.isFinite(r.walk.length_m), "walk carries the route length");
  });

  test("the name is cut to 40 characters", () => {
    const r = plan("Kendall T", "Picower Institute for Learning and Memory (MIT)");
    assert.equal(r.ok, true);
    assert.equal(r.name, `${r.from.name} to ${r.to.name}`.slice(0, 40));
    assert.equal(r.name.length, 40);
  });

  test("an unmapped place -> ok:false, text names the suggestions, no raw error", () => {
    for (const [a, b] of [["Atlantis", "Meta office"], ["Kendall T", "zzqx nowhere"]]) {
      const r = plan(a, b);
      assert.equal(r.ok, false);
      assert.equal(typeof r.text, "string");
      assert.ok(r.text.includes("Meta office") && r.text.includes("Kendall/MIT T"), r.text);
      assert.doesNotMatch(r.text, /Error|undefined|\[object/);
      assert.equal("stations" in r, false, "no stations on a miss");
    }
  });

  test("a blank phrase -> ok:false with text, never throws", () => {
    for (const [a, b] of [["", "Meta office"], ["Kendall T", "   "]]) {
      const r = plan(a, b);
      assert.equal(r.ok, false);
      assert.ok(typeof r.text === "string" && r.text.length > 0);
      assert.doesNotMatch(r.text, /Error|undefined/);
    }
  });
});

function toolSetup({ load = async () => DATA } = {}) {
  const routes = createRouteStore(memoryAdapter());
  let n = 0;
  const tool = fn(chatRoute, "createRouteTool", "chat_route.js")({ routes, load, newId: () => `chat-route-${++n}` });
  return { routes, tool };
}

// Covers: MEM-132
// Requirement: the create_route copilot tool plans the route and saves it as a daily route; its inverse deletes
// that route (undo). A plan miss writes nothing and gives no inverse.
describe("MEM-132 createRouteTool", () => {
  test("is named create_route", () => {
    assert.equal(toolSetup().tool.name, "create_route");
  });

  test("run seeds the planned route; result {ok, id, name, text}", async () => {
    const { routes, tool } = toolSetup();
    const out = await tool.run({ from: "Kendall T", to: "Meta office" });
    assert.equal(out.result.ok, true);
    assert.equal(out.result.id, "chat-route-1");
    assert.equal(out.result.name, NAME);
    assert.ok(typeof out.result.text === "string" && out.result.text.length > 0);
    const list = await routes.listRoutes();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, "chat-route-1");
    assert.equal(list[0].name, NAME);
    assert.equal(list[0].kind, "daily");
    assert.equal(list[0].status, "saved");
    assert.equal(list[0].stations[0].name, "Kendall/MIT T");
    assert.equal(list[0].stations.at(-1).name, "Meta office");
  });

  test("the inverse deletes the created route", async () => {
    const { routes, tool } = toolSetup();
    const out = await tool.run({ from: "Kendall T", to: "Meta office" });
    assert.equal(typeof out.inverse, "function");
    await out.inverse();
    assert.deepEqual(await routes.listRoutes(), []);
  });

  test("a plan miss writes nothing and has no inverse", async () => {
    const { routes, tool } = toolSetup();
    const out = await tool.run({ from: "Atlantis", to: "Meta office" });
    assert.equal(out.result.ok, false);
    assert.ok(out.result.text.includes("Meta office"), out.result.text);
    assert.notEqual(typeof out?.inverse, "function");
    assert.deepEqual(await routes.listRoutes(), []);
  });
});

function actorSetup({ policies = { create_route: "allow" }, load } = {}) {
  const { routes, tool } = toolSetup(load ? { load } : {});
  const undo = createUndoStack();
  const dispatcher = createDispatcher({ policy: createToolPolicy(policies), undo, tools: { create_route: tool }, confirm: () => true });
  const created = [];
  const actor = fn(chatRoute, "createChatRouteActor", "chat_route.js")({ dispatcher, onCreated: (id) => created.push(id) });
  return { routes, undo, actor, created };
}

// Covers: MEM-132
// Requirement: the chat actor answers route text with a reply naming the created route and its stop count, then
// hands the new id to onCreated (which opens it on the Routes tab); non-route text is not its business (null);
// a miss replies with the plan text; any refusal or failure replies with a fixed retry line, never a throw.
describe("MEM-132 createChatRouteActor", () => {
  test("route text creates the route, replies with its name and stop count, calls onCreated(id)", async () => {
    const { routes, actor, created } = actorSetup();
    const reply = await actor.act("route from Kendall T to Meta office");
    const [r] = await routes.listRoutes();
    assert.ok(r, "a route was created");
    assert.equal(reply, `Made your route ${NAME} with ${r.stations.length} stops. It's on the Routes tab.`);
    assert.deepEqual(created, [r.id]);
  });

  test("undo removes the created route", async () => {
    const { routes, undo, actor } = actorSetup();
    await actor.act("Please walk from Kendall T to Meta office.");
    assert.equal((await routes.listRoutes()).length, 1);
    assert.equal(await undo.undo(), "create_route");
    assert.deepEqual(await routes.listRoutes(), []);
  });

  test("hello -> null, nothing dispatched", async () => {
    const { routes, undo, actor, created } = actorSetup();
    assert.equal(await actor.act("hello"), null);
    assert.deepEqual(await routes.listRoutes(), []);
    assert.equal(undo.size, 0);
    assert.deepEqual(created, []);
  });

  test("an unmapped place -> the plan's miss text, no route, onCreated not called", async () => {
    const { routes, actor, created } = actorSetup();
    const reply = await actor.act("route from Atlantis to Meta office");
    assert.equal(typeof reply, "string");
    assert.ok(reply.includes("Atlantis") && reply.includes("Meta office"), reply);
    assert.notEqual(reply, FAIL);
    assert.deepEqual(await routes.listRoutes(), []);
    assert.deepEqual(created, []);
  });

  test("a refused tool (policy off) -> the retry line", async () => {
    const { routes, actor, created } = actorSetup({ policies: {} });
    assert.equal(await actor.act("route from Kendall T to Meta office"), FAIL);
    assert.deepEqual(await routes.listRoutes(), []);
    assert.deepEqual(created, []);
  });

  test("a failing tool (data load rejects) -> the retry line", async () => {
    const { actor, created } = actorSetup({ load: async () => { throw new Error("offline"); } });
    assert.equal(await actor.act("route from Kendall T to Meta office"), FAIL);
    assert.deepEqual(created, []);
  });

  test("a dispatcher that throws -> the retry line, act never rejects", async () => {
    const created = [];
    const dispatcher = { dispatch: async () => { throw new Error("boom"); }, toolList: () => [] };
    const actor = fn(chatRoute, "createChatRouteActor", "chat_route.js")({ dispatcher, onCreated: (id) => created.push(id) });
    assert.equal(await actor.act("route from Kendall T to Meta office"), FAIL);
    assert.deepEqual(created, []);
  });
});

// Covers: MEM-132
// Requirement: copilot_bridge.js holds the page's one chat actor: getActor() is null until setActor(actor).
describe("MEM-132 copilot_bridge", () => {
  test("getActor is null until setActor, then returns that actor", () => {
    const getActor = fn(bridge, "getActor", "copilot_bridge.js");
    const setActor = fn(bridge, "setActor", "copilot_bridge.js");
    assert.equal(getActor(), null);
    const actor = { act: async () => null };
    setActor(actor);
    assert.equal(getActor(), actor);
  });
});
