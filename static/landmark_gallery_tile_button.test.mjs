// Covers: MEM-142
// Requirement: a Landmarks-tab gallery tile is keyboard-operable and opens the landmark detail dialog, never the
// photo file picker (MEM-142, ADR 0084; item 154): each tile is a native <button type="button">, so Enter and
// Space activate it by platform behavior, and activating it opens #landmark-detail without clicking any
// <input type="file">.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mountLandmarkGallery } from "./landmark_gallery.js";
import { fakePage, find, findAll, settle, until } from "./fake_dom_test.mjs";

const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const attr = (el, k) => el.getAttribute(k) ?? el[k] ?? null;
const isOpen = (d) => Boolean(d) && (d.open === true || d.getAttribute("open") !== null);

const IDS = ["landmarks-search", "landmarks-route-input", "landmarks-route-options", "landmarks-route-chips",
  "landmarks-show-on-routes", "landmarks-show-candidates", "landmarks-count", "landmarks-grid", "landmarks-empty",
  "landmarks-list", "tab-landmarks"];

const ROUTES = [
  { id: "rA", name: "Kendall Loop", stations: [
    { id: "a1", n: 1, name: "MIT Dome", photo_ref: "", status: "named", osm_id: "n1",
      coords: { lat: 42.36, lon: -71.09 } },
  ] },
  { id: "rB", name: "River Walk", stations: [
    { id: "b1", n: 1, name: "Great Dome", photo_ref: "", status: "named", osm_id: "n1" },
  ] },
];

// Covers: MEM-142
describe("mountLandmarkGallery: tile is a native button that opens the detail, not a file picker", () => {
  test("each tile is <button type=button>; a tile click opens #landmark-detail and clicks no file input", async () => {
    const p = fakePage(IDS, { hidden: ["landmarks-list"] });
    const byId = p.doc.getElementById;
    p.doc.getElementById = (id) => byId(id) ?? find(p.els["tab-landmarks"], (e) => e.id === id);
    const fileClicks = [];
    const spyClick = (e) => {
      e.click = () => fileClicks.push(e);
      return e;
    };
    const create = p.doc.createElement;
    p.doc.createElement = (tag) => {
      const e = create(tag);
      return String(tag).toLowerCase() === "input" ? spyClick(e) : e;
    };
    const picker = spyClick(create("input"));
    picker.type = "file";
    picker.setAttribute("type", "file");
    p.els["tab-landmarks"].append(picker);
    p.els["landmarks-search"].value = "";
    p.els["landmarks-route-input"].value = "";
    Object.assign(p.els["landmarks-show-on-routes"], { type: "radio", checked: true });
    Object.assign(p.els["landmarks-show-candidates"], { type: "radio", checked: false });
    const routes = { listRoutes: async () => structuredClone(ROUTES), getPhoto: async () => null };
    const fetchFn = async () => ({ ok: false, json: async () => null });
    mountLandmarkGallery(p.doc, routes, fetchFn, { onOpenRoute: () => {} });
    const tiles = () => findAll(p.els["landmarks-grid"], (e) => e.tagName === "BUTTON");
    await until(() => tiles().length > 0, "gallery tiles rendered");
    for (const t of tiles()) {
      assert.equal(attr(t, "type"), "button", "tile button has type=button");
      assert.equal(find(t, (e) => e.tagName === "INPUT"), null, "no input nested in the tile");
    }
    const tile = tiles().find((e) => norm(e.textContent).includes("MIT Dome"));
    assert.ok(tile, "MIT Dome tile rendered");
    p.fire(tile, "click");
    await settle();
    const d = find(p.els["tab-landmarks"], (e) => e.id === "landmark-detail");
    assert.ok(d, "#landmark-detail opened inside #tab-landmarks");
    assert.equal(isOpen(d), true);
    assert.deepEqual(fileClicks, [], "no file input was clicked");
  });
});
