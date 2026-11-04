// Covers: MEM-134
// Requirement: a station's emoji tags (emojis: string[], emojisEdited: boolean) persist on the phone and
// survive a backup. static/route_store.js setStationEmojis(routeId, stationId, emojis, { edited = true })
// stores normalizeEmojis(emojis) (trimmed non-empty strings of at most 16 UTF-16 units, deduped, capped at 6)
// and sets emojisEdited = edited || the stored emojisEdited, so an auto save never clears a user edit;
// restoreRoute (backup import) and seedRoute (demo seed) copy emojis and emojisEdited. static/backup_routes.js
// exportRoutes writes emojis / emojisEdited only when the station has them, importRoutes accepts them as
// optional keys (an array of 0-6 non-empty strings of at most 16 units; a boolean), refuses any other type
// with a "bad station" error, and still imports a station without them (older backups).
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { createRouteStore } from "./route_store.js";
import { exportRoutes, importRoutes } from "./backup_routes.js";
import { memoryAdapter, ENCODED } from "./route_store_fakes_test.mjs";

const BIRD = "\u{1F426}";
const COFFEE = "\u{2615}";
const CALM = "\u{1F60C}";
const RAIN = "\u{1F327}\u{FE0F}";
const SEVEN = ["\u{1F426}", "\u{2615}", "\u{1F60C}", "\u{1F697}", "\u{1F4A7}", "\u{1F92B}", "\u{1F3B5}"];

