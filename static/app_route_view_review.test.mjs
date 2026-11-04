// Covers: MEM-051
// Requirement: route practice and the S1/S5 route screens survive misuse and store failures (B6 review):
// the recorded-demo replay never saves a route rehearsal (it would overwrite Learned n/N and hit rates
// with bogus hits); a route delete whose store write rejects still offers Undo and shows an error line;
// an Undo whose restore rejects keeps Undo available and shows an error line, and an Undo with nothing
// stashed shows an error line instead of silently doing nothing; a route store whose list rejects
// renders an error line on S1. None of these escape as an unhandled rejection.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { boot, click, el, findAll, kvAdapter, settle, TURNS, until, visibleText, watchRejections } from "./ux_flow_harness_test.mjs";
import { memoryAdapter } from "./route_store_fakes_test.mjs";
import { createRouteStore } from "./route_store.js";

const NAMES = ["red bench", "red door", "old oak", "stone arch", "blue gate", "brick wall"];
const ERROR_LINE = /fail|couldn.t|could not|error|try again/i;

function commute() {
  const stations = NAMES.map((name, i) => ({ id: `r1-st-${i + 1}`, n: i + 1, name, photo_ref: `r1-ph-${i + 1}`,
    status: "named", taps: { turn: "Left" } }));
  return { id: "r1", name: "Commute", kind: "daily", status: "saved", created_at: "2026-10-30T08:00:00.000Z", stations, lists: [] };
}
const R1 = commute();

function seededRouteAdapter() {
  const adapter = memoryAdapter();
  const photo = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x03, 0x42, 0xff, 0xd9]);
  adapter.map.set("route:r1", structuredClone({ type: "route", route: R1 }));
  for (const s of R1.stations) adapter.map.set(`photo:${s.photo_ref}`, { type: "photo", bytes: photo });
  return adapter;
}

/** A stored r1 route rehearsal: stations 1, 3, 5 got (3/6). */
function routeRun(id, ts) {
  const hits = Object.fromEntries(R1.stations.map((s, i) => [s.id, i % 2 === 0]));
  return [id, JSON.stringify({ id, palace_id: "r1", timestamp: ts, transcript: "", points: [], mode: "route", hits })];
}

/** The real route store with optional overrides (each a function replacing that method). */
function wrappedStore(adapter, overrides = {}) {
  const real = createRouteStore(adapter);
  return { real, store: { ...real, ...overrides } };
}

async function start({ overrides = {}, rehAdapter } = {}) {
  const routeAdapter = seededRouteAdapter();
  const { real, store } = wrappedStore(routeAdapter, typeof overrides === "function" ? overrides(() => real) : overrides);
  const reh = rehAdapter ?? kvAdapter([routeRun("reh-r1-a", "2026-10-30T09:00:00.000Z")]);
  const b = boot({ routes: store, rehAdapter: reh });
  return { b, real, routeAdapter, rehAdapter: reh };
}

const cards = (b) => findAll(el(b, "routes-list"), (n) => n.tagName === "LI", { visibleOnly: true });
const routeRehearsals = (rehAdapter) =>
  [...rehAdapter.map.values()].filter((v) => typeof v === "string" && JSON.parse(v).mode === "route").length;

async function openCommute(b) {
  await until(() => cards(b).length === 1, "Commute card on S1", TURNS);
  const open = findAll(cards(b)[0], (n) => n.tagName === "BUTTON" && n.dataset.action === "open")[0];
  assert.ok(open, "Commute card has an Open button");
  b.p.fire(open, "click");
  await until(() => !el(b, "route-view").hidden, "#route-view shown", TURNS);
  await settle(20);
}

/** r1 as stored just before the delete (MEM-134: first view auto-saves station emojis). */
async function routeAtDelete(real) {
  const r1 = await real.getRoute("r1");
  assert.equal(r1?.id, "r1", "r1 stored just before delete");
  return r1;
}

async function confirmDelete(b) {
  click(b, "route-view-delete");
  await settle(20);
  click(b, "route-view-delete-confirm");
  await settle(60);
}

// Covers: MEM-051
// Requirement: the recorded-demo replay never saves a route rehearsal during route practice.
describe("Route practice: #recall-replay saves no route rehearsal (B6 review blocker)", () => {
  test("replay is blocked (hidden/disabled) or its run saves nothing under the route; Learned stays 3/6", async (t) => {
    const rejections = watchRejections(t);
    const { b, rehAdapter } = await start();
    await openCommute(b);
    click(b, "route-view-practice");
    await until(() => !el(b, "recall").hidden, "#recall shown", TURNS);
    await settle(20);
    const before = routeRehearsals(rehAdapter);
    assert.equal(before, 1, "one seeded route rehearsal");
    const replay = el(b, "recall-replay");
    if (!replay.hidden && !replay.disabled) {
      click(b, "recall-replay");
      await settle(300);
    }
    assert.equal(routeRehearsals(rehAdapter), before,
      "a replay of the demo recording during route practice must not save a mode:\"route\" rehearsal");
    assert.ok(visibleText(el(b, "routes-list")).includes("Learned 3/6"), "Commute Learned unchanged");
    assert.deepEqual(rejections, []);
  });
});

