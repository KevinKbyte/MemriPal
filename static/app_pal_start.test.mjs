// Covers: MEM-082
// Requirement: the start screen shows Pal (#empty-state, pal-idle.svg, blinking). Under
// prefers-reduced-motion: reduce the page swaps it to the motionless /static/assets/pal-still.svg; with
// no reduced-motion preference, or no matchMedia at all, Pal stays the idle SVG. Pal is the empty state
// of the whole start screen, so it is hidden once any route exists, not only once a palace renders: a
// route already in the route store at start-up hides it, and so does the Kendall demo route that Load
// demo seeds (MEM-077), even when the room demo on that click fails. With no route and no palace Pal
// stays shown. Seam: wireApp's deps.matchMedia(query) -> { matches } (window.matchMedia in the browser,
// handed over by app.js's bootstrap) and deps.routes (a route_store.js store).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { fakePage, findAll, jsonResponse, memoryAdapter, record, settle, until } from "./fake_dom_test.mjs";
import { memoryAdapter as routeAdapter } from "./route_store_fakes_test.mjs";
import { wireApp } from "./flow.js";
import { createPalaceStore } from "./palace_store.js";
import { createRehearsalStore } from "./rehearsals.js";
import { createRouteStore } from "./route_store.js";
import { DEMO_ROUTE } from "./demo_route.js";

const HTML = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const TIMELINE = JSON.parse(readFileSync(new URL("../fixtures/demo/recall_timeline.json", import.meta.url), "utf8"));
const IDLE = "/static/assets/pal-idle.svg";
const STILL = "/static/assets/pal-still.svg";
const REDUCE = "(prefers-reduced-motion: reduce)";
const TURNS = 5000;
const IMAGE = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==";
const LOCI = ["lamp", "door", "clock"].map((label, i) => ({ n: i + 1, label, box: { x1: 10 + i * 60, y1: 10, x2: 60 + i * 60, y2: 200 } }));
const POINTS = ["one", "two", "three"].map((label) => ({ label, source_quote: label }));

/** The index.html page; #empty-state starts with the src index.html gives it. */
function pageFromHtml() {
  const ids = [];
  const hidden = [];
  for (const m of HTML.matchAll(/<[a-z][a-z0-9]*\b[^>]*>/gi)) {
    const id = /\bid="([^"]+)"/.exec(m[0]);
    if (!id) continue;
    ids.push(id[1]);
    if (/\shidden(?=[\s>=/])/.test(m[0])) hidden.push(id[1]);
  }
  const page = fakePage(ids, { hidden });
  const tag = /<img\b[^>]*\bid="empty-state"[^>]*>/.exec(HTML);
  const src = tag && /\bsrc="([^"]*)"/.exec(tag[0]);
  if (src && page.els["empty-state"]) page.els["empty-state"].src = src[1];
  return page;
}

/** Demo server; `loci()` answers POST /loci. */
function server(loci = () => jsonResponse({ image: IMAGE, width: 800, height: 600, loci: LOCI })) {
  return async (url, init = {}) => {
    const u = String(url);
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    if (u === "/demo/photo.jpg") return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), { headers: { "content-type": "image/jpeg" } });
    if (u === "/demo/notes.txt") return new Response("notes", { headers: { "content-type": "text/plain" } });
    if (u === "/demo/recall.json") return jsonResponse(TIMELINE);
    if (u === "/loci") return loci();
    if (u === "/split") return jsonResponse({ points: POINTS });
    if (u === "/associate") return jsonResponse({ record: record(body.item, body.locus), status: "valid", sig: `sig_${body.item}` });
    if (u === "/scenes") return jsonResponse({ tier: 1, image: IMAGE, width: 800, height: 600 });
    return jsonResponse({ error: "not_found" }, 404);
  };
}

/** A matchMedia whose only matching query is prefers-reduced-motion: reduce (when `reduce`). */
function media(reduce) {
  const norm = (q) => String(q).replace(/\s+/g, "").toLowerCase();
  return (query) => ({
    matches: reduce && norm(query) === norm(REDUCE),
    media: String(query),
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });
}

function kvAdapter() {
  const map = new Map();
  return { get: async (k) => map.get(k), put: async (k, v) => void map.set(k, v), delete: async (k) => void map.delete(k), list: async () => [...map.values()] };
}

/** Page start-up as app.js does it. opts: matchMedia (omitted when undefined), routes, loci. */
async function boot(opts = {}) {
  const p = pageFromHtml();
  let n = 0;
  let t = Date.UTC(2026, 10, 3, 9, 0, 0);
  wireApp({
    doc: p.doc,
    fetch: server(opts.loci),
    store: createPalaceStore(memoryAdapter()),
    rehearsals: createRehearsalStore(kvAdapter(), { now: () => (t += 60_000), newId: () => `reh-${++n}` }),
    getUserMedia: undefined,
    location: { hostname: "localhost" },
    loadImage: async (src) => ({ src }),
    confirm: () => true,
    wait: async () => {},
    ...(opts.matchMedia ? { matchMedia: opts.matchMedia } : {}),
    ...(opts.routes ? { routes: opts.routes } : {}),
  });
  await settle(20);
  return p;
}

