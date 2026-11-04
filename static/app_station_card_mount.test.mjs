// Covers: MEM-110
// Requirement: the MEM-110 seeded multisensory taps are visible in the app. Load demo opens the Kendall demo
// route (MEM-072); the route view then mounts the S3 station card (static/station_card.js, MEM-050) for the
// selected station: #station-card is shown for the first station on open (no li is marked aria-current until
// the user selects one: MEM-088 pins an unselected list on open), #station-name holds its name, #station-profile its profile, and #station-tap-summary
// lists one li per tap group the station has a value for, in TAP_GROUPS order, reading "<Group>: <label>"
// (Sound, Smell, Feel, Mood, Next turn). The editor buttons in #tap-<group> mark the seeded label
// aria-pressed="true". Clicking a station li (or a map marker, MEM-088) selects that station and the card
// follows, so every demo station shows its seeded taps. A station without taps renders no group in
// #station-tap-summary (no children, hidden); a station with some taps lists only those groups. The S5 list
// li text stays the plain station name (MEM-077). A stored name that only breaks the <= 3 word shape rule (the
// seeded demo titles) shows no #station-name-error on arrival (a clash still does, MEM-050). Leaving the route (Back to routes) hides the card.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { boot, el, find, findAll, kvAdapter, loadDemo, settle, TURNS, until, watchRejections } from "./ux_flow_harness_test.mjs";
import { memoryAdapter } from "./route_store_fakes_test.mjs";
import { createRouteStore } from "./route_store.js";
import { DEMO_ROUTE } from "./demo_route.js";

const FIXTURE = { status: "ok", mode: "fixture" };
const GROUP_LABEL = { sound: "Sound", smell: "Smell", feel: "Feel", mood: "Mood", turn: "Next turn" };
const ORDER = ["sound", "smell", "feel", "mood", "turn"];
const want = (taps) => ORDER.filter((g) => taps?.[g]).map((g) => `${GROUP_LABEL[g]}: ${taps[g]}`);

const lis = (b, id) => findAll(el(b, id), (n) => n.tagName === "LI");
const summary = (b) => lis(b, "station-tap-summary").map((li) => li.textContent);
const pressed = (b, group) => findAll(el(b, `tap-${group}`), (n) => n.tagName === "BUTTON")
  .filter((btn) => btn.getAttribute("aria-pressed") === "true").map((btn) => btn.textContent);

async function demoBooted() {
  const routes = createRouteStore(memoryAdapter());
  const b = boot({ routes, realMap: { mount: () => Promise.resolve(null) }, rehAdapter: kvAdapter(), health: FIXTURE });
  await loadDemo(b);
  await until(() => !el(b, "route-view").hidden, "#route-view shown by Load demo", TURNS);
  await settle(20);
  return b;
}

async function select(b, i) {
  b.p.fire(lis(b, "route-view-stations")[i], "click");
  await settle(20);
}