// Covers: MEM-051
// Requirement: a route delete whose store write rejects still offers Undo, shows an error line, and
// never escapes as an unhandled rejection.
describe("S5 route delete: store rejection (B6 review)", () => {
  test("rehearsals delete rejects after the route is deleted: Undo shown, error line, Undo restores r1", async (t) => {
    const rejections = watchRejections(t);
    const rehAdapter = kvAdapter([routeRun("reh-r1-a", "2026-10-30T09:00:00.000Z")]);
    rehAdapter.delete = async () => {
      throw new Error("rehearsal delete boom");
    };
    const { b, real } = await start({ rehAdapter });
    await openCommute(b);
    const atDelete = await routeAtDelete(real);
    assert.doesNotMatch(visibleText(el(b, "route-view")), ERROR_LINE, "no error line before delete");
    await confirmDelete(b);
    assert.equal(el(b, "route-view-undo").hidden, false, "Undo still offered after a failed delete");
    assert.match(visibleText(el(b, "route-view")), ERROR_LINE, "an error line explains the delete failed");
    click(b, "route-view-undo");
    await settle(60);
    assert.deepEqual(await real.getRoute("r1"), atDelete, "Undo restores the deleted route");
    assert.deepEqual(rejections, []);
  });

  test("deleteRoute rejects: Undo shown, error line, no unhandled rejection", async (t) => {
    const rejections = watchRejections(t);
    const { b } = await start({ overrides: { deleteRoute: async () => { throw new Error("route delete boom"); } } });
    await openCommute(b);
    await confirmDelete(b);
    assert.equal(el(b, "route-view-undo").hidden, false, "Undo still offered after a failed delete");
    assert.match(visibleText(el(b, "route-view")), ERROR_LINE, "an error line explains the delete failed");
    assert.deepEqual(rejections, []);
  });
});

// Covers: MEM-051
// Requirement: an Undo whose restore rejects keeps Undo available with an error line; an Undo with
// nothing stashed shows an error line; neither escapes as an unhandled rejection.
describe("S5 route Undo: restore rejection and absent stash (B6 review)", () => {
  test("undoDelete rejects once: Undo stays, error line; a second Undo restores r1", async (t) => {
    const rejections = watchRejections(t);
    let failNext = false;
    const { b, real } = await start({
      overrides: (getReal) => ({
        undoDelete: async () => {
          if (failNext) {
            failNext = false;
            throw new Error("undo boom");
          }
          return getReal().undoDelete();
        },
      }),
    });
    await openCommute(b);
    const atDelete = await routeAtDelete(real);
    await confirmDelete(b);
    assert.equal(el(b, "route-view-undo").hidden, false, "Undo offered after delete");
    failNext = true;
    click(b, "route-view-undo");
    await settle(60);
    assert.equal(el(b, "route-view-undo").hidden, false, "a rejected restore keeps Undo available");
    assert.match(visibleText(el(b, "route-view")), ERROR_LINE, "an error line explains the Undo failed");
    click(b, "route-view-undo");
    await until(() => cards(b).length === 1, "Commute card back after the retry", TURNS);
    assert.deepEqual(await real.getRoute("r1"), atDelete, "the retried Undo restores r1");
    assert.deepEqual(rejections, []);
  });

  test("undoDelete resolves null (nothing stashed): error line, no unhandled rejection", async (t) => {
    const rejections = watchRejections(t);
    const { b } = await start({ overrides: { undoDelete: async () => null } });
    await openCommute(b);
    await confirmDelete(b);
    click(b, "route-view-undo");
    await settle(60);
    assert.match(visibleText(el(b, "route-view")), ERROR_LINE, "an Undo that restored nothing says so");
    assert.deepEqual(rejections, []);
  });
});

// Covers: MEM-051
// Requirement: a route store whose list rejects renders an error line on S1 instead of crashing.
describe("S1 Routes home: listRoutes rejects (B6 review)", () => {
  test("an error line in #routes-home, no cards, no unhandled rejection", async (t) => {
    const rejections = watchRejections(t);
    const { b } = await start({ overrides: { listRoutes: async () => { throw new Error("list boom"); } } });
    await settle(60);
    assert.equal(cards(b).length, 0, "no route cards");
    assert.match(visibleText(el(b, "routes-home")), ERROR_LINE, "S1 shows an error line");
    assert.deepEqual(rejections, []);
  });
});

const openable = (b) => !el(b, "route-view").hidden && visibleText(el(b, "route-view")).includes("Commute (Daily)")
  && !el(b, "route-view-practice").hidden;

