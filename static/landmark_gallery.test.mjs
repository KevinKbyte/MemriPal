// Covers: MEM-127
// Requirement: the Landmarks tab is a photo gallery (MEM-127, ADR 0081): galleryItems(routes) gives one tile per
// landmark across every route (same osm_id, else same case/space-insensitive name, is one landmark; nameless
// osm-less stations are each an "Untitled landmark"), unioning its routes in first-seen order and keeping the first
// non-empty photo; candidateItems(routes, pois) gives each route's auto-loci candidates (routes with >= 2 coord
// stations only), merged by candidate key and never a POI that is already a station on any route;
// filterGallery(items, {query, routeIds}) AND-matches name tokens and keeps items on ANY selected route.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { galleryItems, candidateItems, filterGallery, createLandmarkGallery } from "./landmark_gallery.js";
import { fakePage, find, findAll, settle, until } from "./fake_dom_test.mjs";
import { emojiFor } from "./landmark_emoji.js";

const st = (id, name, extra = {}) => ({ id, name, photo_ref: `p-${id}`, ...extra });
const at = (lat, lon) => ({ coords: { lat, lon } });

// rA runs north along lon -71.0900; rB crosses it east-west at lat 42.3610; rC has one coord station only.
const ROUTES = [
  { id: "rA", name: "Kendall Loop", stations: [
    st("a1", "MIT Dome", { osm_id: "n1", ...at(42.3600, -71.0900) }),
    st("a2", "Coffee Shop", at(42.3620, -71.0900)),
  ] },
  { id: "rB", name: "River Walk", stations: [
    st("b1", "Great Dome", { osm_id: "n1", ...at(42.3610, -71.0920) }),
    st("b2", "  coffee   SHOP ", at(42.3610, -71.0880)),
    st("b3", "Boathouse", { emoji: "\u{1F6A3}" }),
  ] },
  { id: "rC", name: "Harbor", stations: [
    st("c1", "Old Statue", { osm_id: "w9" }),
    st("c2", "", at(42.3700, -71.0500)),
    st("c3", ""),
  ] },
];

// Bakery + Library lie on rA, Library also on rB; w9 lies on rA but is rC's station c1; n104 is off every route.
const POIS = [
  { osm_id: "n101", name: "Bakery", lat: 42.3604, lng: -71.0900, address: "1 Main St", street: null },
  { osm_id: "n102", name: "Library", lat: 42.3610, lng: -71.0900, address: "2 Main St", street: null },
  { osm_id: "w9", name: "Statue Plaza", lat: 42.3616, lng: -71.0900, address: "3 Main St", street: null },
  { osm_id: "n104", name: "Far Cafe", lat: 42.3610, lng: -71.0800, address: "4 Main St", street: null },
];

const brief = (it) => ({ name: it.name, routes: it.routes, routeNames: it.routeNames });

