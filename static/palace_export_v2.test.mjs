// Covers: MEM-054
// Requirement: Backup v2 (plan D6 / D11 / B9, ADR amends 0028). The file is {v: 2, routes, lists,
// associations, rehearsals}: saved routes only, named stations only, every station exactly {id, n,
// name, status, box, profile, taps, photo}, never coordinates, timestamps per station, EXIF or
// baseline (Mapillary) data; photos are the stored photo re-encoded to 640 px long side, quality 0.7,
// box scaled to it. MAX_BACKUP_BYTES = 8 MiB caps export and import (checked before parse). Import
// takes v2 only (a v1 file -> "Older backup format, not supported"), refuses the whole file on any
// route / station / photo failure with nothing written, and skips a route whose id is already stored
// ("n added, m already present").
// Contract (RED; GREEN implements static/palace_export.js):
//   MAX_BACKUP_BYTES = 8388608 (MAX_IMPORT_BYTES stays 1048576, the recall-relay chunk cap).
//   deps = {store, rehearsals, routes (createRouteStore), thumbnail, loadImage}:
//     thumbnail(photoBytes, {maxSide: 640, quality: 0.7}) -> {bytes, width, height, sourceWidth, sourceHeight}
//     loadImage(src) -> image with naturalWidth / naturalHeight; rejects when undecodable.
//   buildBackup(deps) -> v2 object; importBackup(text, deps) -> {added, present, skipped}.
//   Station box / profile / taps absent in the store -> null in the file. Imported routes are
//   written through deps.routes (listed by that same instance) with status "saved".
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  BPP_Q90, PNG_1X1, backup, backupV1, dataUrl, entry, jpegSize, makeJpeg, rehearsal, snapshot, stores, uuid,
} from "./backup_fixtures_test.mjs";
import { createRouteStore } from "./route_store.js";
import { RAW_CAMERA, hasExif, toBytes } from "./route_store_fakes_test.mjs";

const mod = await import("./palace_export.js").catch((err) => ({ __missing: String(err) }));

function api(name) {
  assert.ok(name in mod, `static/palace_export.js must export ${name} (${mod.__missing ?? "not exported"})`);
  return mod[name];
}

const MAX_BACKUP = 8 * 1024 * 1024;
const STATION_KEYS = ["box", "id", "n", "name", "photo", "profile", "status", "taps"];
const ROUTE_KEYS = ["created_at", "id", "kind", "lists", "name", "stations"];
const TOP_KEYS = ["associations", "lists", "rehearsals", "routes", "v"];
const FORBIDDEN = /lat|lon|coord|captured|image_id|link/i;
const NAMES = ["Red door", "Oak tree", "Stone bench", "Blue gate", "Old well", "Brick arch", "Tall mast", "Green kiosk"];
const SRC_W = 2048;
const SRC_H = 1536;
const BASELINE = makeJpeg(1024, 768, { body: 300, fill: 0x5a });
const PENDING_PHOTO = makeJpeg(800, 600, { exif: true, body: 200, fill: 0x33 });

const build = (s) => api("buildBackup")(s);
const importText = (text, s) => api("importBackup")(text, s);
const importObj = (obj, s) => importText(JSON.stringify(obj), s);
const keysSorted = (o) => Object.keys(o).sort();
const byId = (a, b) => (a.id < b.id ? -1 : 1);

