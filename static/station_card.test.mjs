// Covers: MEM-050
// Requirement: S3 Station card (plan B5). After a station is named by POST /station the card shows its
// name in #station-name, its Visual / Spatial / Conceptual profile in #station-profile, and four tap groups
// (#tap-sound #tap-smell #tap-feel #tap-mood; the Next turn group was removed, MEM-135) of toggle buttons with aria-pressed; a tap is stored
// on the station (one value per group, tapping the pressed button clears it) and survives a reload. A name
// edit is checked against the station-name shape rule (non-empty, <= 3 words, no digits) and the client
// uniqueness rule (normalized exact name, or a shared last word, with ANOTHER station of the route): a bad
// name shows #station-name-error and #station-save does not save it; the user renames, the capture never
// fails. A Spark name that clashes on arrival is shown in the input with the error, with no network retry.
// The capture upload sends the route's current station names as used_names (X-Memripal-Used-Names, a JSON
// array, B4). Drop is arm (#station-drop) -> #station-drop-confirm / #station-drop-cancel -> #station-undo,
// and Undo restores the identical station. Smell/taste copy never claims anything was "captured".
// Contract (RED; GREEN implements in static/station_card.js, wired from app.js):
//   createStationCard({ doc, store, routeId, fetch }) -> { show(stationId) -> Promise<void> }
//   doc is the page document (getElementById); store is route_store.js createRouteStore; the card renders
//   the tap buttons into each #tap-<group> element; taps persist as station.taps = { sound?, smell?, feel?,
//   mood? } holding the tapped label.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import * as rs from "./route_store.js";
import { fakePage, findAll, settle, visibleText } from "./fake_dom_test.mjs";
import { memoryAdapter, ENCODED, rawFile, fakeEncode, stationOk, fetchSpy } from "./route_store_fakes_test.mjs";

const CARD_IDS = [
  "station-card", "station-name", "station-name-error", "station-profile", "station-taps",
  "tap-sound", "tap-smell", "tap-feel", "tap-mood",
  "station-save", "station-drop", "station-drop-confirm", "station-drop-cancel", "station-undo",
];
const START_HIDDEN = ["station-name-error", "station-drop-confirm", "station-drop-cancel", "station-undo"];

// Part A S3 (plan lines 248-251).
const TAPS = {
  sound: ["Traffic", "Birds", "Water", "Voices", "Quiet", "Music"],
  smell: ["Food", "Coffee", "Flowers", "Fumes", "Rain", "None"],
  feel: ["Warm", "Cold", "Windy", "Uphill", "Stairs", "Shade"],
  mood: ["Calm", "Busy", "Bright", "Cosy", "Grand", "Odd"],
};

const PROFILE = { visual: "a red door with brass studs", spatial: "left of the path", conceptual: "an entry" };

const loadCard = async () => (await import("./station_card.js")).createStationCard;

/** A route with three named stations; the card shows the last one ("red door" unless overridden). */
async function setup({ names = ["brick wall", "oak tree", "red door"], fetch } = {}) {
  const kv = memoryAdapter();
  const store = rs.createRouteStore(kv);
  const route = await store.createRoute({ name: "Walk", kind: "daily" });
  const stations = [];
  for (const name of names) {
    const st = await store.addStation(route.id, { photo: ENCODED.slice() });
    stations.push(await store.nameStation(route.id, st.id, { name, profile: PROFILE }));
  }
  const p = fakePage(CARD_IDS, { hidden: START_HIDDEN });
  p.els["station-name"].value = "";
  const spy = fetchSpy([]);
  const createStationCard = await loadCard();
  const card = createStationCard({ doc: p.doc, store, routeId: route.id, fetch: fetch ?? spy.fn });
  return { kv, store, route, stations, p, card, spy, self: stations[stations.length - 1] };
}

