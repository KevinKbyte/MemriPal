// Covers: MEM-146
// Requirement: in a landmark's detail view, a landmark with no user photo offers "No photo yet? Pull a street
// photo" (Kev, R83: demo the Mapillary pull for places the user has not visited; going there in person stays
// best). mountPullPhoto(container, item, { doc, fetchFn, store, onPhoto }) renders nothing at all when the
// item has a user photo (item.photo_ref): user photos always win and are never replaced. Otherwise a click
// pulls candidates, auto-picks the best (onPhoto(choice), store.set(item.key, choice)), shows the photo with
// its Mapillary CC BY-SA 4.0 credit and links, a picker of the other candidates (choosing one replaces the
// pulled choice), and an Undo that restores the pre-pull state (store cleared, onPhoto(null), the pull button
// back). No candidates -> "No street photos nearby". A stored choice shows again on reopen without a fetch.
// Text goes through textContent only; unsafe image URLs are never used.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import { fakePage, find, findAll, visibleText, settle, until, deferred, jsonResponse } from "./fake_dom_test.mjs";

const moduleUrl = new URL("./landmark_pull_photo.js", import.meta.url);

async function lp() {
  assert.ok(existsSync(moduleUrl), "static/landmark_pull_photo.js missing");
  return import(moduleUrl.href);
}

const PULL_TEXT = "No photo yet? Pull a street photo";
const PAGE = "https://www.mapillary.com/app/?pKey=";
const LICENCE = "CC BY-SA 4.0";
const LICENCE_URL = "https://creativecommons.org/licenses/by-sa/4.0/";
const T = { lat: 42.36, lon: -71.09 };
const south = (m) => ({ lat: T.lat - m / 111_195, lon: T.lon });
const cand = (id, pos, over = {}) => ({
  image: `data:image/jpeg;base64,/9j/${id}`, author: `user_${id}`, image_url: `${PAGE}${id}`,
  licence: LICENCE, ...pos, ...over,
});
// FACING ranks first: 30 m south facing north beats 10 m south facing south and 60 m south facing east.
const FACING = cand("facing30", south(30), { compass_angle: 0 });
const AWAY = cand("away10", south(10), { compass_angle: 180 });
const SIDE = cand("side60", south(60), { compass_angle: 90 });

const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const srcOf = (n) => n.getAttribute("src") || n.src || "";
const inButton = (n) => {
  for (let p = n.parent; p; p = p.parent) if (p.tagName === "BUTTON") return true;
  return false;
};

const item = (over = {}) => ({
  key: "osm:n1", name: "MIT Dome", photo_ref: null, candidate: false,
  station: { id: "a1", coords: { lat: T.lat, lon: T.lon } }, poi: null, ...over,
});

function fakeStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  const sets = [];
  const clears = [];
  return {
    map, sets, clears,
    get: (k) => (map.has(k) ? map.get(k) : null),
    set: (k, v) => (sets.push([k, v]), map.set(k, v)),
    clear: (k) => (clears.push(k), map.delete(k)),
  };
}

async function mount({ it = item(), answer = { candidates: [AWAY, SIDE, FACING] }, respond, store = fakeStore() } = {}) {
  const { mountPullPhoto } = await lp();
  const page = fakePage(["pull-host"]);
  const host = page.els["pull-host"];
  const calls = [];
  const fetchFn = async (path, init) => {
    calls.push({ path, init });
    return respond ? respond(path, init) : jsonResponse(answer);
  };
  const photos = [];
  mountPullPhoto(host, it, { doc: page.doc, fetchFn, store, onPhoto: (c) => photos.push(c) });
  await settle();
  const ui = {
    page, host, calls, store, photos,
    pullButton: () => find(host, (n) => n.tagName === "BUTTON" && norm(n.textContent) === PULL_TEXT, { visibleOnly: true }),
    undoButton: () => find(host, (n) => n.tagName === "BUTTON" && norm(n.textContent) === "Undo", { visibleOnly: true }),
    mainPhoto: () => find(host, (n) => n.tagName === "IMG" && !inButton(n) && /^(https?:|javascript:|data:image\/)/i.test(srcOf(n)), { visibleOnly: true }),
    pickerButtons: () => findAll(host, (n) => n.tagName === "BUTTON"
      && findAll(n, (c) => c.tagName === "IMG").some((img) => [FACING, AWAY, SIDE].some((c) => c.image === srcOf(img))), { visibleOnly: true }),
    pickerFor: (c) => find(host, (n) => n.tagName === "BUTTON"
      && findAll(n, (x) => x.tagName === "IMG").some((img) => srcOf(img) === c.image), { visibleOnly: true }),
    anchors: () => findAll(host, (n) => n.tagName === "A", { visibleOnly: true }),
    text: () => norm(visibleText(host)),
  };
  ui.pull = async () => {
    page.fire(ui.pullButton(), "click");
    await settle();
  };
  return ui;
}

