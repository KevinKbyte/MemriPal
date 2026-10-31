// Covers: MEM-051
// Requirement: with a route store wired into the app (wireApp deps.routes), S1 Routes home lists every
// route as one card in #routes-list (3 saved, 2 Daily and 1 Occasional, plus 1 draft = 4 cards), each
// card showing its kind, station count and "Learned n/N", the draft tagged "Draft"; a card's Open
// button (data-action="open") shows S5 #route-view with the route's stations in #route-view-stations
// and one node per station in #route-map; route delete arms on #route-view-delete,
// #route-view-delete-cancel restores, #route-view-delete-confirm removes the route from the store and
// from S1, and #route-view-undo restores it deep-equal (route store and rehearsals); #hit-rates shows
// one row per station keyed by station id with its recorded rate (6/6 then 3/6 -> 100% / 50%);
// #route-view-practice opens #recall in route mode with one #recall-map node per station; JS sets no
// inline style except the existing scene zoom transform, and no coordinate digits reach visible text
// (plan B6 criteria 7, 8, 9, 10, 11, 12; Part A S1, S5, S8, S9).
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { boot, click, el, find, findAll, kvAdapter, settle, TURNS, until, visibleText, watchRejections } from "./ux_flow_harness_test.mjs";
import { memoryAdapter } from "./route_store_fakes_test.mjs";
import { createRouteStore } from "./route_store.js";

const COORDS = [
  [51.5074, -0.1278], [51.5081, -0.1269], [51.5093, -0.1255], [51.5101, -0.1249], [51.5112, -0.1231],
  [51.5120, -0.1222],
];
const NAMES = ["red bench", "red door", "old oak", "stone arch", "blue gate", "brick wall"];

function station(routeId, i, { coords = true, status = "named" } = {}) {
  const s = { id: `${routeId}-st-${i + 1}`, n: i + 1, name: NAMES[i], photo_ref: `${routeId}-ph-${i + 1}`, status,
    taps: { turn: "Left" } };
  if (coords) s.coords = { lat: COORDS[i][0], lon: COORDS[i][1] };
  return s;
}

function route(id, name, kind, k, { status = "saved" } = {}) {
  return { id, name, kind, status, created_at: "2026-10-30T08:00:00.000Z",
    stations: Array.from({ length: k }, (_, i) => station(id, i)), lists: [] };
}

const ROUTES = [
  route("r1", "Commute", "daily", 6),
  route("r2", "School run", "daily", 4),
  route("r3", "Weekend market", "occasional", 3),
  route("d1", "Park loop", "daily", 2, { status: "draft" }),
];
const R1_IDS = ROUTES[0].stations.map((s) => s.id);

/** A stored route rehearsal for r1; hits keyed by station id. */
function routeRun(id, ts, gotCount) {
  const hits = Object.fromEntries(R1_IDS.map((sid, i) => [sid, i % 2 === 0 || gotCount === 6]));
  return [id, JSON.stringify({ id, palace_id: "r1", timestamp: ts, transcript: "", points: [], mode: "route", hits })];
}

function seededRoutes() {
  const adapter = memoryAdapter();
  const photo = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x03, 0x42, 0xff, 0xd9]);
  for (const r of ROUTES) {
    adapter.map.set(`route:${r.id}`, structuredClone({ type: "route", route: r }));
    for (const s of r.stations) adapter.map.set(`photo:${s.photo_ref}`, { type: "photo", bytes: photo });
  }
  return adapter;
}

async function start() {
  const routeAdapter = seededRoutes();
  const routes = createRouteStore(routeAdapter);
  // 6/6 first, then 3/6 (stations 1, 3, 5 got): latest run is 3/6.
  const rehAdapter = kvAdapter([
    routeRun("reh-r1-a", "2026-10-30T09:00:00.000Z", 6),
    routeRun("reh-r1-b", "2026-10-31T08:00:00.000Z", 3),
  ]);
  const b = boot({ routes, rehAdapter });
  await until(() => cards(b).length === 4, "4 route cards on S1", TURNS);
  return { b, routes, routeAdapter, rehAdapter };
}