const uuid = (i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const CREATED = "2026-11-04T09:00:00.000Z";

async function stationOn(store) {
  const route = await store.createRoute({ name: "Morning loop", kind: "daily" });
  const st = await store.addStation(route.id, { photo: ENCODED.slice() });
  return { routeId: route.id, stationId: st.id };
}

async function storedStation(kv, routeId, stationId) {
  const route = await createRouteStore(kv).getRoute(routeId);
  return route.stations.find((s) => s.id === stationId);
}

// Covers: MEM-134
// Requirement: setStationEmojis persists the normalized list, defaults to a user edit, and an auto save
// (edited false) never clears an earlier user edit; a reload reads back the same tags.
describe("route store: setStationEmojis", () => {
  test("defaults to edited true and persists across a reload", async () => {
    const kv = memoryAdapter();
    const { routeId, stationId } = await stationOn(createRouteStore(kv));
    const store = createRouteStore(kv);
    await store.setStationEmojis(routeId, stationId, [BIRD, COFFEE]);
    const st = await storedStation(kv, routeId, stationId);
    assert.deepEqual(st.emojis, [BIRD, COFFEE]);
    assert.equal(st.emojisEdited, true);
  });

  test("stores normalized emojis: trimmed, empties and over-16-unit strings dropped, deduped", async () => {
    const kv = memoryAdapter();
    const store = createRouteStore(kv);
    const { routeId, stationId } = await stationOn(store);
    await store.setStationEmojis(routeId, stationId, [` ${BIRD} `, "", "   ", BIRD, "x".repeat(17), 5, COFFEE]);
    const st = await storedStation(kv, routeId, stationId);
    assert.deepEqual(st.emojis, [BIRD, COFFEE]);
  });

  test("keeps a 16-unit string and caps the list at 6", async () => {
    const kv = memoryAdapter();
    const store = createRouteStore(kv);
    const { routeId, stationId } = await stationOn(store);
    const sixteen = "y".repeat(16);
    await store.setStationEmojis(routeId, stationId, [sixteen, ...SEVEN]);
    const st = await storedStation(kv, routeId, stationId);
    assert.deepEqual(st.emojis, [sixteen, ...SEVEN.slice(0, 5)]);
  });

  test("an auto save with edited false on an unedited station stores emojisEdited false", async () => {
    const kv = memoryAdapter();
    const store = createRouteStore(kv);
    const { routeId, stationId } = await stationOn(store);
    await store.setStationEmojis(routeId, stationId, [CALM], { edited: false });
    const st = await storedStation(kv, routeId, stationId);
    assert.deepEqual(st.emojis, [CALM]);
    assert.equal(st.emojisEdited, false);
  });

  test("a later save with edited false never clears an existing emojisEdited true", async () => {
    const kv = memoryAdapter();
    const store = createRouteStore(kv);
    const { routeId, stationId } = await stationOn(store);
    await store.setStationEmojis(routeId, stationId, [BIRD], { edited: true });
    await store.setStationEmojis(routeId, stationId, [BIRD, RAIN], { edited: false });
    const st = await storedStation(kv, routeId, stationId);
    assert.deepEqual(st.emojis, [BIRD, RAIN]);
    assert.equal(st.emojisEdited, true);
  });

  test("leaves the station's taps unchanged", async () => {
    const kv = memoryAdapter();
    const store = createRouteStore(kv);
    const { routeId, stationId } = await stationOn(store);
    await store.setStationTaps(routeId, stationId, { sound: "Birds", mood: "Calm" });
    await store.setStationEmojis(routeId, stationId, [BIRD]);
    const st = await storedStation(kv, routeId, stationId);
    assert.deepEqual(st.taps, { sound: "Birds", mood: "Calm" });
  });
});

const restoreInput = (stationExtra = {}) => ({
  id: uuid(100),
  name: "Morning loop",
  kind: "daily",
  created_at: CREATED,
  lists: [],
  stations: [1, 2, 3].map((n) => ({
    id: uuid(n), n, name: `Spot ${n}`, box: null, profile: null, taps: null,
    ...(n === 1 ? stationExtra : {}),
  })),
});

// Covers: MEM-134
// Requirement: a backup import (restoreRoute) and the demo seed (seedRoute) keep each station's emoji tags
// and its emojisEdited flag; stations without them still restore.
describe("route store: restoreRoute and seedRoute copy emojis", () => {
  test("restoreRoute copies emojis and emojisEdited, isolated from the input array", async () => {
    const kv = memoryAdapter();
    const store = createRouteStore(kv);
    const input = restoreInput({ emojis: [BIRD, COFFEE], emojisEdited: true });
    await store.restoreRoute(input);
    input.stations[0].emojis.push(CALM);
    const st = await storedStation(kv, uuid(100), uuid(1));
    assert.deepEqual(st.emojis, [BIRD, COFFEE]);
    assert.equal(st.emojisEdited, true);
  });

  test("restoreRoute keeps emojisEdited false as false", async () => {
    const kv = memoryAdapter();
    await createRouteStore(kv).restoreRoute(restoreInput({ emojis: [CALM], emojisEdited: false }));
    const st = await storedStation(kv, uuid(100), uuid(1));
    assert.deepEqual(st.emojis, [CALM]);
    assert.equal(st.emojisEdited, false);
  });

  test("restoreRoute still restores stations without emojis", async () => {
    const kv = memoryAdapter();
    const out = await createRouteStore(kv).restoreRoute(restoreInput());
    assert.notEqual(out, null);
    const route = await createRouteStore(kv).getRoute(uuid(100));
    assert.deepEqual(route.stations.map((s) => s.name), ["Spot 1", "Spot 2", "Spot 3"]);
  });

  test("seedRoute copies emojis and emojisEdited", async () => {
    const kv = memoryAdapter();
    await createRouteStore(kv).seedRoute({
      id: "demo-route",
      name: "Demo walk",
      kind: "daily",
      stations: [
        { id: "demo-1", n: 1, name: "Cafe", emojis: [COFFEE, BIRD], emojisEdited: true },
        { id: "demo-2", n: 2, name: "Park", emojis: [CALM], emojisEdited: false },
        { id: "demo-3", n: 3, name: "Gate" },
      ],
    });
    const a = await storedStation(kv, "demo-route", "demo-1");
    const b = await storedStation(kv, "demo-route", "demo-2");
    assert.deepEqual(a.emojis, [COFFEE, BIRD]);
    assert.equal(a.emojisEdited, true);
    assert.deepEqual(b.emojis, [CALM]);
    assert.equal(b.emojisEdited, false);
  });
});

// A photo-less saved route (ADR 0043) so export never calls the thumbnail and import never decodes.
function fakeRoutes(stationsExtra) {
  const route = {
    id: uuid(200), name: "Evening loop", kind: "occasional", status: "saved", created_at: CREATED, lists: [],
    stations: [1, 2, 3].map((n) => ({
      id: uuid(200 + n), n, name: `Stop ${n}`, photo_ref: `p${n}`, status: "named", ...(stationsExtra[n - 1] ?? {}),
    })),
  };
  return { listRoutes: async () => [structuredClone(route)], getPhoto: async () => null };
}

const noThumbnail = async () => {
  throw new Error("thumbnail must not be called for a photo-less station");
};
const noLoadImage = async () => {
  throw new Error("loadImage must not be called for a photo-less station");
};

const backupRoute = (stationExtra) => ({
  id: uuid(300),
  name: "Imported loop",
  kind: "daily",
  created_at: CREATED,
  lists: [],
  stations: [1, 2, 3].map((n) => ({
    id: uuid(300 + n), n, name: `Spot ${n}`, status: "named", box: null, profile: null, taps: null,
    ...(n === 1 ? stationExtra : {}),
  })),
});

// Covers: MEM-134
// Requirement: a backup carries each station's emoji tags (CRITERIA 6): export writes emojis / emojisEdited
// only when present, and an export then import into a fresh store gives back the same tags and flag.
describe("backup: station emojis export and round-trip", () => {
  test("export writes emojis and emojisEdited when present", async () => {
    const [out] = await exportRoutes(
      fakeRoutes([{ emojis: [BIRD, COFFEE], emojisEdited: true }, { emojis: [], emojisEdited: false }]),
      noThumbnail,
    );
    assert.deepEqual(out.stations[0].emojis, [BIRD, COFFEE]);
    assert.equal(out.stations[0].emojisEdited, true);
    assert.deepEqual(out.stations[1].emojis, []);
    assert.equal(out.stations[1].emojisEdited, false);
  });

  test("export omits emojis and emojisEdited when the station has neither", async () => {
    const [out] = await exportRoutes(fakeRoutes([{ emojis: [BIRD], emojisEdited: true }]), noThumbnail);
    assert.equal(Object.hasOwn(out.stations[2], "emojis"), false);
    assert.equal(Object.hasOwn(out.stations[2], "emojisEdited"), false);
  });

  test("export then import then restore round-trips emojis and emojisEdited", async () => {
    const exported = await exportRoutes(
      fakeRoutes([{ emojis: [BIRD, RAIN], emojisEdited: true }, { emojis: [CALM], emojisEdited: false }]),
      noThumbnail,
    );
    const [imported] = await importRoutes(exported, noLoadImage);
    assert.deepEqual(imported.stations[0].emojis, [BIRD, RAIN]);
    assert.equal(imported.stations[0].emojisEdited, true);
    const kv = memoryAdapter();
    await createRouteStore(kv).restoreRoute(imported);
    const a = await storedStation(kv, uuid(200), uuid(201));
    const b = await storedStation(kv, uuid(200), uuid(202));
    assert.deepEqual(a.emojis, [BIRD, RAIN]);
    assert.equal(a.emojisEdited, true);
    assert.deepEqual(b.emojis, [CALM]);
    assert.equal(b.emojisEdited, false);
  });
});

// Covers: MEM-134
// Requirement: import refuses a station whose emojis is not an array of 0-6 non-empty strings of at most 16
// UTF-16 units, or whose emojisEdited is not a boolean, in the existing "bad station" error style; a
// station without either key still imports (older backups).
describe("backup: station emojis import validation", () => {
  const badEmojis = [
    ["a string", BIRD],
    ["an object", { 0: BIRD }],
    ["a number entry", [5]],
    ["an empty-string entry", [""]],
    ["an entry over 16 units", ["z".repeat(17)]],
    ["7 entries", SEVEN],
  ];
  for (const [what, emojis] of badEmojis) {
    test(`refuses emojis as ${what}`, async () => {
      await assert.rejects(importRoutes([backupRoute({ emojis, emojisEdited: true })], noLoadImage), /bad station/);
    });
  }

  for (const [what, emojisEdited] of [["the string \"true\"", "true"], ["the number 1", 1]]) {
    test(`refuses emojisEdited as ${what}`, async () => {
      await assert.rejects(importRoutes([backupRoute({ emojis: [BIRD], emojisEdited })], noLoadImage), /bad station/);
    });
  }

  test("accepts 6 entries, a 16-unit entry and an empty list", async () => {
    const six = [...SEVEN.slice(0, 5), "q".repeat(16)];
    const [a] = await importRoutes([backupRoute({ emojis: six, emojisEdited: true })], noLoadImage);
    assert.deepEqual(a.stations[0].emojis, six);
    const [b] = await importRoutes([backupRoute({ emojis: [], emojisEdited: false })], noLoadImage);
    assert.deepEqual(b.stations[0].emojis, []);
    assert.equal(b.stations[0].emojisEdited, false);
  });

  test("a station without emojis or emojisEdited still imports", async () => {
    const [r] = await importRoutes([backupRoute({})], noLoadImage);
    assert.equal(r.stations.length, 3);
    assert.equal(r.stations[0].name, "Spot 1");
    assert.equal(r.stations[0].emojis, undefined);
  });
});