// Covers: MEM-146
// Requirement: user photos always win: a landmark with a user photo shows no pull UI at all, makes no
// request and never touches the stored choice, even when an older pulled choice is stored for it.
describe("mountPullPhoto: user photo wins", () => {
  test("photo_ref set: container stays empty and nothing is fetched", async () => {
    const ui = await mount({ it: item({ photo_ref: "p-a1" }) });
    assert.equal(ui.host.children.length, 0);
    assert.equal(ui.calls.length, 0);
    assert.equal(ui.store.sets.length, 0);
  });

  test("photo_ref set with a stored pulled choice: still nothing rendered, choice untouched", async () => {
    const store = fakeStore({ "osm:n1": FACING });
    const ui = await mount({ it: item({ photo_ref: "p-a1" }), store });
    assert.equal(ui.host.children.length, 0);
    assert.equal(ui.photos.length, 0);
    assert.deepEqual(store.clears, []);
  });
});

// Covers: MEM-146
// Requirement: a landmark without a user photo shows the pull button; a click fetches once (the button is
// disabled while in flight), auto-picks the best-ranked candidate, persists it and reports it, and shows the
// photo with its Mapillary credit (contributor, original-image link and CC BY-SA 4.0 licence link, new tab,
// rel noopener) plus a picker of the other candidates only.
describe("mountPullPhoto: pull and auto-pick", () => {
  test("shows exactly the pull button and does not fetch before a click", async () => {
    const ui = await mount();
    assert.ok(ui.pullButton(), `pull button with text "${PULL_TEXT}"`);
    assert.equal(ui.calls.length, 0);
    assert.equal(ui.mainPhoto(), null);
  });

  test("click POSTs /baseline once and auto-sets the best candidate", async () => {
    const ui = await mount();
    await ui.pull();
    assert.equal(ui.calls.length, 1);
    assert.equal(ui.calls[0].path, "/baseline");
    await until(() => ui.mainPhoto(), "pulled photo shown");
    assert.equal(srcOf(ui.mainPhoto()), FACING.image);
    assert.equal(ui.photos.length, 1);
    assert.equal(ui.photos[0].image_url, FACING.image_url);
    assert.equal(ui.store.sets.length, 1);
    assert.equal(ui.store.sets[0][0], "osm:n1");
    assert.equal(ui.store.get("osm:n1").image_url, FACING.image_url);
    assert.equal(ui.pullButton(), null, "pull button gone once a photo is shown");
  });

  test("the shown photo carries its Mapillary credit and links", async () => {
    const ui = await mount();
    await ui.pull();
    assert.ok(ui.text().includes(FACING.author), "contributor shown");
    const hrefs = ui.anchors().map((a) => a.getAttribute("href"));
    assert.ok(hrefs.includes(FACING.image_url), "link to the original Mapillary image");
    const lic = ui.anchors().find((a) => a.getAttribute("href") === LICENCE_URL);
    assert.ok(lic, "licence link");
    assert.equal(norm(lic.textContent), LICENCE);
    for (const a of ui.anchors()) {
      assert.match(a.getAttribute("href"), /^https:\/\//);
      assert.equal(a.getAttribute("target"), "_blank");
      assert.match(a.getAttribute("rel") ?? "", /noopener/);
    }
  });

  test("the picker lists the other candidates, not the auto-picked one", async () => {
    const ui = await mount();
    await ui.pull();
    assert.equal(ui.pickerButtons().length, 2);
    assert.ok(ui.pickerFor(AWAY));
    assert.ok(ui.pickerFor(SIDE));
    assert.equal(ui.pickerFor(FACING), null);
  });

  test("double click while in flight fetches once; the button is disabled meanwhile", async () => {
    const gate = deferred();
    const ui = await mount({ respond: () => gate.promise });
    const btn = ui.pullButton();
    ui.page.fire(btn, "click");
    ui.page.fire(btn, "click");
    await settle();
    assert.equal(ui.calls.length, 1);
    assert.equal(btn.disabled, true);
    gate.resolve(jsonResponse({ candidates: [FACING] }));
    await until(() => ui.mainPhoto(), "photo after the slow fetch");
    assert.equal(ui.calls.length, 1);
  });
});

// Covers: MEM-146
// Requirement: choosing another candidate in the picker replaces the pulled choice (photo, credit, store,
// onPhoto); Undo always restores the pre-pull state: store cleared, onPhoto(null), no photo, pull button back.
describe("mountPullPhoto: picker and Undo", () => {
  test("choosing another candidate replaces the pulled choice", async () => {
    const ui = await mount();
    await ui.pull();
    ui.page.fire(ui.pickerFor(AWAY), "click");
    await settle();
    assert.equal(srcOf(ui.mainPhoto()), AWAY.image);
    assert.equal(ui.store.get("osm:n1").image_url, AWAY.image_url);
    assert.equal(ui.photos.at(-1).image_url, AWAY.image_url);
    assert.ok(ui.text().includes(AWAY.author), "credit follows the chosen photo");
    assert.ok(ui.anchors().some((a) => a.getAttribute("href") === AWAY.image_url));
  });

  test("Undo after the auto-pick restores the pre-pull state", async () => {
    const ui = await mount();
    await ui.pull();
    ui.page.fire(ui.undoButton(), "click");
    await settle();
    assert.equal(ui.store.get("osm:n1"), null);
    assert.deepEqual(ui.store.clears, ["osm:n1"]);
    assert.equal(ui.photos.at(-1), null);
    assert.equal(ui.mainPhoto(), null);
    assert.ok(ui.pullButton(), "pull button back");
  });

  test("Undo after choosing another candidate still restores the pre-pull state", async () => {
    const ui = await mount();
    await ui.pull();
    ui.page.fire(ui.pickerFor(SIDE), "click");
    await settle();
    ui.page.fire(ui.undoButton(), "click");
    await settle();
    assert.equal(ui.store.get("osm:n1"), null);
    assert.equal(ui.photos.at(-1), null);
    assert.equal(ui.mainPhoto(), null);
    assert.ok(ui.pullButton());
  });

  test("pull again after Undo works", async () => {
    const ui = await mount();
    await ui.pull();
    ui.page.fire(ui.undoButton(), "click");
    await settle();
    await ui.pull();
    assert.equal(ui.calls.length, 2);
    assert.equal(srcOf(ui.mainPhoto()), FACING.image);
  });
});

// Covers: MEM-146
// Requirement: no nearby candidates shows "No street photos nearby"; a backend failure never throws and
// leaves the pull button for a retry; neither case stores or reports a photo.
describe("mountPullPhoto: empty and failure", () => {
  test("no candidates: a short message, nothing stored or reported", async () => {
    const ui = await mount({ answer: { candidates: [] } });
    await ui.pull();
    assert.ok(ui.text().includes("No street photos nearby"));
    assert.equal(ui.store.sets.length, 0);
    assert.equal(ui.photos.length, 0);
    assert.equal(ui.mainPhoto(), null);
  });

  for (const [label, respond] of [
    ["502", () => jsonResponse({ error: "upstream" }, 502)],
    ["rejected fetch", () => Promise.reject(new TypeError("network down"))],
  ]) {
    test(`${label}: no throw, nothing stored, pull button stays for a retry`, async () => {
      const ui = await mount({ respond });
      await ui.pull();
      assert.equal(ui.store.sets.length, 0);
      assert.equal(ui.photos.length, 0);
      assert.equal(ui.mainPhoto(), null);
      const btn = ui.pullButton();
      assert.ok(btn, "pull button still offered");
      assert.equal(btn.disabled, false);
    });
  }
});

// Covers: MEM-146
// Requirement: a pulled choice persists across dialog reopen: mounting with a stored choice shows that photo
// and its credit at once, with no fetch and no pull button; Undo from there brings the pull button back.
describe("mountPullPhoto: reopen", () => {
  test("a stored choice shows without a fetch", async () => {
    const ui = await mount({ store: fakeStore({ "osm:n1": AWAY }) });
    assert.equal(ui.calls.length, 0);
    assert.equal(srcOf(ui.mainPhoto()), AWAY.image);
    assert.ok(ui.text().includes(AWAY.author));
    assert.equal(ui.pullButton(), null);
    ui.page.fire(ui.undoButton(), "click");
    await settle();
    assert.equal(ui.store.get("osm:n1"), null);
    assert.ok(ui.pullButton());
  });
});

// Covers: MEM-146
// Requirement: the demo video and its screenshot script drive the pull by stable class hooks: the pull button
// carries class lm-pull-photo, the pulled photo is an img inside an element with class lm-pull-photo-result, and
// its Mapillary credit (author, image link, CC BY-SA 4.0 licence link) sits inside class lm-pull-photo-credit.
describe("mountPullPhoto: selector contract", () => {
  const hasClass = (n, c) => String(n.className ?? "").split(/\s+/).includes(c) || Boolean(n.classList?.contains?.(c));
  const byClass = (root, c) => find(root, (n) => hasClass(n, c), { visibleOnly: true });

  test("the pull button is a BUTTON with class lm-pull-photo", async () => {
    const ui = await mount();
    const btn = byClass(ui.host, "lm-pull-photo");
    assert.ok(btn, ".lm-pull-photo present before a pull");
    assert.equal(btn.tagName, "BUTTON");
    assert.equal(btn, ui.pullButton());
  });

  test("the pulled photo is an img inside .lm-pull-photo-result", async () => {
    const ui = await mount();
    await ui.pull();
    const result = byClass(ui.host, "lm-pull-photo-result");
    assert.ok(result, ".lm-pull-photo-result present after a pull");
    const img = find(result, (n) => n.tagName === "IMG");
    assert.ok(img, ".lm-pull-photo-result img");
    assert.equal(srcOf(img), FACING.image);
    assert.equal(img, ui.mainPhoto());
  });

  test("the credit sits inside .lm-pull-photo-credit and follows the chosen photo", async () => {
    const ui = await mount();
    await ui.pull();
    const credit = () => byClass(ui.host, "lm-pull-photo-credit");
    assert.ok(credit(), ".lm-pull-photo-credit present after a pull");
    assert.ok(norm(visibleText(credit())).includes(FACING.author));
    const hrefs = () => findAll(credit(), (n) => n.tagName === "A").map((a) => a.getAttribute("href"));
    assert.ok(hrefs().includes(FACING.image_url));
    assert.ok(hrefs().includes(LICENCE_URL));
    ui.page.fire(ui.pickerFor(AWAY), "click");
    await settle();
    assert.ok(norm(visibleText(credit())).includes(AWAY.author));
    assert.ok(hrefs().includes(AWAY.image_url));
  });

  test("before a pull there is no result or credit; after Undo neither remains", async () => {
    const ui = await mount();
    assert.equal(byClass(ui.host, "lm-pull-photo-result"), null);
    assert.equal(byClass(ui.host, "lm-pull-photo-credit"), null);
    await ui.pull();
    ui.page.fire(ui.undoButton(), "click");
    await settle();
    assert.equal(byClass(ui.host, "lm-pull-photo-result"), null);
    assert.equal(byClass(ui.host, "lm-pull-photo-credit"), null);
    assert.ok(byClass(ui.host, "lm-pull-photo"), ".lm-pull-photo back after Undo");
  });
});

// Covers: MEM-146
// Requirement: pulled text goes through textContent only (no innerHTML), and an unsafe image URL from the
// backend is never assigned to an img src.
describe("mountPullPhoto: safety", () => {
  test("markup in an author name is shown as text; no innerHTML writes", async () => {
    const evil = cand("evil", south(5), { compass_angle: 0, author: "<img src=x onerror=alert(1)>" });
    const ui = await mount({ answer: { candidates: [evil] } });
    await ui.pull();
    assert.deepEqual(ui.page.htmlWrites, []);
    assert.ok(ui.text().includes("<img src=x onerror=alert(1)>"));
  });

  test("javascript: and http: candidate images are never used as a src", async () => {
    const bad1 = cand("bad1", south(5), { compass_angle: 0, image: "javascript:alert(1)" });
    const bad2 = cand("bad2", south(6), { compass_angle: 0, image: "http://scontent.xx.fbcdn.net/m1/b.jpg" });
    const ui = await mount({ answer: { candidates: [bad1, bad2, FACING] } });
    await ui.pull();
    const writes = ui.page.srcWrites.map(String);
    assert.ok(!writes.some((s) => /^(javascript:|http:)/i.test(s)), `unsafe src written: ${writes.join(", ")}`);
    assert.equal(srcOf(ui.mainPhoto()), FACING.image);
  });

  test("a non-data:image/jpeg candidate (https:, png) never renders as an img", async () => {
    const https = cand("https1", south(5), { compass_angle: 0, image: "https://scontent.xx.fbcdn.net/m1/h.jpg" });
    const png = cand("png1", south(6), { compass_angle: 0, image: "data:image/png;base64,iVBORw0KGgo=" });
    const ui = await mount({ answer: { candidates: [https, png, FACING] } });
    await ui.pull();
    const imgs = findAll(ui.host, (n) => n.tagName === "IMG");
    assert.ok(imgs.length >= 1, "the safe candidate renders");
    for (const img of imgs) assert.match(srcOf(img), /^data:image\/jpeg;base64,/);
    for (const s of ui.page.srcWrites.map(String)) assert.match(s, /^data:image\/jpeg;base64,/);
    assert.equal(srcOf(ui.mainPhoto()), FACING.image);
  });
});