/** Every [key, value] pair anywhere in `v`. */
function allKeys(v, out = []) {
  if (Array.isArray(v)) v.forEach((x) => allKeys(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) out.push(k), allKeys(x, out);
  return out;
}

/** Rewrites the stored route record and swaps in a fresh route store (a reload) over the adapter. */
function patchRoute(s, id, fn) {
  const rec = s.routeAdapter.map.get(`route:${id}`);
  assert.ok(rec?.route, `route store keeps route ${id} under route:${id}`);
  fn(rec.route);
  s.routes = createRouteStore(s.routeAdapter);
}

/**
 * A route walked through the route store API: `named` stations with 2048x1536 q90 photos carrying
 * EXIF, coords on every capture, then saved (unless save: false); `pending` stations captured after.
 */
async function seedRoute(s, { name = "Morning walk", kind = "daily", named = 3, pending = 0, save = true, q90 = false } = {}) {
  const r = await s.routes.createRoute({ name, kind });
  for (let i = 0; i < named; i++) {
    const st = await s.routes.addStation(r.id, { photo: RAW_CAMERA.slice(), coords: { lat: 51.5012 + i / 1000, lon: -0.1419 } });
    const body = q90 ? Math.round(SRC_W * SRC_H * BPP_Q90) : 400;
    await s.routes.nameStation(r.id, st.id, {
      name: NAMES[i],
      profile: { visual: `a ${NAMES[i].toLowerCase()}`, spatial: "left of the path", conceptual: "entry" },
      box: { x1: 100 + i, y1: 200, x2: 612, y2: 968 },
      photo: makeJpeg(SRC_W, SRC_H, { exif: true, body, fill: 0x40 + i }),
    });
  }
  if (save) await s.routes.finishSave(r.id, { name, kind });
  for (let i = 0; i < pending; i++) await s.routes.addStation(r.id, { photo: PENDING_PHOTO.slice(), coords: { lat: 51.6, lon: -0.2 } });
  return r.id;
}

/** Adds taps, a list, a loaded baseline and stray location / timestamp fields straight into the store. */
function enrich(s, id) {
  patchRoute(s, id, (route) => {
    route.centre = { lat: 51.5012, lon: -0.1419 };
    route.lists = [{ id: uuid(), name: "Groceries", status: "active" }];
    for (const st of route.stations) {
      if (st.status !== "named") continue;
      st.taps = { sound: "traffic", smell: "bread", feel: "cold", mood: "calm" };
      st.captured_at = "2026-10-31T09:00:00.000Z";
      st.baseline = {
        image: dataUrl(BASELINE), image_id: "4455667788", link: "https://www.mapillary.com/app/?pKey=4455667788",
        author: "walker42", credit: "Mapillary", licence: "CC BY-SA 4.0",
      };
    }
  });
}

const photoBytes = (st) => {
  assert.match(st.photo, /^data:image\/jpeg;base64,/, "photo is a JPEG data URL");
  return new Uint8Array(Buffer.from(st.photo.slice(st.photo.indexOf(",") + 1), "base64"));
};

describe("MEM-054 caps", () => {
  test("MAX_BACKUP_BYTES is 8 MiB; MAX_IMPORT_BYTES keeps its 1 MiB recall-relay meaning", () => {
    assert.equal(api("MAX_BACKUP_BYTES"), MAX_BACKUP);
    assert.equal(api("MAX_IMPORT_BYTES"), 1048576);
  });
});

// Covers: MEM-054
// Requirement: B9 crit 1 + 8: every station key set equals the allowlist, route and top-level key
// sets are fixed, and no key anywhere matches lat/lon/coord/captured/image_id/link or
// baseline/mapillary/credit; coordinates, baseline bytes and links never appear in the file text.
describe("MEM-054 export: field allowlist, no coordinates, no baseline", () => {
  test("key walk equals the allowlist and nothing location-bearing leaks", async () => {
    const s = stores();
    const id = await seedRoute(s);
    enrich(s, id);
    const out = await build(s);
    const text = JSON.stringify(out);
    assert.deepEqual(keysSorted(out), TOP_KEYS);
    assert.equal(out.v, 2);
    assert.equal(out.routes.length, 1);
    assert.deepEqual(keysSorted(out.routes[0]), ROUTE_KEYS);
    assert.deepEqual(out.routes[0].lists.map(keysSorted), [["id", "name", "status"]]);
    assert.equal(out.routes[0].stations.length, 3);
    for (const st of out.routes[0].stations) {
      assert.deepEqual(keysSorted(st), STATION_KEYS);
      assert.equal(st.status, "named");
      assert.deepEqual(st.taps, { sound: "traffic", smell: "bread", feel: "cold", mood: "calm" });
    }
    const keys = allKeys(out);
    assert.deepEqual(keys.filter((k) => FORBIDDEN.test(k)), [], "0 location / timestamp / link keys");
    assert.deepEqual(keys.filter((k) => /baseline|mapillary|credit/i.test(k)), [], "0 baseline keys");
    for (const leak of ["51.50", "-0.14", "mapillary.com", "4455667788", "walker42", "2026-10-31T09:00"]) {
      assert.ok(!text.includes(leak), `file text never contains ${leak}`);
    }
    assert.ok(!text.includes(dataUrl(BASELINE).slice(23, 80)), "baseline image bytes never exported");
  });

  test("a named station with no box, profile or taps still carries all 8 keys, as null", async () => {
    const s = stores();
    const id = await seedRoute(s);
    patchRoute(s, id, (route) => {
      delete route.stations[0].box;
      delete route.stations[0].profile;
    });
    const st = (await build(s)).routes[0].stations.find((x) => x.name === NAMES[0]);
    assert.deepEqual(keysSorted(st), STATION_KEYS);
    assert.equal(st.box, null);
    assert.equal(st.profile, null);
    assert.equal(st.taps, null);
  });
});

// Covers: MEM-054
// Requirement: B9 crit 2: exported photos are the stored photo re-encoded to 640 px long side at
// quality 0.7: no EXIF, long side <= 640; the box is scaled to the thumbnail and lies inside it.
describe("MEM-054 export: thumbnails", () => {
  test("every photo is an EXIF-free JPEG <= 640 px; thumbnail called with {maxSide: 640, quality: 0.7}", async () => {
    const s = stores();
    await seedRoute(s);
    const [route] = (await build(s)).routes;
    assert.equal(s.thumbCalls.length, 3, "one re-encode per exported station");
    for (const call of s.thumbCalls) assert.deepEqual(call.opts, { maxSide: 640, quality: 0.7 });
    for (const st of route.stations) {
      const bytes = photoBytes(st);
      assert.equal(hasExif(bytes), false, "no EXIF in an exported photo");
      const size = jpegSize(bytes);
      assert.ok(size && Math.max(size.width, size.height) <= 640, `long side <= 640, got ${JSON.stringify(size)}`);
      const k = size.width / SRC_W;
      const src = { x1: 100 + NAMES.indexOf(st.name), y1: 200, x2: 612, y2: 968 };
      for (const c of ["x1", "y1", "x2", "y2"]) assert.ok(Math.abs(st.box[c] - src[c] * k) <= 1, `box.${c} scaled to the thumbnail`);
      assert.ok(st.box.x1 >= 0 && st.box.y1 >= 0 && st.box.x2 <= size.width && st.box.y2 <= size.height, "box inside");
    }
  });
});

// Covers: MEM-054
// Requirement: B9 crit 3: pending and error stations of a saved route and every draft route are
// skipped; pending photo bytes are never read for export.
describe("MEM-054 export: pending stations and drafts skipped", () => {
  test("1 pending station + 1 draft route -> 0 pending stations, 0 drafts in the file", async () => {
    const s = stores();
    const saved = await seedRoute(s, { named: 3, pending: 1 });
    const draft = await seedRoute(s, { name: "Unfinished", named: 2, save: false });
    const out = await build(s);
    const text = JSON.stringify(out);
    assert.deepEqual(out.routes.map((r) => r.id), [saved]);
    assert.equal(out.routes[0].stations.length, 3);
    assert.ok(out.routes[0].stations.every((st) => st.status === "named"));
    assert.ok(!text.includes(draft) && !text.includes("Unfinished"), "draft route absent");
    assert.ok(!s.thumbCalls.some((c) => c.bytes.length === PENDING_PHOTO.length), "pending photo never re-encoded");
    assert.ok(!text.includes(dataUrl(PENDING_PHOTO).slice(23, 80)), "pending photo bytes absent");
  });
});

// Covers: MEM-054
// Requirement: B9 crit 4 + 11: 3 routes x 8 stations from 2048 px q90 photos export under
// MAX_BACKUP_BYTES and re-import; a backup over the cap is refused at export, and an import text over
// it is refused before JSON.parse (exactly at the cap is read).
describe("MEM-054 MAX_BACKUP_BYTES", () => {
  test("3 x 8 real-size stations export under 8 MiB and re-import without error", async () => {
    const s = stores();
    for (const name of ["Home to work", "School run", "Park loop"]) await seedRoute(s, { name, named: 8, q90: true });
    const raw = 24 * Math.round(SRC_W * SRC_H * BPP_Q90) * (4 / 3);
    assert.ok(raw > MAX_BACKUP, "the stored photos alone would not fit, so the thumbnails are what make it fit");
    const text = JSON.stringify(await build(s));
    assert.ok(Buffer.byteLength(text) <= MAX_BACKUP, `export ${Buffer.byteLength(text)} bytes <= MAX_BACKUP_BYTES`);
    const dst = stores();
    assert.deepEqual(await importText(text, dst), { added: 3, present: 0, skipped: 0 });
    assert.equal((await dst.routes.listRoutes()).length, 3);
  });

  test("a backup over MAX_BACKUP_BYTES is refused at export", async () => {
    const s = stores();
    await s.rehearsals.save("demo", { transcript: "x".repeat(MAX_BACKUP), results: [] });
    await assert.rejects(build(s), Error);
  });

  test("import text over MAX_BACKUP_BYTES is refused before JSON.parse; nothing written", async (t) => {
    const s = stores();
    const r = rehearsal();
    const base = JSON.stringify(backup({ rehearsals: [{ ...r, transcript: "" }] }));
    const text = base.replace('"transcript":""', `"transcript":"${"x".repeat(MAX_BACKUP + 1 - Buffer.byteLength(base))}"`);
    assert.equal(Buffer.byteLength(text), MAX_BACKUP + 1);
    const parse = t.mock.method(JSON, "parse");
    await assert.rejects(importText(text, s), Error);
    assert.equal(parse.mock.callCount(), 0, "refused before parse");
    t.mock.restoreAll();
    assert.deepEqual(snapshot(s), snapshot(stores()), "nothing written");
  });

  test("import text exactly MAX_BACKUP_BYTES is read", async () => {
    const s = stores();
    const r = rehearsal();
    const base = JSON.stringify(backup({ rehearsals: [{ ...r, transcript: "" }] }));
    const text = base.replace('"transcript":""', `"transcript":"${"x".repeat(MAX_BACKUP - Buffer.byteLength(base))}"`);
    assert.equal(Buffer.byteLength(text), MAX_BACKUP);
    assert.deepEqual(await importText(text, s), { added: 1, present: 0, skipped: 0 });
  });
});

// Covers: MEM-054
// Requirement: B9 crit 5: export -> import into an empty store -> export gives the same file (minus
// coords, baselines and photo resolution, which the first export already dropped); imported routes
// are saved, listed by the same route store instance, with the thumbnail as their stored photo.
describe("MEM-054 round trip", () => {
  test("v2 round trip is deep-equal; the imported route is saved, coordinate-free and readable", async () => {
    const src = stores();
    enrich(src, await seedRoute(src, { name: "Morning walk", named: 3, pending: 1 }));
    await seedRoute(src, { name: "Evening walk", kind: "occasional", named: 4 });
    await src.store.put('["milk","Red door"]', entry("milk", "Red door"));
    await src.rehearsals.restore(rehearsal());
    const first = await build(src);
    const dst = stores();
    assert.deepEqual(await importObj(first, dst), { added: 4, present: 0, skipped: 0 });
    const second = await build(dst);
    assert.deepEqual({ ...second, routes: [...second.routes].sort(byId) }, { ...first, routes: [...first.routes].sort(byId) });
    for (const fileRoute of first.routes) {
      const r = (await dst.routes.listRoutes()).find((x) => x.id === fileRoute.id);
      assert.ok(r, "imported route listed without a reload");
      assert.equal(r.status, "saved");
      assert.deepEqual(r.stations.map((x) => x.id), fileRoute.stations.map((x) => x.id));
      for (const [i, st] of r.stations.entries()) {
        assert.equal(st.status, "named");
        assert.ok(!("coords" in st), "no coords on an imported station");
        assert.deepEqual(await toBytes(await dst.routes.getPhoto(st.photo_ref)), photoBytes(fileRoute.stations[i]));
      }
    }
  });
});

/** A valid one-route v2 file built from a real export. */
async function goodFile() {
  const s = stores();
  await seedRoute(s);
  return build(s);
}

const mutate = (file, fn) => {
  const f = structuredClone(file);
  fn(f, f.routes[0], f.routes[0].stations[0]);
  return f;
};

// Covers: MEM-054
// Requirement: B9 crit 6 + 10: a malformed, extra-key or coordinate-bearing route / station, or a
// photo that is not a decodable data:image/jpeg URL, refuses the whole file and writes nothing; an
// unsafe src never reaches loadImage.
describe("MEM-054 import: whole-file refusal", () => {
  const cases = {
    "routes not an array": (f) => void (f.routes = {}),
    "lists not an array": (f) => void (f.lists = null),
    "station missing name": (f, r, st) => void delete st.name,
    "station n not an integer": (f, r, st) => void (st.n = 1.5),
    "station status pending": (f, r, st) => void (st.status = "pending"),
    "route kind unknown": (f, r) => void (r.kind = "weekly"),
    "route created_at not ISO": (f, r) => void (r.created_at = "yesterday"),
    "9 stations": (f, r) => void (r.stations = Array.from({ length: 9 }, (_, i) => ({ ...r.stations[0], id: uuid(), n: i + 1 }))),
    "box outside the thumbnail": (f, r, st) => void (st.box = { x1: 0, y1: 0, x2: 641, y2: 100 }),
    "extra station key": (f, r, st) => void (st.note = "x"),
    "extra route key (status)": (f, r) => void (r.status = "saved"),
    "extra top-level key": (f) => void (f.palace_id = "demo"),
    "station coords": (f, r, st) => void (st.coords = { lat: 51.5, lon: -0.14 }),
    "station lat key": (f, r, st) => void (st.lat = 51.5),
    "route coords": (f, r) => void (r.coords = { lat: 51.5, lon: -0.14 }),
  };
  for (const [name, fn] of Object.entries(cases)) {
    test(`refused: ${name}`, async () => {
      const file = mutate(await goodFile(), fn);
      const s = stores();
      await s.store.put('["mine","lamp"]', entry("mine", "lamp"));
      const before = snapshot(s);
      await assert.rejects(importObj(file, s), Error);
      assert.deepEqual(snapshot(s), before, "store unchanged");
    });
  }

  const photos = {
    "data:image/png": dataUrl(PNG_1X1, "image/png"),
    "javascript:": "javascript:alert(1)",
    "undecodable JPEG": dataUrl(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])),
  };
  for (const [name, photo] of Object.entries(photos)) {
    test(`refused: photo ${name}`, async () => {
      const file = mutate(await goodFile(), (f, r, st) => void (st.photo = photo));
      const s = stores();
      const before = snapshot(s);
      await assert.rejects(importObj(file, s), Error);
      assert.deepEqual(snapshot(s), before, "store unchanged");
      assert.ok(s.loadCalls.every((src) => src.startsWith("data:image/jpeg;base64,")), "only JPEG data URLs reach loadImage");
    });
  }
});