const cards = (b) => findAll(el(b, "routes-list"), (n) => n.tagName === "LI", { visibleOnly: true });
const cardText = (li) => visibleText(li);
const cardOf = (b, name) => cards(b).find((li) => cardText(li).includes(name));
const openButton = (li) => find(li, (n) => n.tagName === "BUTTON" && n.dataset.action === "open");
const nodesOf = (svg) => findAll(svg, (n) => n !== svg && n.dataset?.stationId !== undefined);
const snapshot = (map) => structuredClone(new Map([...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));

async function openRoute(b, name) {
  const card = cardOf(b, name);
  assert.ok(card, `S1 has a card for ${name}`);
  const open = openButton(card);
  assert.ok(open, `${name} card has an Open button (data-action="open")`);
  b.p.fire(open, "click");
  await until(() => !el(b, "route-view").hidden, "#route-view shown", TURNS);
  await settle(20);
}

// Covers: MEM-051
// Requirement: S1 shows one card per route (saved and draft) with kind, station count and Learned n/N.
describe("S1 Routes home: 3 saved + 1 draft = 4 route cards (criterion 11)", () => {
  test("each card shows its kind, station count and Learned n/N; only the draft is tagged Draft", async (t) => {
    const rejections = watchRejections(t);
    const { b } = await start();
    const expected = [
      ["Commute", "Daily", 6, "Learned 3/6"],
      ["School run", "Daily", 4, "Learned 0/4"],
      ["Weekend market", "Occasional", 3, "Learned 0/3"],
      ["Park loop", "Daily", 2, "Learned 0/2"],
    ];
    for (const [name, kind, count, learned] of expected) {
      const card = cardOf(b, name);
      assert.ok(card, `card for ${name}`);
      const text = cardText(card);
      assert.ok(text.includes(kind), `${name} card shows kind ${kind}: "${text}"`);
      assert.match(text, new RegExp(`\\b${count} stations\\b`), `${name} card shows ${count} stations`);
      assert.ok(text.includes(learned), `${name} card shows ${learned}: "${text}"`);
      assert.equal(text.includes("Draft"), name === "Park loop", `${name} Draft tag`);
    }
    assert.deepEqual(rejections, []);
  });
});

// Covers: MEM-051
// Requirement: opening a route shows S5 with its stations in order and one map node per station.
describe("S5 Route view opens from a route card", () => {
  test("Open shows #route-view (S1 hidden), stations in route order and 6 #route-map nodes", async (t) => {
    const rejections = watchRejections(t);
    const { b } = await start();
    await openRoute(b, "Commute");
    assert.equal(el(b, "routes-home").hidden, true, "S1 hidden while S5 shows (one screen at a time)");
    assert.ok(visibleText(el(b, "route-view")).includes("Commute"), "route name shown on S5");
    const rows = findAll(el(b, "route-view-stations"), (n) => n.tagName === "LI");
    assert.equal(rows.length, 6);
    rows.forEach((li, i) => assert.ok(visibleText(li).includes(NAMES[i]), `row ${i + 1} is ${NAMES[i]}`));
    assert.deepEqual(nodesOf(el(b, "route-map")).map((n) => n.dataset.stationId), R1_IDS);
    assert.deepEqual(rejections, []);
  });
});

// Covers: MEM-051
// Requirement: deleting a route needs arm + confirm, cancel restores, and Undo restores it deep-equal.
describe("S5 route delete: arm, cancel, confirm, Undo (criterion 10)", () => {
  test("arm shows confirm + cancel; cancel hides them and changes nothing", async (t) => {
    const rejections = watchRejections(t);
    const { b, routeAdapter, rehAdapter } = await start();
    await openRoute(b, "Commute");
    const before = { routes: snapshot(routeAdapter.map), rehearsals: snapshot(rehAdapter.map) };
    assert.equal(el(b, "route-view-delete-confirm").hidden, true, "confirm hidden until armed");
    assert.equal(el(b, "route-view-delete-cancel").hidden, true, "cancel hidden until armed");
    click(b, "route-view-delete");
    await settle(20);
    assert.equal(el(b, "route-view-delete-confirm").hidden, false, "first click arms: confirm visible");
    assert.equal(el(b, "route-view-delete-cancel").hidden, false, "first click arms: cancel visible");
    assert.deepEqual(snapshot(routeAdapter.map), before.routes, "arming deletes nothing");
    click(b, "route-view-delete-cancel");
    await settle(20);
    assert.equal(el(b, "route-view-delete-confirm").hidden, true, "cancel hides confirm");
    assert.equal(el(b, "route-view-delete-cancel").hidden, true, "cancel hides itself");
    assert.equal(el(b, "route-view-undo").hidden, true, "no Undo after cancel");
    assert.deepEqual(snapshot(routeAdapter.map), before.routes, "route store unchanged");
    assert.deepEqual(snapshot(rehAdapter.map), before.rehearsals, "rehearsals unchanged");
    assert.deepEqual(rejections, []);
  });

  test("confirm removes the route from the store and S1; Undo restores store + rehearsals deep-equal", async (t) => {
    const rejections = watchRejections(t);
    const { b, routes, routeAdapter, rehAdapter } = await start();
    await openRoute(b, "Commute");
    const before = { routes: snapshot(routeAdapter.map), rehearsals: snapshot(rehAdapter.map) };
    click(b, "route-view-delete");
    await settle(20);
    click(b, "route-view-delete-confirm");
    await until(() => !routeAdapter.map.has("route:r1"), "r1 deleted from the store", TURNS);
    await settle(20);
    assert.ok(!(await routes.listRoutes()).some((r) => r.id === "r1"), "r1 gone from the store");
    assert.equal(cards(b).filter((li) => cardText(li).includes("Commute")).length, 0, "no Commute card on S1");
    assert.equal(cards(b).length, 3, "3 cards left on S1");
    assert.equal(el(b, "route-view-undo").hidden, false, "Undo offered after delete");
    click(b, "route-view-undo");
    await until(() => cards(b).length === 4, "4 cards after Undo", TURNS);
    await settle(20);
    assert.deepEqual(snapshot(routeAdapter.map), before.routes, "route store deep-equal after Undo (stations, lists, photos)");
    assert.deepEqual(snapshot(rehAdapter.map), before.rehearsals, "rehearsals deep-equal after Undo");
    assert.deepEqual(await routes.getRoute("r1"), ROUTES[0], "r1 restored deep-equal");
    assert.ok(cardOf(b, "Commute"), "Commute card back on S1");
    assert.deepEqual(rejections, []);
  });
});

// Covers: MEM-051
// Requirement: #hit-rates shows one row per station keyed by station id with its recorded rate.
describe("#hit-rates: one row per station id (criterion 12)", () => {
  test("6/6 then 3/6 -> rows for each r1 station id, 100% or 50%", async (t) => {
    const rejections = watchRejections(t);
    const { b } = await start();
    await openRoute(b, "Commute");
    const rows = findAll(el(b, "hit-rates"), (n) => n.tagName === "LI");
    assert.deepEqual(rows.map((li) => li.dataset.stationId), R1_IDS, "one row per station id, in route order");
    rows.forEach((li, i) => {
      const text = li.textContent;
      assert.ok(text.includes(NAMES[i]), `row ${i + 1} names ${NAMES[i]}: "${text}"`);
      const rate = i % 2 === 0 ? "100%" : "50%";
      assert.ok(text.includes(rate), `row ${i + 1} shows ${rate}: "${text}"`);
    });
    assert.deepEqual(rejections, []);
  });
});

// Covers: MEM-051
// Requirement: Practice this route opens recall in route mode with a map node per station.
describe("S5 -> S8: Practice this route", () => {
  test("#route-view-practice shows #recall, route-mode text and 6 unlit #recall-map nodes", async (t) => {
    const rejections = watchRejections(t);
    const { b } = await start();
    await openRoute(b, "Commute");
    click(b, "route-view-practice");
    await until(() => !el(b, "recall").hidden, "#recall shown", TURNS);
    await settle(20);
    assert.ok(visibleText(el(b, "recall-mode")).includes("Route practice: say them in order"));
    const nodes = nodesOf(el(b, "recall-map"));
    assert.deepEqual(nodes.map((n) => n.dataset.stationId), R1_IDS);
    assert.equal(nodes.filter((n) => n.classList.contains("lit")).length, 0, "nothing lit before speaking");
    assert.deepEqual(rejections, []);
  });
});

// Covers: MEM-051
// Requirement: JS sets no inline style except the scene zoom transform; no coordinate digits are shown.
describe("S1/S5 DOM scans (criteria 8, 9)", () => {
  const ZOOM_KEYS = new Set(["transform", "transformOrigin"]);

  test("no element carries a style attribute or inline style other than the zoom transform", async (t) => {
    const rejections = watchRejections(t);
    const { b } = await start();
    await openRoute(b, "Commute");
    for (const e of [...Object.values(b.p.els), ...b.p.madeByCode()]) {
      assert.equal(e.getAttribute("style"), null, `${e.tagName}#${e.id} has a style attribute`);
      const keys = Object.keys(e.style).filter((k) => typeof e.style[k] !== "function" && !ZOOM_KEYS.has(k));
      assert.deepEqual(keys, [], `${e.tagName}#${e.id} inline style ${keys.join(", ")}`);
    }
    assert.deepEqual(b.p.htmlWrites, []);
    assert.deepEqual(rejections, []);
  });

  test("no coordinate digits in visible text or non-geometry attributes on S1 or S5", async (t) => {
    const rejections = watchRejections(t);
    const { b } = await start();
    const s1 = visibleText(el(b, "routes-home"));
    await openRoute(b, "Commute");
    const texts = [s1, visibleText(el(b, "route-view")), visibleText(el(b, "history"))];
    for (const n of [...Object.values(b.p.els), ...b.p.madeByCode()]) {
      for (const [k, v] of Object.entries(n.attrs)) if (!["cx", "cy", "points", "r", "viewbox"].includes(k)) texts.push(v);
    }
    const blob = texts.join(" ");
    for (const [lat, lon] of COORDS) {
      for (const v of [lat, lon, Math.abs(lon)]) {
        for (const dp of [2, 3, 4]) assert.ok(!blob.includes(v.toFixed(dp)), `coordinate ${v.toFixed(dp)} rendered`);
      }
    }
    assert.deepEqual(rejections, []);
  });
});