const reloaded = async (ctx) => (await rs.createRouteStore(ctx.kv).getRoute(ctx.route.id)).stations;
const storedSelf = async (ctx) => (await reloaded(ctx)).find((s) => s.id === ctx.self.id);
const buttons = (ctx, group) => findAll(ctx.p.els[`tap-${group}`], (n) => n.tagName === "BUTTON");
const button = (ctx, group, label) => buttons(ctx, group).find((b) => b.textContent.trim() === label);
const pressed = (b) => b.getAttribute("aria-pressed");
const click = async (ctx, node) => {
  ctx.p.fire(node, "click");
  await settle();
};
const typeName = async (ctx, value) => {
  ctx.p.els["station-name"].value = value;
  ctx.p.fire(ctx.p.els["station-name"], "input");
  await settle();
};
const errorShown = (ctx) => !ctx.p.els["station-name-error"].hidden && ctx.p.els["station-name-error"].textContent.trim() !== "";

// Covers: MEM-050
// Requirement: the card renders the station's name and its Visual / Spatial / Conceptual profile.
describe("station card: name + profile", () => {
  test("show() puts the station name in #station-name and the profile in #station-profile", async () => {
    const ctx = await setup();
    await ctx.card.show(ctx.self.id);
    assert.equal(ctx.p.els["station-name"].value, "red door");
    const prof = visibleText(ctx.p.els["station-profile"]);
    for (const label of ["Visual", "Spatial", "Conceptual"]) assert.match(prof, new RegExp(label), `label ${label}`);
    for (const v of Object.values(PROFILE)) assert.ok(prof.includes(v), `profile text "${v}"`);
    assert.equal(errorShown(ctx), false, "no name error for a unique name");
  });
});

// Covers: MEM-050
// Requirement: each of the 4 tap groups toggles aria-pressed and persists the tap on the station
// (criterion 1).
describe("station card: quick-taps toggle aria-pressed and persist (4 groups)", () => {
  for (const [group, labels] of Object.entries(TAPS)) {
    test(`#tap-${group}: buttons ${labels.join("/")} toggle and persist`, async () => {
      const ctx = await setup();
      await ctx.card.show(ctx.self.id);
      assert.deepEqual(buttons(ctx, group).map((b) => b.textContent.trim()), labels, `#tap-${group} labels`);
      for (const b of buttons(ctx, group)) assert.equal(pressed(b), "false", `${b.textContent} starts unpressed`);

      const [first, second] = [labels[1], labels[2]];
      await click(ctx, button(ctx, group, first));
      assert.equal(pressed(button(ctx, group, first)), "true", `${first} pressed`);
      assert.equal(String((await storedSelf(ctx)).taps?.[group]).toLowerCase(), first.toLowerCase(), "tap persisted");

      await click(ctx, button(ctx, group, second));
      assert.equal(pressed(button(ctx, group, first)), "false", `${first} released when ${second} is tapped`);
      assert.equal(pressed(button(ctx, group, second)), "true", `${second} pressed`);
      assert.equal(String((await storedSelf(ctx)).taps?.[group]).toLowerCase(), second.toLowerCase(), "new tap persisted");

      await click(ctx, button(ctx, group, second));
      assert.equal(pressed(button(ctx, group, second)), "false", `tapping ${second} again releases it`);
      assert.equal((await storedSelf(ctx)).taps?.[group], undefined, "cleared tap persisted");
    });
  }

  test("a stored tap is shown pressed after a reload", async () => {
    const ctx = await setup();
    await ctx.card.show(ctx.self.id);
    await click(ctx, button(ctx, "mood", "Calm"));
    await click(ctx, button(ctx, "smell", "Coffee"));
    const fresh = { ...ctx, store: rs.createRouteStore(ctx.kv), p: fakePage(CARD_IDS, { hidden: START_HIDDEN }) };
    fresh.p.els["station-name"].value = "";
    fresh.card = (await loadCard())({ doc: fresh.p.doc, store: fresh.store, routeId: ctx.route.id, fetch: ctx.spy.fn });
    await fresh.card.show(ctx.self.id);
    assert.equal(pressed(button(fresh, "mood", "Calm")), "true");
    assert.equal(pressed(button(fresh, "smell", "Coffee")), "true");
    assert.equal(pressed(button(fresh, "sound", "Birds")), "false");
  });
});

