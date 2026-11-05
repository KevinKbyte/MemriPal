// Covers: MEM-142
// Requirement: clicking a Landmarks-tab gallery tile opens a detail dialog (MEM-142, ADR 0084):
// openGalleryDetail(item, { doc, getPhotoUrl, onOpenRoute, factsFor, opener }) shows one modal
// <dialog id="landmark-detail"> inside #tab-landmarks (showModal() when available, else open), reused on every
// open; its heading is the landmark name; the photo shows only for a blob: or data:image src, else the emoji;
// "On routes: A, B" with one "Open route" button per route (closes the dialog, then onOpenRoute(routeId)), or
// "Candidate for: A" with no Open route button for a candidate; the street address; coordinates at 5 dp with an
// "Open in Maps" Google Maps search link (target _blank, rel noopener); the station's multisensory profile
// entries; up to 3 facts from factsFor(station.id) with citation links (http/https hrefs only). A missing field
// renders nothing (no empty row or label). All text goes through textContent. The Close button, Escape and the
// dialog's close event close it and return focus to the opener; the returned { close } does the same.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { openGalleryDetail } from "./landmark_gallery_detail.js";
import { mountLandmarkGallery } from "./landmark_gallery.js";
import { fakePage, find, findAll, settle, until, deferred, SAFE_SRC } from "./fake_dom_test.mjs";

const EMOJI = "\u{1F3DB}";
const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const attr = (el, k) => el.getAttribute(k) ?? el[k] ?? null;

const routeItem = (over = {}) => ({
  key: "osm:n1", name: "MIT Dome", emoji: EMOJI, photo_ref: "p-a1", osm_id: "n1", candidate: false,
  routes: ["rA", "rB"], routeNames: ["Kendall Loop", "River Walk"],
  station: {
    id: "a1", n: 1, name: "MIT Dome", photo_ref: "p-a1", status: "named", address: "77 Massachusetts Ave",
    coords: { lat: 42.35954, lon: -71.09218 }, profile: { visual: "Grey dome", auditory: "Echoing hall" },
  },
  ...over,
});

const candidateItem = (over = {}) => ({
  key: "candidate:osm:n102", name: "Library", emoji: "\u{1F4DA}", photo_ref: null, osm_id: "n102", candidate: true,
  routes: ["rA"], routeNames: ["Kendall Loop"], station: null,
  poi: { key: "candidate:osm:n102", osm_id: "n102", name: "Library", lat: 42.3611, lng: -71.09005,
    address: "2 Main St", street: null, label: "Library" },
  ...over,
});

const FACTS = [
  { text: "Fact one about the dome.", title: "Dome - Wikipedia", url: "https://en.wikipedia.org/wiki/Dome" },
  { text: "Fact two about the dome.", title: "MIT - Wikipedia", url: "http://example.org/mit" },
  { text: "Fact three about the dome.", title: "Bad link", url: "javascript:alert(1)" },
  { text: "Fact four is one too many.", title: "Extra", url: "https://example.org/extra" },
];

/**
 * Fake page with #tab-landmarks. getElementById also finds elements the code appended under #tab-landmarks
 * (as a browser would). With native: true, a created <dialog> gets showModal()/close() whose `open` mirrors the
 * attribute and whose close() fires a "close" event, like the browser's HTMLDialogElement.
 */
function page({ native = true } = {}) {
  const p = fakePage(["tab-landmarks"], { hidden: [] });
  const roots = p.els;
  const byId = p.doc.getElementById;
  p.doc.getElementById = (id) => byId(id) ?? find(roots["tab-landmarks"], (e) => e.id === id);
  const showModalCalls = [];
  if (native) {
    const create = p.doc.createElement;
    p.doc.createElement = (tag) => {
      const e = create(tag);
      if (String(tag).toLowerCase() !== "dialog") return e;
      Object.defineProperty(e, "open", {
        get: () => e.getAttribute("open") !== null,
        set: (v) => (v ? e.setAttribute("open", "") : e.removeAttribute("open")),
        configurable: true,
      });
      e.showModal = () => {
        showModalCalls.push(e);
        e.setAttribute("open", "");
      };
      e.close = () => {
        if (e.getAttribute("open") === null) return;
        e.removeAttribute("open");
        p.fire(e, "close");
      };
      return e;
    };
  }
  const opener = p.doc.createElement("button");
  return { ...p, showModalCalls, opener };
}

