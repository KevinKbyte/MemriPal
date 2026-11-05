// Covers: MEM-146
// Requirement: the MEM-143 landmark detail dialog (<dialog id="landmark-detail">) offers "No photo yet? Pull a
// street photo" (button class lm-pull-photo) only for a landmark with no user photo (item.photo_ref empty) and
// with coords (station coords, or a candidate's POI lat/lng); a landmark with a user photo never shows it, so a
// user photo is never replaced. openGalleryDetail(item, { doc, ..., fetchFn, pullStore }) passes fetchFn (the
// POST /baseline caller) and pullStore ({ get, set, clear }) to the pull UI. A pulled photo shows in the dialog
// as .lm-pull-photo-result img with a data:image/jpeg src (the dialog's photo rule is blob:/data:image only)
// beside its .lm-pull-photo-credit Mapillary credit.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { openGalleryDetail } from "./landmark_gallery_detail.js";
import { fakePage, find, findAll, settle, until, jsonResponse, SAFE_SRC } from "./fake_dom_test.mjs";

const PULL_TEXT = "No photo yet? Pull a street photo";
const PAGE = "https://www.mapillary.com/app/?pKey=";
const LICENCE = "CC BY-SA 4.0";
const T = { lat: 42.35954, lon: -71.09218 };
const south = (m) => ({ lat: T.lat - m / 111_195, lon: T.lon });
const jpeg = (id) => `data:image/jpeg;base64,/9j/${id}`;
const cand = (id, pos, over = {}) => ({
  image: jpeg(id), author: `user_${id}`, image_url: `${PAGE}${id}`, licence: LICENCE,
  compass_angle: null, captured_at: null, ...pos, ...over,
});
const FACING = cand("facing30", south(30), { compass_angle: 0 });
const AWAY = cand("away10", south(10), { compass_angle: 180 });

const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const srcOf = (n) => n.getAttribute("src") || n.src || "";
const hasClass = (n, c) => String(n.className ?? "").split(/\s+/).includes(c) || Boolean(n.classList?.contains?.(c));

const routeItem = (over = {}) => ({
  key: "osm:n1", name: "MIT Dome", emoji: "\u{1F3DB}", photo_ref: null, osm_id: "n1", candidate: false,
  routes: ["rA"], routeNames: ["Kendall Loop"],
  station: { id: "a1", n: 1, name: "MIT Dome", photo_ref: null, status: "named", coords: { ...T } },
  ...over,
});

const candidateItem = (over = {}) => ({
  key: "candidate:osm:n102", name: "Library", emoji: "\u{1F4DA}", photo_ref: null, osm_id: "n102", candidate: true,
  routes: ["rA"], routeNames: ["Kendall Loop"], station: null,
  poi: { key: "candidate:osm:n102", osm_id: "n102", name: "Library", lat: 42.3611, lng: -71.09005 },
  ...over,
});

function fakeStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    get: (k) => (map.has(k) ? map.get(k) : null),
    set: (k, v) => map.set(k, v),
    clear: (k) => map.delete(k),
  };
}

/** Fake page with #tab-landmarks whose getElementById also finds the appended dialog, as a browser would. */
function page() {
  const p = fakePage(["tab-landmarks"], { hidden: [] });
  const byId = p.doc.getElementById;
  p.doc.getElementById = (id) => byId(id) ?? find(p.els["tab-landmarks"], (e) => e.id === id);
  return p;
}

const dialog = (p) => find(p.els["tab-landmarks"], (e) => e.id === "landmark-detail");
const inDialog = (p, cls) => find(dialog(p), (n) => hasClass(n, cls), { visibleOnly: true });

async function open(p, item, { answer = { candidates: [AWAY, FACING] }, store = fakeStore() } = {}) {
  const calls = [];
  const fetchFn = async (path, init) => {
    calls.push({ path, init });
    return jsonResponse(answer);
  };
  openGalleryDetail(item, {
    doc: p.doc,
    getPhotoUrl: async (ref) => (ref === "p-a1" ? "blob:a1" : null),
    factsFor: () => [],
    fetchFn,
    pullStore: store,
  });
  await settle();
  return { calls, store };
}

