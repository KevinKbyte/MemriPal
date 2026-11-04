// Covers: MEM-088
// Requirement: "Map a new route" works (MEM-088 landing 1). #routes-new opens #route-new in the drawer; Find
// geocodes #route-from/#route-to, routes over the committed walk graph (each data file fetched once), lists
// 3-8 stations (start, landmarks, end), the distance line and a default name "<from> to <to>"; a graph 404
// falls back to a straight line, labelled; a miss shows 'No match for "<phrase>".' with suggestions. Save
// stores one saved route and opens it (map mount, chip, Landmarks); Cancel returns to Routes home. #map-empty
// is the no-JS notice only; once booted, the MEM-114 call to action replaces it (hidden). #status hides on a healthy backend and says "Backend unavailable" otherwise.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { boot, click, el, findAll, kvAdapter, loadDemo, settle, TURNS, until, visibleText, walkDataFile } from "./ux_flow_harness_test.mjs";
import { createRouteStore } from "./route_store.js";

const FIXTURE = { status: "ok", mode: "fixture" };

function start(opts = {}) {
  const routes = createRouteStore(kvAdapter());
  const calls = [];
  const realMap = { calls, mount(svg, stations) { calls.push({ svg, stations: structuredClone(stations) }); return Promise.resolve(); } };
  const b = boot({ routes, realMap, health: FIXTURE, ...opts });
  return { b, routes, realMap };
}
const lis = (b, id) => findAll(el(b, id), (n) => n.tagName === "LI");
const fetched = (b, file) => b.server.calls.filter((c) => walkDataFile(c.u) === file).length;

async function find(b, from = "Kendall/MIT T", to = "Meta office") {
  click(b, "routes-new");
  el(b, "route-from").value = from;
  el(b, "route-to").value = to;
  el(b, "route-new-result").hidden = true;
  el(b, "route-new-error").hidden = true;
  click(b, "route-find");
  await until(() => !el(b, "route-new-result").hidden || !el(b, "route-new-error").hidden, "Find answered", TURNS);
  await settle(20);
}

describe("Map a new route: open, find, fallback, miss, cancel (MEM-088)", () => {
  test("#routes-new shows #route-new and opens the drawer", async () => {
    const { b } = start();
    await settle(20);
    click(b, "routes-new");
    await settle(10);
    assert.equal(el(b, "route-new").hidden, false, "#route-new shown");
    assert.equal(el(b, "routes-home").hidden, true, "#routes-home hidden");
    assert.equal(el(b, "route-view").hidden, true, "#route-view hidden");
    assert.equal(el(b, "drawer").open, true, "drawer open");
  });

  test("Find lists 3-8 stations, the distance and a default name; data fetched once", async () => {
    const { b } = start();
    await find(b);
    assert.equal(el(b, "route-new-result").hidden, false);
    assert.equal(el(b, "route-new-error").hidden, true);
    assert.match(el(b, "route-distance").textContent, /^About \d+ m, about \d+ min walk$/);
    const items = lis(b, "route-new-stations").map((li) => li.textContent);
    assert.ok(items.length >= 3 && items.length <= 8, `stations: ${items.join(" | ")}`);
    assert.ok(items[0].startsWith("Kendall/MIT T"), items[0]);
    assert.ok(items[items.length - 1].startsWith("Meta office"), items[items.length - 1]);
    assert.equal(el(b, "route-new-name").value, "Kendall/MIT T to Meta office");
    await find(b);
    assert.equal(fetched(b, "kendall_walk_graph.json"), 1, "graph fetched once");
    assert.equal(fetched(b, "kendall_pois.json"), 1, "POIs fetched once");
  });

  test("graph 404: straight-line distance, labelled, stations still listed", async () => {
    const { b } = start({ missingData: ["kendall_walk_graph.json"] });
    await find(b);
    assert.ok(el(b, "route-distance").textContent.endsWith("(straight line; walking paths unavailable)"),
      el(b, "route-distance").textContent);
    const items = lis(b, "route-new-stations").map((li) => li.textContent);
    assert.ok(items.length >= 2 && items[0].startsWith("Kendall/MIT T") && items.at(-1).startsWith("Meta office"), items.join(" | "));
  });

  test('a miss: No match for "zzqx". shown, no result', async () => {
    const { b } = start();
    await find(b, "zzqx");
    assert.equal(el(b, "route-new-error").hidden, false);
    assert.ok(el(b, "route-new-error").textContent.startsWith('No match for "zzqx".'), el(b, "route-new-error").textContent);
    assert.equal(el(b, "route-new-result").hidden, true);
  });

  test("Cancel returns to Routes home", async () => {
    const { b } = start();
    click(b, "routes-new");
    click(b, "route-new-cancel");
    await settle(20);
    assert.equal(el(b, "routes-home").hidden, false);
    assert.equal(el(b, "route-new").hidden, true);
  });
});

describe("Map a new route: Save stores and opens the route (MEM-088)", () => {
  for (const [typed, want] of [["My commute", "My commute"], ["   ", "Kendall/MIT T to Meta office"]]) {
    test(`Save with name ${JSON.stringify(typed)} -> one saved route "${want}", opened`, async () => {
      const { b, routes, realMap } = start();
      await find(b);
      el(b, "route-new-name").value = typed;
      click(b, "route-new-save");
      await until(() => !el(b, "route-view").hidden, "#route-view shown after Save", TURNS);
      await settle(20);
      const list = await routes.listRoutes();
      assert.equal(list.length, 1);
      const [r] = list;
      assert.equal(r.status, "saved");
      assert.equal(r.name, want);
      for (const s of r.stations) assert.ok(Number.isFinite(s.coords?.lat) && Number.isFinite(s.coords?.lon), `${s.name} coords`);
      assert.equal(el(b, "route-new").hidden, true);
      assert.deepEqual(realMap.calls.at(-1)?.stations.map((s) => s.id), r.stations.map((s) => s.id));
      assert.equal(el(b, "map-chip").textContent, want);
      assert.equal(el(b, "map-empty").hidden, true);
      assert.equal(lis(b, "landmarks-list").length, r.stations.length);
    });
  }
});

describe("map empty state and health line (MEM-088)", () => {
  test("#map-empty gives way to the MEM-114 call to action on a fresh boot and stays hidden once Load demo opens a route", async () => {
    const { b } = start();
    await settle(20);
    // MEM-114: the .empty-map-cta card replaced the MEM-088 text notice, so it is hidden on a fresh boot.
    assert.equal(el(b, "map-empty").hidden, true);
    await loadDemo(b);
    await until(() => !el(b, "route-view").hidden, "demo route opened", TURNS);
    assert.equal(el(b, "map-empty").hidden, true);
  });

  test("healthy backend hides #status; no health shows Backend unavailable", async () => {
    const ok = start();
    await until(() => el(ok.b, "status").hidden, "#status hidden on ok health", TURNS);
    const down = start({ health: undefined });
    await until(() => visibleText(el(down.b, "status")).includes("Backend unavailable"), "Backend unavailable", TURNS);
  });
});