// Covers: MEM-127
describe("galleryItems: one item per landmark across all routes", () => {
  test("dedupes by osm_id, then by normalized name; nameless osm-less stations stay separate", () => {
    const items = galleryItems(ROUTES);
    assert.deepEqual(items.map(brief), [
      { name: "MIT Dome", routes: ["rA", "rB"], routeNames: ["Kendall Loop", "River Walk"] },
      { name: "Coffee Shop", routes: ["rA", "rB"], routeNames: ["Kendall Loop", "River Walk"] },
      { name: "Boathouse", routes: ["rB"], routeNames: ["River Walk"] },
      { name: "Old Statue", routes: ["rC"], routeNames: ["Harbor"] },
      { name: "Untitled landmark", routes: ["rC"], routeNames: ["Harbor"] },
      { name: "Untitled landmark", routes: ["rC"], routeNames: ["Harbor"] },
    ]);
    assert.equal(new Set(items.map((i) => i.key)).size, items.length, "every item key is unique");
  });

  test("item carries candidate:false, osm_id (or null), the first-seen station and its photo_ref", () => {
    const [dome, coffee] = galleryItems(ROUTES);
    assert.equal(dome.candidate, false);
    assert.equal(dome.osm_id, "n1");
    assert.equal(dome.photo_ref, "p-a1");
    assert.equal(dome.station.id, "a1");
    assert.equal(coffee.osm_id, null);
  });

  test("emoji is station.emoji when set, else emojiFor({name})", () => {
    const items = galleryItems(ROUTES);
    assert.equal(items.find((i) => i.name === "Boathouse").emoji, "\u{1F6A3}");
    assert.equal(items.find((i) => i.name === "MIT Dome").emoji, emojiFor({ name: "MIT Dome" }));
  });

  test("photo_ref is the first non-empty one seen; null when none", () => {
    const items = galleryItems([
      { id: "r1", name: "One", stations: [{ id: "x1", name: "Arch", osm_id: "n5", photo_ref: "" }] },
      { id: "r2", name: "Two", stations: [{ id: "x2", name: "Arch", osm_id: "n5", photo_ref: "p-x2" },
        { id: "x3", name: "Gate", photo_ref: "" }] },
    ]);
    assert.deepEqual(items.map((i) => [i.name, i.photo_ref]), [["Arch", "p-x2"], ["Gate", null]]);
  });

  test("no routes, or routes without stations, give no items", () => {
    assert.deepEqual(galleryItems([]), []);
    assert.deepEqual(galleryItems([{ id: "r1", name: "Empty", stations: [] }]), []);
  });
});

// Covers: MEM-127
describe("candidateItems: auto-loci candidates per route", () => {
  test("rA's on-route POIs and rB's crossing POI, merged by key; station osm_ids on any route excluded", () => {
    const items = candidateItems(ROUTES, POIS);
    assert.deepEqual(items.map((i) => ({ key: i.key, ...brief(i) })).sort((a, b) => a.key.localeCompare(b.key)), [
      { key: "candidate:osm:n101", name: "Bakery", routes: ["rA"], routeNames: ["Kendall Loop"] },
      { key: "candidate:osm:n102", name: "Library", routes: ["rA", "rB"], routeNames: ["Kendall Loop", "River Walk"] },
    ]);
  });

  test("candidate item shape: candidate:true, photo_ref null, osm_id, emoji string", () => {
    const lib = candidateItems(ROUTES, POIS).find((i) => i.osm_id === "n102");
    assert.equal(lib.candidate, true);
    assert.equal(lib.photo_ref, null);
    assert.equal(typeof lib.emoji, "string");
    assert.ok(lib.emoji.length > 0);
  });

  test("a route with < 2 coord stations contributes none", () => {
    const near = [{ osm_id: "n200", name: "Pier", lat: 42.3700, lng: -71.0503, address: "9 Dock St", street: null }];
    assert.deepEqual(candidateItems([ROUTES[2]], near), []);
  });

  test("no pois gives no candidates", () => {
    assert.deepEqual(candidateItems(ROUTES, []), []);
  });
});

// Covers: MEM-127
describe("filterGallery: name search AND route union", () => {
  const items = galleryItems(ROUTES);
  const names = (out) => out.map((i) => i.name);

  test("empty query and no routes keep every item", () => {
    assert.equal(filterGallery(items, { query: "", routeIds: [] }).length, items.length);
  });

  test("query tokens are AND-matched, case-insensitive, on the name", () => {
    assert.deepEqual(names(filterGallery(items, { query: "dome", routeIds: [] })), ["MIT Dome"]);
    assert.deepEqual(names(filterGallery(items, { query: "DOME mit", routeIds: [] })), ["MIT Dome"]);
    assert.deepEqual(filterGallery(items, { query: "dome coffee", routeIds: [] }), []);
  });

  test("routeIds [rA, rC] keeps items on either route (union)", () => {
    assert.deepEqual(names(filterGallery(items, { query: "", routeIds: ["rA", "rC"] })),
      ["MIT Dome", "Coffee Shop", "Old Statue", "Untitled landmark", "Untitled landmark"]);
    assert.deepEqual(names(filterGallery(items, { query: "", routeIds: ["rB"] })),
      ["MIT Dome", "Coffee Shop", "Boathouse"]);
  });

  test("query and routeIds both apply", () => {
    assert.deepEqual(names(filterGallery(items, { query: "coffee", routeIds: ["rC"] })), []);
    assert.deepEqual(names(filterGallery(items, { query: "coffee", routeIds: ["rC", "rB"] })), ["Coffee Shop"]);
  });
});

