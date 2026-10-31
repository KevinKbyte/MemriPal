// Covers: MEM-054
// Requirement: Backup v2 review fixes (plan B9, ADR 0033). Every file buildBackup writes re-imports
// cleanly (a saved route left with < 3 named stations, or a stored box with x1 > x2, is skipped or
// normalized at export rather than producing a file import refuses). Import is guarded against decode
// bombs: a photo whose JPEG SOF declares more than 4096 px on a side is refused before loadImage, and a
// file with more than 50 routes is refused before any photo is decoded. A file with routes on a page
// without a route store, or a route repeating a station n, is refused with nothing written; a route id
// repeated in one file is stored once (first wins). Associations and rehearsals are only written once
// the file's routes have persisted, so a failed route write leaves nothing behind and a retry adds all.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { backup, dataUrl, entry, fakeLoadImage, makeJpeg, rehearsal, snapshot, stores, uuid } from "./backup_fixtures_test.mjs";
import { createRouteStore } from "./route_store.js";
import { RAW_CAMERA } from "./route_store_fakes_test.mjs";

const { buildBackup, importBackup } = await import("./palace_export.js");

const importObj = (obj, s) => importBackup(JSON.stringify(obj), s);
const NAMES = ["Red door", "Oak tree", "Stone bench", "Blue gate"];

/** A saved route walked through the route store API with `named` 2048x1536 photos. */
async function seedRoute(s, { name = "Morning walk", named = 3 } = {}) {
  const r = await s.routes.createRoute({ name, kind: "daily" });
  for (let i = 0; i < named; i++) {
    const st = await s.routes.addStation(r.id, { photo: RAW_CAMERA.slice(), coords: { lat: 51.5, lon: -0.14 } });
    await s.routes.nameStation(r.id, st.id, {
      name: NAMES[i],
      profile: { visual: "v", spatial: "s", conceptual: "c" },
      box: { x1: 100, y1: 200, x2: 612, y2: 968 },
      photo: makeJpeg(2048, 1536, { exif: true, body: 400, fill: 0x40 + i }),
    });
  }
  await s.routes.finishSave(r.id, { name, kind: "daily" });
  return r.id;
}

/** Rewrites the stored route record and swaps in a fresh route store (a reload) over the adapter. */
function patchRoute(s, id, fn) {
  const rec = s.routeAdapter.map.get(`route:${id}`);
  assert.ok(rec?.route, `route store keeps route ${id} under route:${id}`);
  fn(rec.route);
  s.routes = createRouteStore(s.routeAdapter);
}

/** A valid one-route v2 file built from a real export. */
async function goodFile() {
  const s = stores();
  await seedRoute(s);
  return buildBackup(s);
}

const TINY = dataUrl(makeJpeg(64, 48));

/** A copy of `route` with a fresh route id, fresh station ids and tiny photos (keeps 50 routes under 8 MiB). */
const freshRoute = (route) => ({
  ...structuredClone(route), id: uuid(), stations: route.stations.map((st) => ({ ...st, id: uuid(), photo: TINY, box: null })),
});

// Covers: MEM-054
// Requirement: every exported backup re-imports: a saved route whose named stations fell below 3, or
// a station whose stored box has x1 > x2, is skipped or normalized at export, never written as a
// route the importer refuses.
describe("MEM-054 export always re-imports", () => {
  test("saved route with only 2 named stations left -> export re-imports, the good route intact", async () => {
    const s = stores();
    const good = await seedRoute(s, { name: "Good" });
    const thin = await seedRoute(s, { name: "Thin" });
    patchRoute(s, thin, (route) => void (route.stations[2].status = "error"));
    const file = await buildBackup(s);
    const dst = stores();
    await importObj(file, dst);
    assert.ok(await dst.routes.getRoute(good), "the valid route imported");
  });

  test("stored box with x1 > x2 -> export re-imports", async () => {
    const s = stores();
    const id = await seedRoute(s);
    patchRoute(s, id, (route) => void (route.stations[0].box = { x1: 1800, y1: 200, x2: 100, y2: 968 }));
    const file = await buildBackup(s);
    await importObj(file, stores());
  });
});

