// Covers: MEM-139
// Requirement: a station saved before MEM-135 may still carry a legacy taps.turn; generating its connections
// must not fail. Generation keeps only the four card taps (sound, smell, feel, mood), drops any other tap key,
// and leaves the stored station object untouched (stored user data is never deleted).
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { DEMO_ROUTE } from "./demo_route.js";
import { createConnectionStore, defaultGenerate } from "./landmark_facts.js";
import { memoryAdapter } from "./route_store_fakes_test.mjs";

const [S1] = DEMO_ROUTE.stations;
const legacyStation = () => ({ ...S1, taps: { ...S1.taps, turn: "Left" } });
const validTaps = { sound: S1.taps.sound, smell: S1.taps.smell, feel: S1.taps.feel, mood: S1.taps.mood };

describe("legacy taps.turn on generate (MEM-139)", () => {
  test("defaultGenerate drops turn and keeps the four valid taps", () => {
    const conn = defaultGenerate(legacyStation());
    assert.equal(Object.hasOwn(conn.taps, "turn"), false, "turn must be dropped");
    assert.deepEqual(conn.taps, validTaps);
  });

  test("store.generate resolves and stored connections have no turn", async () => {
    const store = createConnectionStore(memoryAdapter());
    const conn = await store.generate(legacyStation());
    assert.deepEqual(conn.taps, validTaps);
    const stored = await store.get(S1.id);
    assert.equal(Object.hasOwn(stored.taps, "turn"), false);
    assert.deepEqual(stored.taps, validTaps);
  });

  test("generation does not mutate the input station", async () => {
    const station = legacyStation();
    defaultGenerate(station);
    await createConnectionStore(memoryAdapter()).generate(station).catch(() => {});
    assert.equal(station.taps.turn, "Left");
    assert.deepEqual(station.taps, { ...validTaps, turn: "Left" });
  });
});