const dialogsIn = (p) => findAll(p.els["tab-landmarks"], (e) => e.id === "landmark-detail");
const dialog = (p) => dialogsIn(p)[0] ?? null;
const isOpen = (d) => Boolean(d) && (d.open === true || d.getAttribute("open") !== null);
const text = (p) => norm(dialog(p)?.textContent);
const buttons = (p) => findAll(dialog(p), (e) => e.tagName === "BUTTON");
const openRouteButtons = (p) => buttons(p).filter((b) => /^open route/i.test(norm(b.textContent)));
const closeButton = (p) => buttons(p).find((b) => /^close$/i.test(norm(b.textContent))
  || /^close$/i.test(norm(b.getAttribute("aria-label"))));
const anchors = (p) => findAll(dialog(p), (e) => e.tagName === "A");
const heading = (p) => find(dialog(p), (e) => /^H[1-6]$/.test(e.tagName));
const img = (p) => find(dialog(p), (e) => e.tagName === "IMG");

async function open(p, item, opts = {}) {
  const opened = [];
  const handle = openGalleryDetail(item, {
    doc: p.doc,
    getPhotoUrl: async (ref) => (ref === "p-a1" ? "blob:a1" : null),
    onOpenRoute: (id) => opened.push({ id, dialogOpen: isOpen(dialog(p)) }),
    factsFor: (id) => (id === "a1" ? FACTS.slice(0, 3) : []),
    opener: p.opener,
    ...opts,
  });
  await settle();
  return { handle, opened };
}

// Covers: MEM-142
describe("openGalleryDetail: dialog shell, open and close", () => {
  test("opens one modal <dialog id=landmark-detail> inside #tab-landmarks via showModal()", async () => {
    const p = page();
    await open(p, routeItem());
    assert.equal(dialogsIn(p).length, 1);
    assert.equal(dialog(p).tagName, "DIALOG");
    assert.equal(dialog(p).parent, p.els["tab-landmarks"], "dialog is a child of #tab-landmarks");
    assert.equal(p.showModalCalls.length, 1, "showModal() used when the dialog supports it");
    assert.equal(isOpen(dialog(p)), true);
  });

  test("without showModal() support the dialog is still opened (open set)", async () => {
    const p = page({ native: false });
    await open(p, routeItem());
    assert.equal(dialog(p)?.tagName, "DIALOG");
    assert.equal(isOpen(dialog(p)), true);
  });

  test("the heading is the landmark name", async () => {
    const p = page();
    await open(p, routeItem());
    assert.equal(norm(heading(p)?.textContent), "MIT Dome");
  });

  test("the Close button closes the dialog and returns focus to the opener", async () => {
    const p = page();
    await open(p, routeItem());
    p.doc.activeElement = null;
    assert.ok(closeButton(p), "a Close button exists");
    p.fire(closeButton(p), "click");
    await settle();
    assert.equal(isOpen(dialog(p)), false);
    assert.equal(p.doc.activeElement, p.opener);
  });

  test("the dialog's close event (native Escape) returns focus to the opener", async () => {
    const p = page();
    await open(p, routeItem());
    p.doc.activeElement = null;
    const d = dialog(p);
    p.fire(d, "cancel");
    d.removeAttribute("open");
    p.fire(d, "close");
    await settle();
    assert.equal(isOpen(d), false);
    assert.equal(p.doc.activeElement, p.opener);
  });

  test("Escape keydown closes the dialog (also without native dialog support)", async () => {
    const p = page({ native: false });
    await open(p, routeItem());
    p.doc.activeElement = null;
    p.fire(dialog(p), "keydown", { key: "Escape" });
    await settle();
    assert.equal(isOpen(dialog(p)), false);
    assert.equal(p.doc.activeElement, p.opener);
  });

  test("the returned close() closes the dialog and refocuses the opener", async () => {
    const p = page();
    const { handle } = await open(p, routeItem());
    p.doc.activeElement = null;
    assert.equal(typeof handle?.close, "function");
    handle.close();
    await settle();
    assert.equal(isOpen(dialog(p)), false);
    assert.equal(p.doc.activeElement, p.opener);
  });

  test("reopening reuses the same dialog and replaces its content", async () => {
    const p = page();
    const { handle } = await open(p, routeItem());
    const first = dialog(p);
    handle.close();
    await open(p, candidateItem());
    assert.equal(dialogsIn(p).length, 1, "still one #landmark-detail");
    assert.equal(dialog(p), first, "same dialog element");
    assert.equal(isOpen(first), true);
    assert.equal(norm(heading(p)?.textContent), "Library");
    assert.equal(text(p).includes("MIT Dome"), false, "previous landmark's content is gone");
  });
});

