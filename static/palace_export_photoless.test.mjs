// Covers: MEM-054, MEM-077
// Requirement: Export backup works after Load demo. The Kendall demo route (static/demo_route.js
// DEMO_ROUTE, MEM-077) is seeded through route_store seedRoute as a saved route of named stations
// that have no stored photo. Export (MEM-054) must still succeed with that route in the store, the
// file it writes must re-import (every export must re-import), and it must carry no coordinates even
// though the demo stations hold coords in the store.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { PNG_1X1, dataUrl, makeJpeg, snapshot, stores } from "./backup_fixtures_test.mjs";
import { buildBackup, importBackup } from "./palace_export.js";
import { DEMO_ROUTE } from "./demo_route.js";
import { createRouteStore } from "./route_store.js";
import { RAW_CAMERA } from "./route_store_fakes_test.mjs";

const FORBIDDEN = /lat|lon|coord|captured|image_id|link/i;
const WITH_PHOTO = ["box", "id", "n", "name", "photo", "profile", "status", "taps"];
const NO_PHOTO = ["box", "id", "n", "name", "profile", "status", "taps"];
const NAMES = ["Red door", "Oak tree", "Stone bench"];

/** Every key anywhere in `v`. */
function allKeys(v, out = []) {
  if (Array.isArray(v)) v.forEach((x) => allKeys(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) out.push(k), allKeys(x, out);
  return out;
}

const keysSorted = (o) => Object.keys(o).sort();
const byId = (a, b) => (a.id < b.id ? -1 : 1);
const importObj = (obj, s) => importBackup(JSON.stringify(obj), s);

async function demoSeeded() {
  const s = stores();
  const seeded = await s.routes.seedRoute(DEMO_ROUTE);
  assert.ok(seeded, "seedRoute stores the demo route");
  return s;
}

/**
 * A saved 3-station route walked through the route store API (photo, box, profile, coords on each),
 * then the stored photo of station n = 2 removed and the store reloaded: one photo-less station
 * between two with photos. Returns the route id.
 */
async function mixedRoute(s) {
  const r = await s.routes.createRoute({ name: "Mixed walk", kind: "daily" });
  for (const [i, name] of NAMES.entries()) {
    const st = await s.routes.addStation(r.id, { photo: RAW_CAMERA.slice(), coords: { lat: 51.5012 + i / 1000, lon: -0.1419 } });
    await s.routes.nameStation(r.id, st.id, {
      name,
      profile: { visual: `a ${name.toLowerCase()}`, spatial: "left of the path", conceptual: "entry" },
      box: { x1: 100, y1: 200, x2: 612, y2: 968 },
      photo: makeJpeg(2048, 1536, { exif: true, body: 400, fill: 0x40 + i }),
    });
  }
  await s.routes.finishSave(r.id, { name: "Mixed walk", kind: "daily" });
  const stored = s.routeAdapter.map.get(`route:${r.id}`);
  assert.ok(stored?.route, `route store keeps route ${r.id} under route:${r.id}`);
  const ref = stored.route.stations.find((st) => st.n === 2).photo_ref;
  assert.ok(s.routeAdapter.map.delete(`photo:${ref}`), "station 2 had a stored photo to remove");
  s.routes = createRouteStore(s.routeAdapter);
  return r.id;
}

/** The exported mixed route: {file, route, bare (the photo-less station)}. */
async function mixedFile() {
  const s = stores();
  await mixedRoute(s);
  const file = await buildBackup(s);
  const route = file.routes[0];
  return { file, route, bare: route.stations.find((st) => st.n === 2) };
}

/** A copy of `file` with station n of route 0 changed by `fn`. */
function withStation(file, n, fn) {
  const f = structuredClone(file);
  fn(f.routes[0].stations.find((st) => st.n === n));
  return f;
}

describe("backup export with the photo-less Kendall demo route seeded", () => {
  test("buildBackup does not throw", async () => {
    const s = await demoSeeded();
    await assert.doesNotReject(() => buildBackup(s));
  });

  test("the exported file re-imports into an empty store", async () => {
    const s = await demoSeeded();
    const file = await buildBackup(s);
    const fresh = stores();
    await assert.doesNotReject(() => importBackup(JSON.stringify(file), fresh));
  });

  test("the exported file carries no coordinate keys", async () => {
    const s = await demoSeeded();
    const file = await buildBackup(s);
    assert.deepEqual(allKeys(file).filter((k) => FORBIDDEN.test(k)), []);
  });
});

// Covers: MEM-054, MEM-077
// Requirement: a station photo is optional in backup v2 (ADR 0043; Kev: photos are encouraged, never
// required, and a missing one must not crash). Export: a station with no stored photo omits the
// photo key and exports box null (no thumbnail to bound it), while a station with a photo keeps all
// 8 keys; no coordinate key ever appears. Import: a station may come with or without photo; without
// it the box must be null (a box with nothing to bound it is refused); a present photo must still be
// a decodable data:image/jpeg;base64 URL (null, png, javascript:, undecodable refused); unknown and
// coordinate keys are still refused. Any refusal refuses the whole file and writes nothing.
// export -> import -> export keeps every station's key set and the whole file deep-equal.
describe("backup v2 with photo-less stations (photo optional)", () => {
  test("mixed export: photo-less station has no photo key and box null; the photo station keeps 8 keys", async () => {
    const { file, route, bare } = await mixedFile();
    assert.equal(route.stations.length, 3, "the photo-less station is exported, not dropped");
    assert.deepEqual(keysSorted(bare), NO_PHOTO);
    assert.equal(bare.box, null, "no thumbnail, so no box");
    assert.equal(bare.name, NAMES[1]);
    assert.deepEqual(bare.profile, { visual: "a oak tree", spatial: "left of the path", conceptual: "entry" });
    for (const st of route.stations.filter((x) => x.n !== 2)) {
      assert.deepEqual(keysSorted(st), WITH_PHOTO);
      assert.match(st.photo, /^data:image\/jpeg;base64,/);
      assert.ok(st.box, "a station with a photo keeps its scaled box");
    }
    assert.deepEqual(allKeys(file).filter((k) => FORBIDDEN.test(k)), [], "0 coordinate keys");
  });

  test("demo export: every photo-less demo station has no photo key and box null", async () => {
    const s = await demoSeeded();
    const file = await buildBackup(s);
    const demo = file.routes.find((r) => r.id === DEMO_ROUTE.id);
    assert.ok(demo, "the demo route is in the backup");
    assert.equal(demo.stations.length, DEMO_ROUTE.stations.length);
    for (const st of demo.stations) {
      assert.deepEqual(keysSorted(st), NO_PHOTO);
      assert.equal(st.box, null);
    }
  });

  test("import of a photo-less station restores it with no photo", async () => {
    const { file, route } = await mixedFile();
    const dst = stores();
    assert.deepEqual(await importObj(file, dst), { added: 1, present: 0, skipped: 0 });
    const restored = (await dst.routes.listRoutes()).find((r) => r.id === route.id);
    assert.ok(restored, "imported route listed");
    assert.equal(restored.status, "saved");
    assert.deepEqual(restored.stations.map((st) => st.name), NAMES);
    const bare = restored.stations.find((st) => st.n === 2);
    assert.equal(await dst.routes.getPhoto(bare.photo_ref), null, "no photo stored for the photo-less station");
    assert.ok(!bare.box, "no box restored for the photo-less station");
    for (const st of restored.stations.filter((x) => x.n !== 2)) {
      assert.ok(await dst.routes.getPhoto(st.photo_ref), `station ${st.n} keeps its photo`);
    }
  });

  test("import accepts a station whose photo key is dropped from a photo-bearing file (box null)", async () => {
    const { file } = await mixedFile();
    const f = withStation(file, 1, (st) => {
      delete st.photo;
      st.box = null;
    });
    const dst = stores();
    assert.deepEqual(await importObj(f, dst), { added: 1, present: 0, skipped: 0 });
  });

  const refused = {
    "photo-less station with a non-null box": (st) => void (st.box = { x1: 0, y1: 0, x2: 10, y2: 10 }),
    "photo null": (st) => void (st.photo = null),
    "photo data:image/png": (st) => void (st.photo = dataUrl(PNG_1X1, "image/png")),
    "photo javascript:": (st) => void (st.photo = "javascript:alert(1)"),
    "photo undecodable JPEG": (st) => void (st.photo = dataUrl(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))),
    "photo-less station with an unknown key": (st) => void (st.note = "x"),
    "photo-less station with coords": (st) => void (st.coords = { lat: 51.5, lon: -0.14 }),
    "photo-less station with a lat key": (st) => void (st.lat = 51.5),
  };
  for (const [name, fn] of Object.entries(refused)) {
    test(`import refused: ${name}; nothing written`, async () => {
      const { file } = await mixedFile();
      const f = withStation(file, 2, fn);
      const s = stores();
      const before = snapshot(s);
      await assert.rejects(importObj(f, s), Error);
      assert.deepEqual(snapshot(s), before, "store unchanged");
      assert.ok(s.loadCalls.every((src) => src.startsWith("data:image/jpeg;base64,")), "only JPEG data URLs reach loadImage");
    });
  }

  test("round trip export -> import -> export keeps every station's keys and the whole file", async () => {
    const src = stores();
    await mixedRoute(src);
    await src.routes.seedRoute(DEMO_ROUTE);
    const first = await buildBackup(src);
    const dst = stores();
    await importObj(first, dst);
    const second = await buildBackup(dst);
    const shape = (file) => [...file.routes].sort(byId).map((r) => r.stations.map(keysSorted));
    assert.deepEqual(shape(second), shape(first));
    assert.deepEqual({ ...second, routes: [...second.routes].sort(byId) }, { ...first, routes: [...first.routes].sort(byId) });
  });
});