// Covers: MEM-051
// Requirement: with the REAL route store, a delete whose storage write fails (the route already left
// memory) still lets Undo put the route back: an error line explains the failure, and Undo makes the
// route listed on S1 and openable again. The route is never silently lost.
describe("S5 route delete: real store, storage delete fails after the route left memory (B6 review blocker)", () => {
  test("adapter.delete rejects for route:r1: error line, Undo shown; Undo lists and reopens Commute", async (t) => {
    const rejections = watchRejections(t);
    const { b, real, routeAdapter } = await start();
    const realDelete = routeAdapter.delete.bind(routeAdapter);
    routeAdapter.delete = async (key) => {
      if (key === "route:r1") throw new Error("storage delete boom");
      return realDelete(key);
    };
    await openCommute(b);
    const atDelete = await routeAtDelete(real);
    await confirmDelete(b);
    assert.equal(el(b, "route-view-undo").hidden, false, "Undo offered after a delete whose persist failed");
    assert.match(visibleText(el(b, "route-view")), ERROR_LINE, "an error line explains the delete failed");
    click(b, "route-view-undo");
    await settle(60);
    assert.deepEqual(await real.getRoute("r1"), atDelete, "Undo puts r1 back in the store");
    await until(() => cards(b).length === 1, "Commute card back on S1 after Undo", TURNS);
    await until(() => openable(b), "Commute reopened in #route-view after Undo", TURNS);
    assert.deepEqual(rejections, []);
  });
});

// Covers: MEM-051
// Requirement: with the REAL route store, an Undo whose storage write fails is NOT treated as restored
// (the route would be gone on reload): S5 shows "Couldn't restore the route. Try again.", keeps Undo
// visible and the stash, and puts no rehearsal back; a later Undo, once storage works, restores the
// route (listed, openable, surviving a reload) and its rehearsals, then hides Undo.
describe("S5 route Undo: real store, restore persist fails (B6 residual review)", () => {
  test("puts fail during Undo: restore-error line, Undo kept, no rehearsal back; retry restores route + rehearsals", async (t) => {
    const rejections = watchRejections(t);
    const { b, real, routeAdapter, rehAdapter } = await start();
    await openCommute(b);
    const atDelete = await routeAtDelete(real);
    await confirmDelete(b);
    assert.equal(await real.getRoute("r1"), null, "delete landed");
    assert.equal(routeRehearsals(rehAdapter), 0, "delete removed the route rehearsal");
    routeAdapter.state.failPuts = true;
    click(b, "route-view-undo");
    await settle(60);
    assert.match(visibleText(el(b, "route-view")), /couldn.t restore the route/i,
      "a restore whose write failed says so instead of showing the route as restored");
    assert.equal(el(b, "route-view-undo").hidden, false, "Undo stays available for a retry");
    assert.equal(routeRehearsals(rehAdapter), 0, "no rehearsal restored while the route itself is not");
    routeAdapter.state.failPuts = false;
    click(b, "route-view-undo");
    await until(() => cards(b).length === 1, "Commute card back on S1 after the retried Undo", TURNS);
    await until(() => openable(b), "Commute reopened in #route-view after the retried Undo", TURNS);
    assert.equal(el(b, "route-view-undo").hidden, true, "Undo hidden once the restore landed");
    assert.deepEqual(await createRouteStore(routeAdapter).getRoute("r1"), atDelete, "r1 survives a reload");
    assert.equal(routeRehearsals(rehAdapter), 1, "the route rehearsal is restored once");
    assert.deepEqual(rejections, []);
  });
});

// Covers: MEM-051
// Requirement: a route delete whose rehearsal deletes fail partway (some rehearsals gone, some left)
// still lets Undo put back every stashed rehearsal exactly once: no rehearsal lost, none duplicated.
describe("S5 route delete: rehearsal delete fails mid-loop (B6 residual review NIT)", () => {
  test("second rehearsal delete rejects: Undo restores r1 and both rehearsals, no duplicates", async (t) => {
    const rejections = watchRejections(t);
    const rehAdapter = kvAdapter([
      routeRun("reh-r1-a", "2026-10-30T09:00:00.000Z"),
      routeRun("reh-r1-b", "2026-10-31T08:00:00.000Z"),
    ]);
    const realDelete = rehAdapter.delete;
    let deletes = 0;
    rehAdapter.delete = async (key) => {
      deletes += 1;
      if (deletes === 2) throw new Error("rehearsal delete boom");
      return realDelete(key);
    };
    const { b, real } = await start({ rehAdapter });
    await openCommute(b);
    const atDelete = await routeAtDelete(real);
    await confirmDelete(b);
    assert.equal(routeRehearsals(rehAdapter), 1, "one rehearsal deleted before the failure");
    assert.equal(el(b, "route-view-undo").hidden, false, "Undo offered after the partial delete");
    click(b, "route-view-undo");
    await until(() => cards(b).length === 1, "Commute card back on S1 after Undo", TURNS);
    assert.deepEqual(await real.getRoute("r1"), atDelete, "Undo restores r1");
    const ids = [...rehAdapter.map.values()].filter((v) => typeof v === "string").map((v) => JSON.parse(v))
      .filter((r) => r.mode === "route").map((r) => r.id).sort();
    assert.deepEqual(ids, ["reh-r1-a", "reh-r1-b"], "both stashed rehearsals back, each exactly once");
    assert.deepEqual(rejections, []);
  });
});