// Covers: MEM-142
describe("openGalleryDetail: photo or emoji", () => {
  test("a blob: photo url renders an img with that src", async () => {
    const p = page();
    await open(p, routeItem());
    await until(() => img(p)?.src === "blob:a1", "blob photo");
  });

  test("a data:image url renders an img", async () => {
    const p = page();
    const src = "data:image/png;base64,AAAA";
    await open(p, routeItem(), { getPhotoUrl: async () => src });
    await until(() => img(p)?.src === src, "data:image photo");
  });

  test("no photo_ref, or a null url, shows the emoji and no img", async () => {
    for (const item of [routeItem({ photo_ref: null }), routeItem({ photo_ref: "p-none" })]) {
      const p = page();
      await open(p, item);
      assert.equal(img(p), null);
      assert.ok(text(p).includes(EMOJI), "emoji shown instead of the photo");
    }
  });

  test("a javascript: or non-image src is never rendered; the emoji shows instead", async () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,<script>x</script>", "https://evil.example/p.jpg"]) {
      const p = page();
      await open(p, routeItem(), { getPhotoUrl: async () => bad });
      assert.equal(img(p), null, `no img for ${bad}`);
      assert.deepEqual(p.srcWrites.filter((s) => !SAFE_SRC.test(s) && !s.startsWith("data:image/")), [],
        `unsafe src never assigned: ${bad}`);
      assert.ok(text(p).includes(EMOJI));
    }
  });

  test("a slow photo for a previous landmark never lands in the reopened dialog", async () => {
    const p = page();
    const slow = deferred();
    const { handle } = await open(p, routeItem(), { getPhotoUrl: () => slow.promise });
    handle.close();
    await open(p, routeItem({ key: "x", name: "Gate", photo_ref: null }));
    slow.resolve("blob:stale");
    await settle();
    assert.equal(norm(heading(p)?.textContent), "Gate");
    assert.equal(img(p), null, "stale photo dropped");
  });
});

// Covers: MEM-142
describe("openGalleryDetail: routes line and Open route buttons", () => {
  test("a route landmark reads 'On routes: A, B' with one Open route button per route", async () => {
    const p = page();
    await open(p, routeItem());
    assert.ok(text(p).includes("On routes: Kendall Loop, River Walk"), text(p));
    const btns = openRouteButtons(p);
    assert.equal(btns.length, 2);
    for (const b of btns) assert.equal(attr(b, "type"), "button");
  });

  test("Open route closes the dialog, then calls onOpenRoute(routeId)", async () => {
    const p = page();
    const { opened } = await open(p, routeItem());
    p.fire(openRouteButtons(p)[1], "click");
    await settle();
    assert.deepEqual(opened, [{ id: "rB", dialogOpen: false }]);
    assert.equal(isOpen(dialog(p)), false);
  });

  test("each Open route button opens its own route, in item.routes order", async () => {
    const ids = [];
    for (const at of [0, 1]) {
      const p = page();
      const { opened } = await open(p, routeItem());
      p.fire(openRouteButtons(p)[at], "click");
      await settle();
      ids.push(opened.map((o) => o.id));
    }
    assert.deepEqual(ids, [["rA"], ["rB"]]);
  });

  test("a candidate reads 'Candidate for: A' and has no Open route button", async () => {
    const p = page();
    await open(p, candidateItem());
    assert.ok(text(p).includes("Candidate for: Kendall Loop"), text(p));
    assert.equal(text(p).includes("On routes:"), false);
    assert.deepEqual(openRouteButtons(p), []);
  });
});

const mapsLink = (p) => anchors(p).find((a) => String(attr(a, "href")).startsWith("https://www.google.com/maps/"));
const query = (a) => new URL(String(attr(a, "href"))).searchParams;