// Requirement: createLandmarkGallery wires #tab-landmarks (MEM-127): a tile per landmark (photo when getPhotoUrl
// gives one, else the emoji; name + route names under it); #landmarks-search narrows by name; the route typeahead
// (#landmarks-route-input + datalist of unselected routes) adds a removable chip per exact route name and the grid
// shows the union of chosen routes; the On routes / Candidates radios switch to auto-loci candidates (which need a
// route); #landmarks-count says "<n> landmark(s)" / "<n> candidate(s)"; #landmarks-empty explains an empty grid;
// clicking a tile calls onOpen(item).
const IDS = ["landmarks-search", "landmarks-route-input", "landmarks-route-options", "landmarks-route-chips",
  "landmarks-show-on-routes", "landmarks-show-candidates", "landmarks-count", "landmarks-grid", "landmarks-empty",
  "landmarks-list"];

async function mount({ listRoutes = async () => structuredClone(ROUTES), pois = POIS,
  photos = { "p-a1": "blob:a1" } } = {}) {
  const page = fakePage(IDS, { hidden: ["landmarks-list"] });
  const { els } = page;
  Object.assign(els["landmarks-show-on-routes"],
    { type: "radio", name: "landmarks-show", value: "on-routes", checked: true });
  Object.assign(els["landmarks-show-candidates"],
    { type: "radio", name: "landmarks-show", value: "candidates", checked: false });
  els["landmarks-search"].value = "";
  els["landmarks-route-input"].value = "";
  const opened = [];
  const gallery = createLandmarkGallery({
    doc: page.doc,
    routes: { listRoutes },
    loadPois: async () => structuredClone(pois),
    onOpen: (item) => opened.push(item),
    getPhotoUrl: async (ref) => photos[ref] ?? null,
  });
  await gallery.refresh();
  await settle();
  return { ...page, gallery, opened };
}

const hasClass = (el, c) => el.classList.contains(c) || String(el.className ?? "").split(/\s+/).includes(c)
  || String(el.getAttribute("class") ?? "").split(/\s+/).includes(c);
const attr = (el, k) => el.getAttribute(k) ?? el[k];
const norm = (s) => String(s).replace(/\s+/g, " ").trim();
const byClass = (root, c) => findAll(root, (e) => hasClass(e, c));
const tiles = (p) => byClass(p.els["landmarks-grid"], "lg-tile");
const part = (tile, c) => norm(find(tile, (e) => hasClass(e, c))?.textContent ?? "");
const tileNames = (p) => tiles(p).map((t) => part(t, "lg-name"));
const tileOf = (p, name) => tiles(p).find((t) => part(t, "lg-name") === name);
const count = (p) => norm(p.els["landmarks-count"].textContent);
const empty = (p) => (p.els["landmarks-empty"].hidden ? null : norm(p.els["landmarks-empty"].textContent));
const chips = (p) => byClass(p.els["landmarks-route-chips"], "lg-chip");
const chipNames = (p) => chips(p).map((c) => norm(c.textContent));
const options = (p) => findAll(p.els["landmarks-route-options"], (e) => e.tagName === "OPTION")
  .map((o) => o.value || o.getAttribute("value") || norm(o.textContent));

async function type(p, id, value, event = "input") {
  p.els[id].value = value;
  p.fire(p.els[id], event);
  await settle();
}
async function show(p, mode) {
  p.els["landmarks-show-on-routes"].checked = mode === "on-routes";
  p.els["landmarks-show-candidates"].checked = mode === "candidates";
  p.fire(p.els[mode === "on-routes" ? "landmarks-show-on-routes" : "landmarks-show-candidates"], "change");
  await settle();
}
async function click(p, el) {
  p.fire(el, "click");
  await settle();
}