// Covers: MEM-054
// Requirement: decode-bomb guard: a station photo whose JPEG SOF declares a side over 4096 px is
// refused (message names 4096) before it reaches loadImage; exactly 4096 is accepted. A file with
// over 50 routes is refused (message names 50) before any photo is decoded; exactly 50 is accepted.
// The size cap fails closed: a photo with no readable JPEG size (no SOF before EOI/SOS) is refused
// with "station photo has no readable JPEG size" before loadImage, even if a lenient decoder would
// have accepted it.
describe("MEM-054 import: decode-bomb caps", () => {
  test("photo SOF 4097 x 100 -> refused before loadImage, nothing written", async () => {
    const big = dataUrl(makeJpeg(4097, 100));
    const file = await goodFile();
    Object.assign(file.routes[0].stations[0], { photo: big, box: null });
    const s = stores();
    const before = snapshot(s);
    await assert.rejects(importObj(file, s), (err) => /4096/.test(err.message));
    assert.ok(!s.loadCalls.includes(big), "oversized photo never handed to loadImage");
    assert.deepEqual(snapshot(s), before, "store unchanged");
  });

  test("photo SOF 100 x 4097 (tall) -> refused", async () => {
    const file = await goodFile();
    Object.assign(file.routes[0].stations[0], { photo: dataUrl(makeJpeg(100, 4097)), box: null });
    await assert.rejects(importObj(file, stores()), (err) => /4096/.test(err.message));
  });

  test("photo SOF exactly 4096 x 4096 -> accepted", async () => {
    const file = await goodFile();
    Object.assign(file.routes[0].stations[0], { photo: dataUrl(makeJpeg(4096, 4096)), box: null });
    assert.deepEqual(await importObj(file, stores()), { added: 1, present: 0, skipped: 0 });
  });

  test("photo with no readable JPEG size -> refused before loadImage, nothing written", async () => {
    // SOI then EOI: a JPEG data URL whose SOF size cannot be read.
    const sizeless = dataUrl(new Uint8Array([0xff, 0xd8, 0xff, 0xd9, 0x42, 0x42]));
    const file = await goodFile();
    Object.assign(file.routes[0].stations[0], { photo: sizeless, box: null });
    const s = stores();
    const lenient = { ...s, loadImage: async (src) => {
      s.loadCalls.push(src);
      return src === sizeless ? { naturalWidth: 100, naturalHeight: 100, width: 100, height: 100 } : fakeLoadImage(src);
    } };
    const before = snapshot(s);
    await assert.rejects(importObj(file, lenient), (err) => /station photo has no readable JPEG size/.test(err.message));
    assert.ok(!s.loadCalls.includes(sizeless), "sizeless photo never handed to loadImage");
    assert.deepEqual(snapshot(s), before, "store unchanged");
  });

  test("51 routes -> refused before any photo decodes, nothing written", async () => {
    const [route] = (await goodFile()).routes;
    const file = backup({ routes: Array.from({ length: 51 }, () => freshRoute(route)) });
    const s = stores();
    const before = snapshot(s);
    await assert.rejects(importObj(file, s), (err) => /\b50\b/.test(err.message));
    assert.equal(s.loadCalls.length, 0, "no photo decoded");
    assert.deepEqual(snapshot(s), before, "store unchanged");
  });

  test("exactly 50 routes -> accepted", async () => {
    const [route] = (await goodFile()).routes;
    const file = backup({ routes: Array.from({ length: 50 }, () => freshRoute(route)) });
    assert.deepEqual(await importObj(file, stores()), { added: 50, present: 0, skipped: 0 });
  });
});

// Covers: MEM-054
// Requirement: a file with routes imported on a page without a route store is refused with "this page
// cannot store routes yet" and writes nothing (not even its associations); a route repeating a station
// n refuses the whole file; a route id repeated within one file is stored once, the first copy wins.
describe("MEM-054 import: route edge cases", () => {
  test('routes but no route store -> "this page cannot store routes yet", nothing written', async () => {
    const file = await goodFile();
    file.associations = [entry("milk", "lamp")];
    const s = stores();
    const before = snapshot(s);
    await assert.rejects(importObj(file, { ...s, routes: undefined }), { message: "this page cannot store routes yet" });
    assert.deepEqual(snapshot(s), before, "store unchanged");
  });

  test("duplicate station n within a route -> whole file refused, nothing written", async () => {
    const file = await goodFile();
    file.routes[0].stations[1].n = file.routes[0].stations[0].n;
    const s = stores();
    await s.store.put('["mine","lamp"]', entry("mine", "lamp"));
    const before = snapshot(s);
    await assert.rejects(importObj(file, s), Error);
    assert.deepEqual(snapshot(s), before, "store unchanged");
  });

  test("same route id twice in one file -> one route stored, first copy wins", async () => {
    const file = await goodFile();
    const second = structuredClone(file.routes[0]);
    second.name = "Second copy";
    file.routes.push(second);
    const s = stores();
    await importObj(file, s);
    const listed = await s.routes.listRoutes();
    assert.equal(listed.length, 1, "never duplicated");
    assert.equal(listed[0].name, file.routes[0].name);
  });
});

// Covers: MEM-054
// Requirement: associations and rehearsals are written only after the file's routes persist: a route
// write that fails leaves no orphan association or rehearsal, and retrying the same file once storage
// works adds every association, rehearsal and route.
describe("MEM-054 import: no orphans on a failed route write", () => {
  test("route persist fails -> nothing else written; retry adds all", async () => {
    const file = await goodFile();
    file.associations = [entry("milk", "Red door")];
    file.rehearsals = [rehearsal()];
    const s = stores();
    const realPut = s.routeAdapter.put;
    let fail = true;
    s.routeAdapter.put = async (k, v) => {
      if (fail) throw Object.assign(new Error("The quota has been exceeded."), { name: "QuotaExceededError" });
      return realPut(k, v);
    };
    s.routes = createRouteStore(s.routeAdapter);
    await assert.rejects(importObj(file, s), Error);
    assert.deepEqual(await s.store.list(), [], "no orphan association");
    assert.equal(s.rehAdapter.map.size, 0, "no orphan rehearsal");
    fail = false;
    assert.deepEqual(await importObj(file, s), { added: 3, present: 0, skipped: 0 });
    assert.ok(s.routeAdapter.map.has(`route:${file.routes[0].id}`), "route persisted on retry");
  });
});