const pal = (p) => {
  const e = p.els["empty-state"];
  assert.ok(e, "index.html must contain #empty-state");
  return e;
};
const cards = (p) => findAll(p.els["routes-list"], (n) => n.tagName === "LI", { visibleOnly: true });

// Covers: MEM-082
// Requirement: index.html gives #empty-state the idle Pal; reduced motion swaps it to the still Pal.
describe("start-screen Pal honours prefers-reduced-motion (MEM-082)", () => {
  test("index.html starts #empty-state on the idle Pal", () => {
    const tag = /<img\b[^>]*\bid="empty-state"[^>]*>/.exec(HTML);
    assert.ok(tag, "index.html has no <img id=\"empty-state\">");
    assert.match(tag[0], /\bsrc="\/static\/assets\/pal-idle\.svg"/, `#empty-state is ${tag[0]}`);
  });

  test("prefers-reduced-motion: reduce -> src is the still Pal", async () => {
    const p = await boot({ matchMedia: media(true) });
    assert.equal(pal(p).src, STILL, "reduced motion must show the motionless pal-still.svg");
    assert.equal(pal(p).hidden, false, "Pal stays shown on the start screen");
  });

  test("no reduced-motion preference -> src stays the idle Pal", async () => {
    const p = await boot({ matchMedia: media(false) });
    assert.equal(pal(p).src, IDLE);
  });

  test("no matchMedia at all -> start-up does not throw and src stays the idle Pal", async () => {
    const p = await boot();
    assert.equal(pal(p).src, IDLE);
  });
});

// Covers: MEM-082
// Requirement: the real page hands wireApp window.matchMedia. Source-level: app.js's bootstrap runs
// only under a real document (guarded for node --test), as in app_backup_wiring.test.mjs.
describe("app.js bootstrap passes matchMedia to wireApp (MEM-082)", () => {
  test("the bootstrap's wireApp({...}) argument has a matchMedia key", () => {
    const src = readFileSync(new URL("./app.js", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:"'])\/\/.*$/gm, "$1");
    const guard = src.indexOf('if (typeof document !== "undefined")');
    assert.ok(guard >= 0, "app.js lost its typeof document bootstrap guard");
    const call = src.indexOf("wireApp({", guard);
    assert.ok(call >= 0, "no wireApp({...}) call in the bootstrap");
    let depth = 0;
    let end = -1;
    for (let i = call + "wireApp(".length; i < src.length; i += 1) {
      if (src[i] === "{") depth += 1;
      else if (src[i] === "}" && --depth === 0) {
        end = i;
        break;
      }
    }
    const arg = src.slice(call, end);
    assert.match(arg, /\bmatchMedia\s*[:,}]/, "wireApp is not handed matchMedia");
  });
});

// Covers: MEM-082, MEM-077
// Requirement: Pal is hidden once any route exists, not only once a palace renders.
describe("start-screen Pal hidden once a route exists (MEM-082)", () => {
  test("no route and no palace -> Pal shown", async () => {
    const p = await boot({ routes: createRouteStore(routeAdapter()) });
    assert.equal(cards(p).length, 0);
    assert.equal(pal(p).hidden, false, "Pal hidden with no route and no palace");
  });

  test("a route already stored at start-up -> Pal hidden", async () => {
    const routes = createRouteStore(routeAdapter());
    await routes.seedRoute(DEMO_ROUTE);
    const p = await boot({ routes });
    await until(() => cards(p).length === 1, "stored route card on S1", TURNS);
    await settle(20);
    assert.equal(pal(p).hidden, true, "Pal still shown although a route exists");
  });

  test("Load demo seeds the Kendall route -> Pal hidden, even when the room demo fails", async () => {
    const routes = createRouteStore(routeAdapter());
    const p = await boot({ routes, loci: () => jsonResponse({ error: "busy" }, 503) });
    assert.equal(pal(p).hidden, false);
    p.fire(p.els["load-demo"], "click");
    await until(() => cards(p).length === 1, "demo route card on S1 after Load demo", TURNS);
    await until(() => p.els["upload-status"].textContent.includes("failed"), "room demo failure shown", TURNS);
    await settle(20);
    assert.equal(findAll(p.els.loci, (n) => n.tagName === "LI").length, 0, "the failed room demo drew no palace");
    assert.equal(pal(p).hidden, true, "Pal still shown although Load demo seeded a route");
  });
});