// Covers: MEM-127
describe("createLandmarkGallery: tiles, search, route chips, candidates, empty states", () => {
  test("refresh renders one tile per landmark: name + route names; count and empty state follow", async () => {
    const p = await mount();
    assert.deepEqual(tileNames(p), ["MIT Dome", "Coffee Shop", "Boathouse", "Old Statue", "Untitled landmark",
      "Untitled landmark"]);
    const dome = tileOf(p, "MIT Dome");
    assert.equal(dome.tagName, "BUTTON");
    assert.equal(attr(dome, "type"), "button");
    assert.equal(dome.parent?.tagName, "LI", "tile button sits in an li");
    assert.equal(part(dome, "lg-meta"), "Kendall Loop, River Walk");
    assert.equal(hasClass(dome, "lg-candidate"), false);
    assert.equal(count(p), "6 landmarks");
    assert.equal(empty(p), null, "#landmarks-empty hidden when the grid has tiles");
  });

  test("a tile with a photo shows img alt=\"\" src=url; one without shows its emoji", async () => {
    const p = await mount();
    const thumbOf = (name) => find(tileOf(p, name), (e) => hasClass(e, "lg-thumb"));
    const img = () => find(thumbOf("MIT Dome"), (e) => e.tagName === "IMG");
    await until(() => img()?.src === "blob:a1", "MIT Dome photo");
    assert.equal(img().getAttribute("alt") ?? img().alt, "");
    const coffee = thumbOf("Coffee Shop");
    assert.equal(find(coffee, (e) => e.tagName === "IMG"), null, "no photo => no img");
    assert.equal(norm(coffee.textContent), emojiFor({ name: "Coffee Shop" }));
  });

  test("#landmarks-search narrows tiles by name; no match shows 'No landmarks match.'", async () => {
    const p = await mount();
    await type(p, "landmarks-search", "dome");
    assert.deepEqual(tileNames(p), ["MIT Dome"]);
    assert.equal(count(p), "1 landmark");
    await type(p, "landmarks-search", "zzz");
    assert.deepEqual(tileNames(p), []);
    assert.equal(count(p), "0 landmarks");
    assert.equal(empty(p), "No landmarks match.");
    await type(p, "landmarks-search", "");
    assert.equal(tiles(p).length, 6);
  });

  test("datalist lists every route; an exact (case-insensitive) name adds a chip and clears the input", async () => {
    const p = await mount();
    assert.deepEqual(options(p), ["Kendall Loop", "River Walk", "Harbor"]);
    await type(p, "landmarks-route-input", "kendall loop");
    assert.deepEqual(chipNames(p), ["Kendall Loop"]);
    assert.equal(p.els["landmarks-route-input"].value, "");
    assert.deepEqual(options(p), ["River Walk", "Harbor"], "a selected route leaves the datalist");
    assert.deepEqual(tileNames(p), ["MIT Dome", "Coffee Shop"]);
    assert.equal(count(p), "2 landmarks");
  });

  test("a partial route name adds no chip and keeps the typed text", async () => {
    const p = await mount();
    await type(p, "landmarks-route-input", "Kend");
    assert.deepEqual(chips(p), []);
    assert.equal(p.els["landmarks-route-input"].value, "Kend");
    assert.equal(tiles(p).length, 6);
  });

  test("two routes selected (input + change events) show the union of their landmarks", async () => {
    const p = await mount();
    await type(p, "landmarks-route-input", "Kendall Loop");
    await type(p, "landmarks-route-input", "Harbor", "change");
    assert.deepEqual(chipNames(p), ["Kendall Loop", "Harbor"]);
    assert.deepEqual(tileNames(p), ["MIT Dome", "Coffee Shop", "Old Statue", "Untitled landmark", "Untitled landmark"]);
    assert.equal(count(p), "5 landmarks");
  });

  test("chip is li > button.lg-chip type=button aria-label 'Remove route <name>'; click removes it", async () => {
    const p = await mount();
    await type(p, "landmarks-route-input", "Kendall Loop");
    await type(p, "landmarks-route-input", "River Walk");
    const [kendall] = chips(p);
    assert.equal(kendall.tagName, "BUTTON");
    assert.equal(kendall.parent?.tagName, "LI");
    assert.equal(attr(kendall, "type"), "button");
    assert.equal(kendall.getAttribute("aria-label"), "Remove route Kendall Loop");
    await click(p, kendall);
    assert.deepEqual(chipNames(p), ["River Walk"]);
    assert.deepEqual(options(p), ["Kendall Loop", "Harbor"]);
    assert.deepEqual(tileNames(p), ["MIT Dome", "Coffee Shop", "Boathouse"]);
    await click(p, chips(p)[0]);
    assert.equal(tiles(p).length, 6, "no chips => every landmark");
  });

  test("Candidates mode with no route selected asks for one", async () => {
    const p = await mount();
    await show(p, "candidates");
    assert.deepEqual(tiles(p), []);
    assert.equal(count(p), "0 candidates");
    assert.equal(empty(p), "Pick a route to see its candidates.");
  });

  test("Candidates mode lists the chosen routes' candidates, never a POI already a station", async () => {
    const p = await mount();
    await show(p, "candidates");
    await type(p, "landmarks-route-input", "Kendall Loop");
    assert.deepEqual([...tileNames(p)].sort(), ["Bakery", "Library"]);
    assert.equal(count(p), "2 candidates");
    for (const t of tiles(p)) assert.equal(hasClass(t, "lg-candidate"), true, "candidate tiles carry lg-candidate");
    assert.equal(part(tileOf(p, "Bakery"), "lg-meta"), "Candidate - Kendall Loop");
    await type(p, "landmarks-route-input", "River Walk");
    assert.equal(part(tileOf(p, "Library"), "lg-meta"), "Candidate - Kendall Loop, River Walk");
    assert.equal(count(p), "2 candidates");
  });

  test("one candidate reads '1 candidate'; a route with none reads 'No landmarks match.'", async () => {
    const p = await mount();
    await show(p, "candidates");
    await type(p, "landmarks-route-input", "River Walk");
    assert.deepEqual(tileNames(p), ["Library"]);
    assert.equal(count(p), "1 candidate");
    await click(p, chips(p)[0]);
    await type(p, "landmarks-route-input", "Harbor");
    assert.deepEqual(tiles(p), []);
    assert.equal(empty(p), "No landmarks match.");
  });

  test("switching back to On routes restores landmark tiles", async () => {
    const p = await mount();
    await show(p, "candidates");
    await show(p, "on-routes");
    assert.equal(tiles(p).length, 6);
    assert.equal(tiles(p).some((t) => hasClass(t, "lg-candidate")), false);
    assert.equal(count(p), "6 landmarks");
  });

  test("no routes at all: 'No landmarks yet. Build a route to add some.'", async () => {
    const p = await mount({ listRoutes: async () => [] });
    assert.deepEqual(tiles(p), []);
    assert.equal(count(p), "0 landmarks");
    assert.equal(empty(p), "No landmarks yet. Build a route to add some.");
    assert.deepEqual(options(p), []);
  });

  test("refresh re-reads the route store", async () => {
    const live = structuredClone(ROUTES.slice(0, 1));
    const p = await mount({ listRoutes: async () => structuredClone(live) });
    assert.equal(tiles(p).length, 2);
    live.push(structuredClone(ROUTES[2]));
    await p.gallery.refresh();
    await settle();
    assert.equal(tiles(p).length, 5);
    assert.deepEqual(options(p), ["Kendall Loop", "Harbor"]);
  });

  test("clicking a tile calls onOpen(item) with that landmark or candidate", async () => {
    const p = await mount();
    await click(p, tileOf(p, "MIT Dome"));
    assert.equal(p.opened.length, 1);
    assert.equal(p.opened[0].name, "MIT Dome");
    assert.equal(p.opened[0].candidate, false);
    assert.deepEqual(p.opened[0].routes, ["rA", "rB"]);
    await show(p, "candidates");
    await type(p, "landmarks-route-input", "River Walk");
    await click(p, tileOf(p, "Library"));
    assert.equal(p.opened.length, 2);
    assert.equal(p.opened[1].candidate, true);
    assert.equal(p.opened[1].key, "candidate:osm:n102");
  });
});
