// Covers: MEM-135
// Requirement: the route/walk view shows no "next turn" direction UI. A left/right cue is wrong whenever the
// walker faces another way, and the map already shows the route. The station card has no #tap-turn group and
// no "Next turn" heading; TAP_GROUPS has no `turn` key, so tapSummary never lists a turn line; a stored legacy
// `taps.turn` renders no " then <turn>" text in the S5 #route-view-stations list; the route map still renders
// one node per station.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { boot, el, find, findAll, settle, TURNS, until, visibleText, watchRejections } from "./ux_flow_harness_test.mjs";
import { memoryAdapter } from "./route_store_fakes_test.mjs";
import { createRouteStore } from "./route_store.js";
import { TAP_GROUPS, TAP_GROUP_LABELS, tapSummary } from "./station_card.js";

const NAMES = ["red bench", "old oak", "blue gate"];

function seeded() {
  const adapter = memoryAdapter();
  const stations = NAMES.map((name, i) => ({ id: `r1-st-${i + 1}`, n: i + 1, name, status: "named",
    taps: { turn: ["Left", "Right", "Straight"][i], mood: "Calm" } }));
  const route = { id: "r1", name: "Commute", kind: "daily", status: "saved",
    created_at: "2026-10-30T08:00:00.000Z", stations, lists: [] };
  adapter.map.set("route:r1", { type: "route", route });
  return adapter;
}

// Covers: MEM-135
// Requirement: see file header (no next-turn markup, group, label or summary line).
describe("no next-turn group on the station card (MEM-135)", () => {
  test("index.html has no #tap-turn and no Next turn heading", () => {
    const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
    assert.equal(html.includes("tap-turn"), false);
    assert.equal(/next turn/i.test(html), false);
  });

  test("TAP_GROUPS and TAP_GROUP_LABELS have no turn key; tapSummary drops a legacy turn", () => {
    assert.equal(Object.hasOwn(TAP_GROUPS, "turn"), false);
    assert.equal(Object.hasOwn(TAP_GROUP_LABELS, "turn"), false);
    assert.deepEqual(tapSummary({ turn: "Left", mood: "Calm" }), ["Mood: Calm"]);
  });
});

// Covers: MEM-135
// Requirement: see file header (S5 list carries no turn cue; map still renders).
describe("S5 route view renders no turn cue for a legacy taps.turn (MEM-135)", () => {
  test("station rows are plain names, no 'then left/right'; map has one node per station", async (t) => {
    const rejections = watchRejections(t);
    const b = boot({ routes: createRouteStore(seeded()) });
    const card = () => findAll(el(b, "routes-list"), (n) => n.tagName === "LI", { visibleOnly: true })[0];
    await until(() => card(), "route card on S1", TURNS);
    b.p.fire(find(card(), (n) => n.tagName === "BUTTON" && n.dataset.action === "open"), "click");
    await until(() => !el(b, "route-view").hidden, "#route-view shown", TURNS);
    await settle(20);
    const rows = findAll(el(b, "route-view-stations"), (n) => n.tagName === "LI");
    assert.equal(rows.length, NAMES.length);
    for (const li of rows) assert.equal(/\bthen\b|\b(left|right|straight)\b/i.test(visibleText(li)), false, visibleText(li));
    const svg = el(b, "route-map");
    assert.equal(findAll(svg, (n) => n !== svg && n.dataset?.stationId !== undefined).length, NAMES.length);
    assert.deepEqual(rejections, []);
  });
});