// Covers: MEM-050
// Requirement: a name edit that breaks the shape rule or clashes with another station shows
// #station-name-error and is not saved; a good name saves (criterion 2, 6 cases).
describe("station card: name edit validation (criterion 2)", () => {
  const bad = [
    ["same name as another station (normalized)", "Brick  Wall"],
    ["shares the last word with another station", "stone wall"],
    ["4 words", "big old red door"],
    ["empty", "   "],
  ];
  for (const [label, value] of bad) {
    test(`${label}: "${value}" -> #station-name-error shown, #station-save does not save`, async () => {
      const ctx = await setup();
      await ctx.card.show(ctx.self.id);
      await typeName(ctx, value);
      assert.ok(errorShown(ctx), "#station-name-error is visible with a message");
      await click(ctx, ctx.p.els["station-save"]);
      assert.equal((await storedSelf(ctx)).name, "red door", "stored name unchanged");
      assert.ok(errorShown(ctx), "error still visible after the blocked save");
    });
  }

  const good = [
    ["2 words", "red bench"],
    ["3 words", "old garden gate"],
  ];
  for (const [label, value] of good) {
    test(`${label}: "${value}" -> no error, saved`, async () => {
      const ctx = await setup();
      await ctx.card.show(ctx.self.id);
      await typeName(ctx, value);
      assert.equal(errorShown(ctx), false, "no name error");
      await click(ctx, ctx.p.els["station-save"]);
      assert.equal((await storedSelf(ctx)).name, value);
    });
  }

  test("a name with a digit is refused (shape rule)", async () => {
    const ctx = await setup();
    await ctx.card.show(ctx.self.id);
    await typeName(ctx, "door 12");
    assert.ok(errorShown(ctx));
    await click(ctx, ctx.p.els["station-save"]);
    assert.equal((await storedSelf(ctx)).name, "red door");
  });

  test("the station's own current name never clashes with itself", async () => {
    const ctx = await setup();
    await ctx.card.show(ctx.self.id);
    await typeName(ctx, "red door");
    assert.equal(errorShown(ctx), false);
  });

  test("fixing a clashing name hides the error again", async () => {
    const ctx = await setup();
    await ctx.card.show(ctx.self.id);
    await typeName(ctx, "stone wall");
    assert.ok(errorShown(ctx));
    await typeName(ctx, "stone arch");
    assert.equal(errorShown(ctx), false);
  });
});

// Covers: MEM-050
// Requirement: a Spark name that clashes on arrival renders in the input with the error shown, the
// capture is not failed, and nothing is re-requested (criterion 3).
describe("station card: Spark name clash on arrival (criterion 3)", () => {
  test('"stone wall" arriving next to "brick wall" -> shown with error, station named, 0 retries', async (t) => {
    const globalFetch = t.mock.method(globalThis, "fetch", async () => {
      throw new Error("global fetch must not be called");
    });
    const capSpy = fetchSpy([() => stationOk("stone wall")]);
    const ctx = await setup({ names: ["brick wall", "oak tree"], fetch: capSpy.fn });
    const enc = fakeEncode();
    const session = rs.createCaptureSession({ store: ctx.store, routeId: ctx.route.id, fetch: capSpy.fn, encode: enc.encode });
    const st = await session.capture(rawFile());
    assert.equal(st?.status, "named", "the capture is not failed by the clash");
    ctx.self = st;

    await ctx.card.show(st.id);
    await settle();
    assert.equal(ctx.p.els["station-name"].value, "stone wall");
    assert.ok(errorShown(ctx), "#station-name-error shown on arrival");
    assert.equal(capSpy.calls.length, 1, "only the capture upload; no retry");
    assert.equal(globalFetch.mock.callCount(), 0, "no request via global fetch");
  });
});