// Covers: MEM-142
describe("openGalleryDetail: location", () => {
  test("a route landmark shows its address, 5 dp coords and an Open in Maps link", async () => {
    const p = page();
    await open(p, routeItem());
    assert.ok(text(p).includes("77 Massachusetts Ave"));
    assert.ok(text(p).includes("42.35954"), text(p));
    assert.ok(text(p).includes("-71.09218"), text(p));
    const a = mapsLink(p);
    assert.ok(a, "Open in Maps link");
    assert.equal(norm(a.textContent), "Open in Maps");
    assert.ok(String(attr(a, "href")).startsWith("https://www.google.com/maps/search/?api=1&query="));
    assert.equal(query(a).get("api"), "1");
    const [lat, lon] = String(query(a).get("query")).split(",").map(Number);
    assert.ok(Math.abs(lat - 42.35954) < 1e-5 && Math.abs(lon - -71.09218) < 1e-5, attr(a, "href"));
    assert.equal(attr(a, "target"), "_blank");
    assert.ok(String(attr(a, "rel")).split(/\s+/).includes("noopener"));
  });

  test("coordinates are rounded to 5 decimal places", async () => {
    const p = page();
    await open(p, routeItem({ station: { ...routeItem().station, coords: { lat: 42.123456789, lon: -71.1 } } }));
    assert.ok(text(p).includes("42.12346"), text(p));
    assert.ok(text(p).includes("-71.10000"), text(p));
    assert.equal(text(p).includes("42.123456789"), false);
  });

  test("lat/lon of 0 are real coordinates, not missing", async () => {
    const p = page();
    await open(p, routeItem({ station: { ...routeItem().station, coords: { lat: 0, lon: 0 } } }));
    assert.ok(text(p).includes("0.00000"), text(p));
    assert.ok(mapsLink(p), "maps link for 0,0");
  });

  test("a candidate uses poi.address and poi {lat, lng}", async () => {
    const p = page();
    await open(p, candidateItem());
    assert.ok(text(p).includes("2 Main St"));
    assert.ok(text(p).includes("42.36110"), text(p));
    assert.ok(text(p).includes("-71.09005"), text(p));
    const [lat, lon] = String(query(mapsLink(p)).get("query")).split(",").map(Number);
    assert.ok(Math.abs(lat - 42.3611) < 1e-5 && Math.abs(lon - -71.09005) < 1e-5);
  });

  test("non-finite coords give no coords text and no maps link", async () => {
    const p = page();
    await open(p, routeItem({ station: { ...routeItem().station, coords: { lat: Number.NaN, lon: "x" } } }));
    assert.ok(text(p).includes("77 Massachusetts Ave"), "dialog rendered");
    assert.equal(mapsLink(p), undefined);
    assert.equal(/NaN|undefined/.test(text(p)), false, text(p));
  });
});