// Covers: MEM-146
// Requirement: only a photo-less landmark with coords gets the pull button in the detail dialog; a user photo
// always wins and the dialog never offers to replace it, even when reopened after a photo-less landmark.
describe("openGalleryDetail: pull-photo entry", () => {
  test("a photo-less route landmark shows the .lm-pull-photo button inside #landmark-detail", async () => {
    const p = page();
    const { calls } = await open(p, routeItem());
    const btn = inDialog(p, "lm-pull-photo");
    assert.ok(btn, ".lm-pull-photo inside #landmark-detail");
    assert.equal(btn.tagName, "BUTTON");
    assert.equal(norm(btn.textContent), PULL_TEXT);
    assert.equal(calls.length, 0, "nothing fetched before a click");
  });

  test("a photo-less candidate landmark with POI coords also shows it", async () => {
    const p = page();
    await open(p, candidateItem());
    assert.ok(inDialog(p, "lm-pull-photo"));
  });

  test("a landmark with a user photo never shows it and fetches nothing (same landmark without one does)", async () => {
    const control = page();
    await open(control, routeItem());
    assert.ok(inDialog(control, "lm-pull-photo"), "control: the photo-less twin shows the button");
    const p = page();
    const { calls } = await open(p, routeItem({ photo_ref: "p-a1" }));
    assert.equal(inDialog(p, "lm-pull-photo"), null);
    assert.ok(!norm(dialog(p).textContent).includes(PULL_TEXT));
    assert.equal(calls.length, 0);
  });

  test("a photo-less landmark without coords gets no button (same landmark with coords does)", async () => {
    const control = page();
    await open(control, routeItem());
    assert.ok(inDialog(control, "lm-pull-photo"), "control: the twin with coords shows the button");
    const p = page();
    await open(p, routeItem({ station: { id: "a1", n: 1, name: "MIT Dome", photo_ref: null, coords: null } }));
    assert.equal(inDialog(p, "lm-pull-photo"), null);
  });

  test("reopening the dialog for a user-photo landmark drops the earlier pull button", async () => {
    const p = page();
    await open(p, routeItem());
    assert.ok(inDialog(p, "lm-pull-photo"));
    await open(p, routeItem({ key: "osm:n2", photo_ref: "p-a1" }));
    assert.equal(inDialog(p, "lm-pull-photo"), null);
  });
});

// Covers: MEM-146
// Requirement: pulling from the dialog POSTs the landmark's coords to /baseline and shows the best photo as a
// data:image/jpeg img (.lm-pull-photo-result img) with its credit (.lm-pull-photo-credit) inside the dialog;
// no img in the dialog ever gets a src outside blob:/data:image.
describe("openGalleryDetail: pulled photo in the dialog", () => {
  test("click pulls once and shows .lm-pull-photo-result img with a data:image/jpeg src", async () => {
    const p = page();
    const { calls, store } = await open(p, routeItem());
    p.fire(inDialog(p, "lm-pull-photo"), "click");
    await settle();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, "/baseline");
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.lat, T.lat);
    assert.equal(body.lon, T.lon);
    await until(() => inDialog(p, "lm-pull-photo-result"), ".lm-pull-photo-result in the dialog");
    const img = find(inDialog(p, "lm-pull-photo-result"), (n) => n.tagName === "IMG");
    assert.ok(img, ".lm-pull-photo-result img");
    assert.match(srcOf(img), /^data:image\/jpeg;base64,/);
    assert.equal(srcOf(img), FACING.image, "the facing candidate is auto-picked");
    assert.equal(store.get("osm:n1")?.image_url, FACING.image_url);
  });

  test("the credit shows inside the dialog beside the pulled photo", async () => {
    const p = page();
    await open(p, routeItem());
    p.fire(inDialog(p, "lm-pull-photo"), "click");
    await settle();
    const credit = inDialog(p, "lm-pull-photo-credit");
    assert.ok(credit, ".lm-pull-photo-credit in the dialog");
    assert.ok(norm(credit.textContent).includes(FACING.author));
    const hrefs = findAll(credit, (n) => n.tagName === "A").map((a) => a.getAttribute("href"));
    assert.ok(hrefs.includes(FACING.image_url));
  });

  test("every img src written in the dialog is blob: or data:image", async () => {
    const p = page();
    await open(p, routeItem());
    p.fire(inDialog(p, "lm-pull-photo"), "click");
    await settle();
    const imgs = findAll(dialog(p), (n) => n.tagName === "IMG");
    assert.ok(imgs.length >= 1);
    for (const img of imgs) assert.match(srcOf(img), SAFE_SRC);
    for (const s of p.srcWrites.map(String)) assert.match(s, SAFE_SRC);
  });

  test("a stored pulled choice shows on reopen without a fetch", async () => {
    const p = page();
    const { calls } = await open(p, routeItem(), { store: fakeStore({ "osm:n1": AWAY }) });
    assert.equal(calls.length, 0);
    const result = inDialog(p, "lm-pull-photo-result");
    assert.ok(result, ".lm-pull-photo-result shown from the stored choice");
    const img = find(result, (n) => n.tagName === "IMG");
    assert.ok(img);
    assert.equal(srcOf(img), AWAY.image);
  });
});