// Covers: MEM-050
// Requirement: the capture upload tells the server the route's current station names (used_names) so
// Spark avoids them (B4 header X-Memripal-Used-Names, a JSON array).
describe("capture: used_names sent with the upload", () => {
  test("the POST /station carries the named stations' names", async () => {
    const kv = memoryAdapter();
    const store = rs.createRouteStore(kv);
    const route = await store.createRoute({ name: "Walk", kind: "daily" });
    for (const name of ["brick wall", "oak tree"]) {
      const s = await store.addStation(route.id, { photo: ENCODED.slice() });
      await store.nameStation(route.id, s.id, { name });
    }
    const spy = fetchSpy([() => stationOk("red door")]);
    const session = rs.createCaptureSession({ store, routeId: route.id, fetch: spy.fn, encode: fakeEncode().encode });
    await session.capture(rawFile());
    assert.equal(spy.calls.length, 1);
    const header = new Headers(spy.calls[0].init.headers ?? {}).get("x-memripal-used-names");
    assert.ok(header !== null, "X-Memripal-Used-Names header sent");
    assert.deepEqual(JSON.parse(header).sort(), ["brick wall", "oak tree"]);
  });
});

// Covers: MEM-050
// Requirement: drop is arm -> confirm (or cancel) -> Undo, and Undo restores the identical station
// (criterion 4; progressive-disclosure delete with Undo).
describe("station card: drop arm / cancel / confirm / Undo (criterion 4)", () => {
  test("first click arms, cancel restores, confirm removes, Undo restores the identical station", async () => {
    const ctx = await setup();
    await ctx.card.show(ctx.self.id);
    await click(ctx, button(ctx, "mood", "Busy"));
    const before = await reloaded(ctx);
    const e = ctx.p.els;
    assert.ok(e["station-drop-confirm"].hidden && e["station-drop-cancel"].hidden && e["station-undo"].hidden, "start unarmed");

    await click(ctx, e["station-drop"]);
    assert.equal(e["station-drop-confirm"].hidden, false, "confirm visible once armed");
    assert.equal(e["station-drop-cancel"].hidden, false, "cancel visible once armed");
    assert.equal((await reloaded(ctx)).length, 3, "arming drops nothing");

    await click(ctx, e["station-drop-cancel"]);
    assert.ok(e["station-drop-confirm"].hidden && e["station-drop-cancel"].hidden, "cancel disarms");
    assert.deepEqual(await reloaded(ctx), before, "cancel changes nothing");

    await click(ctx, e["station-drop"]);
    await click(ctx, e["station-drop-confirm"]);
    assert.deepEqual((await reloaded(ctx)).map((s) => s.id), before.slice(0, 2).map((s) => s.id), "confirm removes it");
    assert.equal(e["station-undo"].hidden, false, "Undo visible after the drop");

    await click(ctx, e["station-undo"]);
    assert.deepEqual(await reloaded(ctx), before, "Undo restores the identical station (same id, taps, place)");
    assert.equal(e["station-undo"].hidden, true, "Undo hidden again");
  });
});

// Covers: MEM-050
// Requirement: smell/taste copy never says anything was "captured" (criterion 5); the smell taps are
// the user's own note, not a sensor reading.
describe("station card: no 'captured' claim in rendered labels (criterion 5)", () => {
  test("tap labels and card copy never contain 'captured'", async () => {
    const ctx = await setup();
    await ctx.card.show(ctx.self.id);
    assert.equal(buttons(ctx, "smell").length, TAPS.smell.length, "smell taps rendered");
    const texts = [];
    for (const id of CARD_IDS) texts.push(ctx.p.els[id].textContent);
    for (const n of ctx.p.madeByCode()) {
      texts.push(n.textContent ?? "");
      for (const k of ["aria-label", "title", "aria-description"]) texts.push(n.getAttribute?.(k) ?? "");
    }
    const hits = texts.filter((s) => /captured/i.test(s));
    assert.deepEqual(hits, [], "no rendered label says captured");
  });
});
