// Covers: MEM-110
// Requirement: the seeded Kendall demo route shows Kev's photo-derived multisensory data with no import step.
// Each of the 6 DEMO_ROUTE stations carries `taps` (exactly sound, smell, feel, mood, turn; each value one of the
// station card's TAP_GROUPS labels) and a `profile` (exactly visual, spatial, conceptual; each a trimmed,
// non-empty, printable-ASCII line of at most 200 chars, the backup LINE_MAX / MAX_STATION_LINE). "Load demo"
// (route_store seedRoute) persists both, so getRoute and a reloaded store return them equal to the demo data,
// as copies: mutating a returned route never touches DEMO_ROUTE.
// Contract (RED; GREEN adds taps + profile to each station in static/demo_route.js and has seedRoute keep them):
//   n 1 Traffic/Fumes/Stairs/Busy/Straight; 2 Traffic/Coffee/Windy/Grand/Left; 3 Voices/Food/Shade/Cosy/Straight;
//   4 Quiet/None/Cold/Calm/Straight; 5 Traffic/Rain/Windy/Odd/Right; 6 Voices/Flowers/Shade/Bright/Arrive.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { DEMO_ROUTE } from "./demo_route.js";
import { createRouteStore } from "./route_store.js";
import { TAP_GROUPS } from "./station_card.js";
import { memoryAdapter } from "./route_store_fakes_test.mjs";

const TAP_KEYS = ["sound", "smell", "feel", "mood", "turn"];
const PROFILE_KEYS = ["visual", "spatial", "conceptual"];
const LINE_MAX = 200;

const WANT_TAPS = {
  1: { sound: "Traffic", smell: "Fumes", feel: "Stairs", mood: "Busy", turn: "Straight" },
  2: { sound: "Traffic", smell: "Coffee", feel: "Windy", mood: "Grand", turn: "Left" },
  3: { sound: "Voices", smell: "Food", feel: "Shade", mood: "Cosy", turn: "Straight" },
  4: { sound: "Quiet", smell: "None", feel: "Cold", mood: "Calm", turn: "Straight" },
  5: { sound: "Traffic", smell: "Rain", feel: "Windy", mood: "Odd", turn: "Right" },
  6: { sound: "Voices", smell: "Flowers", feel: "Shade", mood: "Bright", turn: "Arrive" },
};

describe("demo route multisensory taps + profile (MEM-110)", () => {
  test("precondition: the demo route has 6 stations numbered 1..6", () => {
    assert.deepEqual(DEMO_ROUTE.stations.map((s) => s.n), [1, 2, 3, 4, 5, 6]);
  });

  test("every station has taps with exactly the 5 keys, each a TAP_GROUPS label", () => {
    for (const s of DEMO_ROUTE.stations) {
      assert.ok(s.taps && typeof s.taps === "object", `station ${s.n} has taps`);
      assert.deepEqual(Object.keys(s.taps).sort(), [...TAP_KEYS].sort(), `station ${s.n} tap keys`);
      for (const key of TAP_KEYS) {
        assert.ok(TAP_GROUPS[key].includes(s.taps[key]), `station ${s.n} ${key} "${s.taps[key]}" in ${TAP_GROUPS[key]}`);
      }
    }
  });

  test("exact taps per station", () => {
    assert.deepEqual(Object.fromEntries(DEMO_ROUTE.stations.map((s) => [s.n, s.taps])), WANT_TAPS);
  });

  test("every station has profile with exactly visual, spatial, conceptual: trimmed printable-ASCII lines <= 200 chars", () => {
    for (const s of DEMO_ROUTE.stations) {
      assert.ok(s.profile && typeof s.profile === "object", `station ${s.n} has profile`);
      assert.deepEqual(Object.keys(s.profile).sort(), [...PROFILE_KEYS].sort(), `station ${s.n} profile keys`);
      for (const key of PROFILE_KEYS) {
        const v = s.profile[key];
        assert.equal(typeof v, "string", `station ${s.n} ${key} is a string`);
        assert.ok(v.trim() !== "", `station ${s.n} ${key} non-empty`);
        assert.equal(v, v.trim(), `station ${s.n} ${key} is trimmed`);
        assert.ok(v.length <= LINE_MAX, `station ${s.n} ${key} length ${v.length}`);
        assert.match(v, /^[\x20-\x7E]+$/, `station ${s.n} ${key} printable ASCII`);
      }
    }
  });

  test("seedRoute persists taps + profile per station; a reloaded store returns the same", async () => {
    const kv = memoryAdapter();
    const store = createRouteStore(kv);
    await store.seedRoute(DEMO_ROUTE);
    const got = await store.getRoute(DEMO_ROUTE.id);
    assert.equal(got.stations.length, DEMO_ROUTE.stations.length);
    got.stations.forEach((s, i) => {
      assert.ok(DEMO_ROUTE.stations[i].taps, `DEMO_ROUTE station ${i + 1} has taps`);
      assert.deepEqual(s.taps, DEMO_ROUTE.stations[i].taps, `station ${i + 1} taps`);
      assert.deepEqual(s.profile, DEMO_ROUTE.stations[i].profile, `station ${i + 1} profile`);
    });
    const reloaded = await createRouteStore(kv).getRoute(DEMO_ROUTE.id);
    reloaded.stations.forEach((s, i) => {
      assert.deepEqual(s.taps, DEMO_ROUTE.stations[i].taps, `reloaded station ${i + 1} taps`);
      assert.deepEqual(s.profile, DEMO_ROUTE.stations[i].profile, `reloaded station ${i + 1} profile`);
    });
  });

  test("stored taps + profile are copies: mutating a returned route leaves DEMO_ROUTE untouched", async () => {
    const store = createRouteStore(memoryAdapter());
    await store.seedRoute(DEMO_ROUTE);
    const before = JSON.stringify(DEMO_ROUTE.stations.map((s) => [s.taps, s.profile]));
    const got = await store.getRoute(DEMO_ROUTE.id);
    assert.ok(got.stations[0].taps, "seeded station has taps to mutate");
    got.stations[0].taps.sound = "Birds";
    got.stations[0].profile.visual = "changed";
    assert.equal(JSON.stringify(DEMO_ROUTE.stations.map((s) => [s.taps, s.profile])), before);
    assert.notEqual(DEMO_ROUTE.stations[0].taps, got.stations[0].taps, "taps object is not shared");
  });

  test("existing seeded fields unchanged: 6 stations, ids and names as DEMO_ROUTE", async () => {
    const store = createRouteStore(memoryAdapter());
    await store.seedRoute(DEMO_ROUTE);
    const got = await store.getRoute(DEMO_ROUTE.id);
    assert.equal(got.stations.length, 6);
    assert.deepEqual(got.stations.map((s) => s.id), DEMO_ROUTE.stations.map((s) => s.id));
    assert.deepEqual(got.stations.map((s) => s.name), DEMO_ROUTE.stations.map((s) => s.name));
  });
});