// Covers: MEM-054
// Requirement: B9 crit 7: a v1 file is refused with "Older backup format, not supported" and nothing
// is written.
describe("MEM-054 import: v1 refused", () => {
  test('v1 fixture -> "Older backup format, not supported", store unchanged', async () => {
    const s = stores();
    const before = snapshot(s);
    const v1 = backupV1({ associations: [entry("milk", "lamp")], rehearsals: [rehearsal()] });
    await assert.rejects(importObj(v1, s), { message: "Older backup format, not supported" });
    assert.deepEqual(snapshot(s), before);
  });
});

// Covers: MEM-054
// Requirement: D11 + B9 crit 9: a route whose id is already stored is skipped, never overwritten or
// duplicated; importing the same file twice reports "0 added, n already present" and leaves the store
// deep-equal to after the first import.
describe("MEM-054 import: id collisions (D11)", () => {
  test("same file twice -> second {added: 0, present: n}, store unchanged by it", async () => {
    const src = stores();
    await seedRoute(src, { name: "A" });
    await seedRoute(src, { name: "B", kind: "occasional" });
    await src.store.put('["milk","Red door"]', entry("milk", "Red door"));
    await src.rehearsals.restore(rehearsal());
    const text = JSON.stringify(await build(src));
    const dst = stores();
    assert.deepEqual(await importText(text, dst), { added: 4, present: 0, skipped: 0 });
    const after = snapshot(dst);
    assert.deepEqual(await importText(text, dst), { added: 0, present: 4, skipped: 0 });
    assert.deepEqual(snapshot(dst), after);
    assert.equal((await dst.routes.listRoutes()).length, 2, "never duplicated");
  });

  test("a stored route with the same id wins over the file's", async () => {
    const s = stores();
    const id = await seedRoute(s, { name: "Mine" });
    const file = await build(s);
    file.routes[0].name = "Theirs";
    const before = snapshot(s);
    assert.deepEqual(await importObj(file, s), { added: 0, present: 1, skipped: 0 });
    assert.equal((await s.routes.getRoute(id)).name, "Mine");
    assert.deepEqual(snapshot(s), before);
  });
});
