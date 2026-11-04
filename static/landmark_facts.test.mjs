// Covers: MEM-120
// Requirement: each demo landmark carries at most 3 short, cited facts, and the user can generate, edit and
// replace its multisensory connections ({ taps, profile }, the MEM-087 station shape), persisted through the
// storage adapter so a reload returns the edited connections.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { DEMO_ROUTE } from "./demo_route.js";
import { LANDMARK_FACTS, createConnectionStore, defaultGenerate, factsFor } from "./landmark_facts.js";
import { TAP_GROUPS } from "./station_card.js";
import { memoryAdapter } from "./route_store_fakes_test.mjs";

const TAP_KEYS = ["sound", "smell", "feel", "mood"];
const PROFILE_KEYS = ["visual", "spatial", "conceptual"];
const [S1, S2] = DEMO_ROUTE.stations;

describe("factsFor (MEM-120)", () => {
  test("every demo station has 1-3 facts with text, a title and an https URL", () => {
    for (const s of DEMO_ROUTE.stations) {
      const facts = factsFor(s.id);
      assert.ok(facts.length >= 1 && facts.length <= 3, `station ${s.n}: ${facts.length} facts`);
      for (const f of facts) {
        assert.ok(f.text.trim().length > 0, `station ${s.n}: empty text`);
        assert.ok(f.title.trim().length > 0, `station ${s.n}: empty title`);
        assert.equal(new URL(f.url).protocol, "https:", f.url);
      }
    }
  });

  test("the seeded table only keys demo stations", () => {
    const ids = new Set(DEMO_ROUTE.stations.map((s) => s.id));
    for (const id of Object.keys(LANDMARK_FACTS)) assert.ok(ids.has(id), id);
  });

  test("a 4th fact in the table is never returned", () => {
    const fact = (n) => ({ text: `fact ${n}`, title: `Source ${n}`, url: `https://example.org/${n}` });
    const table = { x: [fact(1), fact(2), fact(3), fact(4)] };
    const got = factsFor("x", table);
    assert.equal(got.length, 3);
    assert.deepEqual(
      got.map((f) => f.text),
      ["fact 1", "fact 2", "fact 3"],
    );
  });

  test("an unknown station gets []", () => {
    assert.deepEqual(factsFor("no-such-station"), []);
    assert.deepEqual(factsFor(undefined), []);
    assert.deepEqual(factsFor("toString"), []);
  });

  test("returned facts are copies", () => {
    factsFor(S1.id)[0].text = "mutated";
    assert.notEqual(factsFor(S1.id)[0].text, "mutated");
  });
});

describe("connections (MEM-120)", () => {
  test("default generator derives taps from seeded taps and conceptual from the first fact", () => {
    const conn = defaultGenerate(S1);
    assert.deepEqual(Object.keys(conn.taps).sort(), [...TAP_KEYS].sort());
    for (const k of TAP_KEYS) assert.ok(TAP_GROUPS[k].includes(conn.taps[k]), `${k}=${conn.taps[k]}`);
    assert.deepEqual(conn.taps, S1.taps);
    assert.notEqual(conn.taps, S1.taps);
    assert.deepEqual(Object.keys(conn.profile).sort(), [...PROFILE_KEYS].sort());
    assert.equal(conn.profile.visual, S1.profile.visual);
    assert.ok(conn.profile.conceptual.includes(factsFor(S1.id)[0].text.slice(0, 40)));
    for (const k of PROFILE_KEYS) assert.ok(conn.profile[k].length > 0 && conn.profile[k].length <= 200);
  });

  test("generate persists through adapter.put and get reads it back", async () => {
    const adapter = memoryAdapter();
    const store = createConnectionStore(adapter);
    const conn = await store.generate(S1);
    assert.deepEqual(await store.get(S1.id), conn);
    assert.ok(adapter.map.has(`connections:${S1.id}`));
    assert.equal(await store.get(S2.id), null);
  });

  test("an injected generator replaces the default", async () => {
    const calls = [];
    const generate = (station) => {
      calls.push(station.id);
      return {
        taps: { sound: "Birds", smell: "Coffee", feel: "Warm", mood: "Calm" },
        profile: { visual: "v", spatial: "s", conceptual: "c" },
      };
    };
    const store = createConnectionStore(memoryAdapter(), { generate });
    const conn = await store.generate(S2);
    assert.deepEqual(calls, [S2.id]);
    assert.equal(conn.taps.sound, "Birds");
  });

  test("edit merges, replace overwrites, and a reload returns the edited connections", async () => {
    const adapter = memoryAdapter();
    const store = createConnectionStore(adapter);
    await store.generate(S1);
    const edited = await store.edit(S1.id, { taps: { sound: "Music" }, profile: { conceptual: "My own link" } });
    assert.equal(edited.taps.sound, "Music");
    assert.equal(edited.taps.smell, S1.taps.smell);
    assert.equal(edited.profile.conceptual, "My own link");
    assert.equal(edited.profile.visual, S1.profile.visual);

    const reloaded = createConnectionStore(adapter);
    assert.deepEqual(await reloaded.get(S1.id), edited);

    const next = {
      taps: { sound: "Water", smell: "Rain", feel: "Cold", mood: "Odd" },
      profile: { visual: "A", spatial: "B", conceptual: "C" },
    };
    await reloaded.replace(S1.id, next);
    assert.deepEqual(await createConnectionStore(adapter).get(S1.id), next);
  });

  test("bad values are refused before any write", async () => {
    const adapter = memoryAdapter();
    const store = createConnectionStore(adapter);
    const before = await store.generate(S1);
    await assert.rejects(store.edit(S1.id, { taps: { sound: "Dragons" } }));
    await assert.rejects(store.edit(S1.id, { taps: { turn: "Left" } }));
    await assert.rejects(store.edit(S1.id, { profile: { visual: "" } }));
    await assert.rejects(store.edit(S1.id, { profile: { visual: "x".repeat(201) } }));
    await assert.rejects(store.replace(S1.id, { taps: {}, profile: {} }));
    await assert.rejects(store.edit(S2.id, { taps: { sound: "Music" } }), /generate/i);
    assert.deepEqual(await store.get(S1.id), before);
  });
});