// Covers: MEM-142
describe("openGalleryDetail: profile and facts", () => {
  test("station.profile entries render as key/value text", async () => {
    const p = page();
    await open(p, routeItem());
    for (const s of ["visual", "Grey dome", "auditory", "Echoing hall"]) assert.ok(text(p).includes(s), s);
  });

  test("facts come from factsFor(station.id), each with a citation link", async () => {
    const p = page();
    const asked = [];
    await open(p, routeItem(), { factsFor: (id) => (asked.push(id), FACTS.slice(0, 2)) });
    assert.ok(asked.includes("a1"), "factsFor called with station.id");
    assert.ok(text(p).includes("Fact one about the dome."));
    assert.ok(text(p).includes("Fact two about the dome."));
    const cite = anchors(p).find((a) => attr(a, "href") === "https://en.wikipedia.org/wiki/Dome");
    assert.ok(cite, "citation link for fact one");
    assert.equal(norm(cite.textContent), "Dome - Wikipedia");
    assert.ok(anchors(p).some((a) => attr(a, "href") === "http://example.org/mit"), "http: kept");
  });

  test("at most 3 facts render even if factsFor returns more", async () => {
    const p = page();
    await open(p, routeItem(), { factsFor: () => FACTS });
    assert.ok(text(p).includes("Fact three about the dome."));
    assert.equal(text(p).includes("Fact four is one too many."), false);
  });

  test("a non-http(s) citation url is never an href", async () => {
    const p = page();
    await open(p, routeItem(), { factsFor: () => FACTS.slice(0, 3) });
    for (const a of anchors(p)) assert.match(String(attr(a, "href")), /^https?:\/\//);
    assert.ok(text(p).includes("Fact three about the dome."), "the fact text still shows");
  });

  test("a candidate has no station, so no facts", async () => {
    const p = page();
    await open(p, candidateItem(), { factsFor: () => FACTS.slice(0, 1) });
    assert.equal(norm(heading(p)?.textContent), "Library");
    assert.equal(text(p).includes("Fact one about the dome."), false);
  });
});

// Covers: MEM-142
describe("openGalleryDetail: missing fields and untrusted text", () => {
  test("a landmark with no address, coords, profile or facts renders no row or label for them", async () => {
    const p = page();
    const bare = routeItem({ photo_ref: null, station: { id: "zz", n: 1, name: "Bare", photo_ref: "", status: "named",
      profile: {} } });
    await open(p, bare, { factsFor: () => [] });
    assert.equal(norm(heading(p)?.textContent), "MIT Dome");
    assert.deepEqual(anchors(p), [], "no maps or citation links");
    assert.equal(/address|coordinates|profile|facts|open in maps/i.test(text(p)), false, text(p));
    assert.equal(/undefined|null|NaN/.test(text(p)), false, text(p));
  });

  test("a candidate with no poi address or coords renders no location row", async () => {
    const p = page();
    await open(p, candidateItem({ poi: { key: "candidate:osm:n9", osm_id: "n9", name: "Spot", address: null } }));
    assert.ok(text(p).includes("Candidate for: Kendall Loop"), "dialog rendered");
    assert.deepEqual(anchors(p), []);
    assert.equal(/address|coordinates|open in maps|undefined|null|NaN/i.test(text(p)), false, text(p));
  });

  test("HTML-ish names and values are shown as literal text, never parsed", async () => {
    const p = page();
    const evil = "<img src=x onerror=alert(1)>";
    await open(p, routeItem({ name: evil, routeNames: [`<b>${"R"}</b>`, "River Walk"],
      station: { ...routeItem().station, address: "<i>addr</i>", profile: { "<k>": "<v>" } } }),
    { factsFor: () => [{ text: "<script>f</script>", title: "<t>", url: "https://example.org/" }] });
    assert.equal(norm(heading(p)?.textContent), evil);
    for (const s of ["<b>R</b>", "<i>addr</i>", "<k>", "<v>", "<script>f</script>", "<t>"]) {
      assert.ok(text(p).includes(s), s);
    }
    assert.deepEqual(p.htmlWrites, [], "no innerHTML/outerHTML/insertAdjacentHTML");
    assert.equal(img(p) === null || SAFE_SRC.test(img(p).src), true);
  });
});

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
describe("mountLandmarkGallery: a tile click opens the detail dialog", () => {
  test("clicking a mounted tile opens #landmark-detail; Open route calls onOpenRoute; close refocuses tile", async () => {
    const p = fakePage(IDS, { hidden: ["landmarks-list"] });
    const byId = p.doc.getElementById;
    p.doc.getElementById = (id) => byId(id) ?? find(p.els["tab-landmarks"], (e) => e.id === id);
    p.els["landmarks-search"].value = "";
    p.els["landmarks-route-input"].value = "";
    Object.assign(p.els["landmarks-show-on-routes"], { type: "radio", checked: true });
    Object.assign(p.els["landmarks-show-candidates"], { type: "radio", checked: false });
    const routes = { listRoutes: async () => structuredClone(ROUTES), getPhoto: async () => null };
    const fetchFn = async () => ({ ok: false, json: async () => null });
    const opened = [];
    mountLandmarkGallery(p.doc, routes, fetchFn, { onOpenRoute: (id) => opened.push(id) });
    const tileBtn = () => find(p.els["landmarks-grid"], (e) => e.tagName === "BUTTON"
      && norm(e.textContent).includes("MIT Dome"));
    await until(() => tileBtn(), "gallery tile rendered");
    p.fire(tileBtn(), "click");
    await settle();
    const d = find(p.els["tab-landmarks"], (e) => e.id === "landmark-detail");
    assert.ok(d, "#landmark-detail opened inside #tab-landmarks");
    assert.equal(isOpen(d), true);
    assert.equal(norm(find(d, (e) => /^H[1-6]$/.test(e.tagName))?.textContent), "MIT Dome");
    const close = findAll(d, (e) => e.tagName === "BUTTON").find((b) => /^close$/i.test(norm(b.textContent))
      || /^close$/i.test(norm(b.getAttribute("aria-label"))));
    p.doc.activeElement = null;
    p.fire(close, "click");
    await settle();
    assert.equal(isOpen(d), false);
    assert.equal(p.doc.activeElement, tileBtn(), "focus back on the opening tile");
    p.fire(tileBtn(), "click");
    await settle();
    assert.equal(isOpen(d), true, "reopened");
    const btns = findAll(d, (e) => e.tagName === "BUTTON" && /^open route/i.test(norm(e.textContent)));
    assert.equal(btns.length, 2);
    p.fire(btns[0], "click");
    await settle();
    assert.deepEqual(opened, ["rA"]);
    assert.equal(isOpen(d), false);
  });
});