// Covers: MEM-110
// Requirement: see file header (Load demo shows the station card with the seeded taps of each demo station).
describe("Load demo mounts the station card with the MEM-110 seeded taps", () => {
  test("after Load demo #station-card shows station 1 with its seeded taps", async (t) => {
    const rejections = watchRejections(t);
    const b = await demoBooted();
    await until(() => !el(b, "station-card").hidden, "#station-card shown after Load demo", TURNS);
    const s1 = DEMO_ROUTE.stations[0];
    assert.equal(el(b, "station-name").value, s1.name);
    assert.deepEqual(summary(b), want(s1.taps));
    assert.equal(el(b, "station-tap-summary").hidden, false);
    for (const g of ["sound", "smell", "feel", "mood"]) assert.deepEqual(pressed(b, g), [s1.taps[g]], `#tap-${g} pressed`);
    assert.ok(el(b, "station-profile").textContent.includes(s1.profile.visual), "profile shown");
    // The long seeded titles predate the <= 3 word rule: not flagged on arrival, only once edited.
    assert.equal(el(b, "station-name-error").hidden, true, "no name error on arrival for a seeded title");
    assert.deepEqual(rejections, []);
  });

  test("selecting each demo station shows its own seeded taps; S5 li text stays plain (MEM-077)", async () => {
    const b = await demoBooted();
    for (let i = 0; i < DEMO_ROUTE.stations.length; i++) {
      const s = DEMO_ROUTE.stations[i];
      await select(b, i);
      assert.equal(el(b, "station-name").value, s.name, `station ${i + 1} name`);
      assert.deepEqual(summary(b), want(s.taps), `station ${i + 1} summary`);
      assert.deepEqual(lis(b, "route-view-stations").map((li) => li.getAttribute("aria-current")),
        DEMO_ROUTE.stations.map((_, j) => (j === i ? "true" : null)), `only li ${i + 1} selected`);
    }
    assert.deepEqual(lis(b, "route-view-stations").map((li) => li.textContent), DEMO_ROUTE.stations.map((s) => s.name));
  });

  test("a map marker click moves the card too (MEM-088)", async () => {
    const b = await demoBooted();
    const s4 = DEMO_ROUTE.stations[3];
    const map = el(b, "route-map");
    const node = find(map, (n) => n !== map && n.dataset?.stationId === s4.id);
    assert.ok(node, "marker for station 4");
    b.p.fire(node, "click");
    await settle(20);
    assert.equal(el(b, "station-name").value, s4.name);
    assert.deepEqual(summary(b), want(s4.taps));
  });

  test("Back to routes hides the card", async () => {
    const b = await demoBooted();
    await until(() => !el(b, "station-card").hidden, "#station-card shown", TURNS);
    const back = find(el(b, "route-view"), (n) => n.tagName === "BUTTON" && n.textContent === "Back to routes");
    b.p.fire(back, "click");
    await settle(20);
    assert.equal(el(b, "station-card").hidden, true);
  });
});

// Covers: MEM-110
// Requirement: a station without taps renders no empty group; partial taps list only their groups.
describe("station card tap summary renders no empty group (MEM-110)", () => {
  const ROUTE = {
    id: "rtap", name: "Tap walk", kind: "daily",
    stations: [
      { id: "rtap-1", n: 1, name: "red bench", coords: { lat: 42.36238, lon: -71.0856 } },
      { id: "rtap-2", n: 2, name: "old oak", coords: { lat: 42.36265, lon: -71.08441 }, taps: { sound: "Birds" } },
    ],
  };

  async function openSeeded() {
    const routes = createRouteStore(kvAdapter());
    await routes.seedRoute(ROUTE);
    const b = boot({ routes, realMap: { mount: () => Promise.resolve(null) }, rehAdapter: kvAdapter(), health: FIXTURE });
    await until(() => lis(b, "routes-list").some((li) => li.textContent.includes(ROUTE.name)), "Tap walk card", TURNS);
    const card = lis(b, "routes-list").find((li) => li.textContent.includes(ROUTE.name));
    b.p.fire(find(card, (n) => n.tagName === "BUTTON" && n.dataset.action === "open"), "click");
    await until(() => !el(b, "station-card").hidden, "#station-card shown on open", TURNS);
    await settle(20);
    return b;
  }

  test("no-taps station: #station-tap-summary has no children and is hidden", async () => {
    const b = await openSeeded();
    assert.equal(el(b, "station-name").value, "red bench");
    assert.equal(el(b, "station-tap-summary").children.length, 0);
    assert.equal(el(b, "station-tap-summary").hidden, true);
  });

  test("partial taps: only the set group is listed", async () => {
    const b = await openSeeded();
    await select(b, 1);
    assert.deepEqual(summary(b), ["Sound: Birds"]);
    assert.equal(el(b, "station-tap-summary").hidden, false);
  });
});
