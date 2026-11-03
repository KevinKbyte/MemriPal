// Covers: MEM-076
// Requirement: the real Kendall map never blanks the route view. A geo route whose every station lies inside
// the extract bbox (-71.1083, 42.3494, -71.0719, 42.3764) gets a MapLibre map over the self-hosted
// PMTiles extract; anything else keeps the SVG sketch. The extract is fetched whole, lazily (nothing at
// boot, nothing for an out-of-bbox route), at most once per session, with no Range header, from a
// module-relative URL (never root-relative, never absolute, never via api_base.js). A 404, an HTML page
// served with 200, a body under 127 bytes, an oversize body or a wrong magic/version keeps the sketch,
// untouched, with no map instance. A valid archive creates exactly one map, styled style-dark.json or
// style-light.json by the app theme (html data-theme wins, else prefers-color-scheme), and the sketch
// stays in the DOM until the map's first idle (plan S3 criteria 1-7; ADR 0041 conditions 1-4).
// Contract (RED; GREEN implements static/real_map.js):
//   REAL_MAP_BBOX = { west, south, east, north }; MAX_EXTRACT_BYTES = 3145728;
//   EXTRACT_URL: relative "map/kendall.pmtiles"; styleUrlFor("dark" | "light") -> relative style URL.
//   inRealMapBbox(stations) -> boolean; isPmtilesV3(ArrayBuffer) -> boolean.
//   createRealMapLoader({ fetch, loadLibs, doc, win }) -> { mount(svg, stations) -> Promise<{ map } | null> }.
//   loadLibs() -> Promise<{ maplibregl, pmtiles }> (the vendored globals; fakes here).
//   The style reaches MapLibre as a URL string: Map options.style or map.setStyle(url, ...), either
//   styleUrlFor(theme) itself or that URL resolved against the module URL. Same for the extract fetch.
//   DOM surface: static/fake_dom_test.mjs plus insertBefore / before / after on elements;
//   doc.documentElement; win.matchMedia(query) -> { matches }.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { fakePage, settle } from "./fake_dom_test.mjs";
import {
  EXTRACT_URL,
  MAX_EXTRACT_BYTES,
  REAL_MAP_BBOX,
  createRealMapLoader,
  inRealMapBbox,
  isPmtilesV3,
  styleUrlFor,
} from "./real_map.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const MODULE_URL = new URL("./real_map.js", import.meta.url).href;
const MiB3 = 3 * 1024 * 1024;

// Kendall stations (inside the bbox) and London stations (outside it).
const KENDALL = [[42.36238, -71.0856], [42.36265, -71.08441], [42.36385, -71.08347], [42.36554, -71.0809]];
const LONDON = [[51.5074, -0.1278], [51.5081, -0.1269]];
const stationsAt = (pts) => pts.map(([lat, lon], i) => ({ id: `st-${i + 1}`, n: i + 1, coords: { lat, lon } }));

/** A PMTiles v3 header-shaped buffer: "PMTiles", version byte, zero padding to len bytes. */
function archive(len = 127, { magic = "PMTiles", version = 3 } = {}) {
  const b = new Uint8Array(len);
  for (let i = 0; i < magic.length && i < len; i++) b[i] = magic.charCodeAt(i);
  if (len > 7) b[7] = version;
  return b.buffer;
}

const bytesResponse = (buf, status = 200, type = "application/vnd.pmtiles") =>
  new Response(buf, { status, headers: { "content-type": type, "content-length": String(buf.byteLength) } });

const HTML_PAGE = "<!doctype html><html><head><title>MemriPal</title></head><body>" + "x".repeat(400) +
  "</body></html>";

/** fetch fake: answers the extract URL with respond(), anything else 404; records every call. */
function fakeFetch(respond) {
  const calls = [];
  const fn = async (input, init) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    calls.push({ url, init, input });
    if (url.endsWith("kendall.pmtiles")) return respond();
    return new Response("not found", { status: 404 });
  };
  fn.calls = calls;
  fn.extractCalls = () => calls.filter((c) => c.url.endsWith("kendall.pmtiles"));
  return fn;
}

/** Vendored-library fakes: maplibregl.Map records instances, options, handlers and setStyle calls. */
function fakeLibs({ mapThrows = false } = {}) {
  const maps = [];
  const protocols = [];
  const workerUrls = [];
  class FakeMap {
    constructor(opts) {
      if (mapThrows) throw new Error("Failed to initialize WebGL");
      this.opts = opts;
      this.handlers = {};
      this.styles = typeof opts?.style === "string" ? [opts.style] : [];
      maps.push(this);
    }
    on(type, fn) {
      (this.handlers[type] ??= []).push({ fn, once: false });
      return this;
    }
    once(type, fn) {
      if (!fn) return new Promise((r) => (this.handlers[type] ??= []).push({ fn: r, once: true }));
      (this.handlers[type] ??= []).push({ fn, once: true });
      return this;
    }
    off(type, fn) {
      this.handlers[type] = (this.handlers[type] ?? []).filter((h) => h.fn !== fn);
      return this;
    }
    emit(type, ev = {}) {
      const hs = this.handlers[type] ?? [];
      this.handlers[type] = hs.filter((h) => !h.once);
      for (const h of hs) h.fn({ type, target: this, ...ev });
    }
    setStyle(style) {
      if (typeof style === "string") this.styles.push(style);
      return this;
    }
    getCanvas() {
      return (this._canvas ??= { attrs: {}, setAttribute(k, v) { this.attrs[k] = String(v); }, style: {} });
    }
    getContainer() {
      return typeof this.opts?.container === "object" ? this.opts.container : null;
    }
    addControl() { return this; }
    resize() { return this; }
    remove() { this.removed = true; }
    project([lon, lat]) { return { x: lon, y: lat }; }
    getBounds() { return null; }
  }
  const maplibregl = {
    Map: FakeMap,
    addProtocol: (name, fn) => protocols.push([name, fn]),
    removeProtocol() {},
    setWorkerUrl: (u) => workerUrls.push(u),
    getWorkerUrl: () => workerUrls.at(-1) ?? "",
    AttributionControl: class {},
    NavigationControl: class {},
  };
  class FileSource { constructor(file) { this.file = file; } getKey() { return "kendall"; } }
  class PMTiles { constructor(source) { this.source = source; } }
  class Protocol {
    constructor() { this.added = []; this.tile = async () => ({ data: new Uint8Array(0) }); }
    add(p) { this.added.push(p); }
    get(url) { return this.added[0] ?? url; }
  }
  const pmtiles = { PMTiles, FileSource, Protocol };
  const loadCalls = [];
  const loadLibs = async () => {
    loadCalls.push(1);
    return { maplibregl, pmtiles };
  };
  return { maps, protocols, workerUrls, loadLibs, loadCalls };
}

/** Adds insertBefore / before / after to a fake element (the fake DOM has append-family only). */
function withInsert(e) {
  e.insertBefore = function (node, ref) {
    if (node && typeof node === "object" && node.parent) node.remove();
    const at = ref == null ? -1 : this.children.indexOf(ref);
    this.appendChild(node);
    if (at >= 0) {
      this.children.pop();
      this.children.splice(at, 0, node);
    }
    return node;
  };
  e.before = function (...nodes) {
    for (const n of nodes) this.parent.insertBefore(n, this);
  };
  e.after = function (...nodes) {
    let ref = this;
    for (const n of nodes) {
      const p = ref.parent;
      const next = p.children[p.children.indexOf(ref) + 1] ?? null;
      p.insertBefore(n, next);
      ref = n;
    }
  };
  return e;
}

/**
 * Route view with a drawn sketch: #route-view > svg#route-map > (polyline, circle).
 * @param {{ theme?: string | null, prefersDark?: boolean }} [o]
 */
function scene({ theme = null, prefersDark = false } = {}) {
  const page = fakePage(["route-view"]);
  const { doc } = page;
  const mk = doc.createElement;
  const mkNS = doc.createElementNS;
  doc.createElement = (tag) => withInsert(mk(tag));
  doc.createElementNS = (ns, tag) => withInsert(mkNS(ns, tag));
  doc.documentElement = doc.createElement("html");
  if (theme) doc.documentElement.setAttribute("data-theme", theme);
  const view = withInsert(page.els["route-view"]);
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.id = "route-map";
  svg.setAttribute("class", "route-map");
  svg.setAttribute("viewBox", "0 0 320 200");
  const line = doc.createElementNS(SVG_NS, "polyline");
  line.setAttribute("points", "10,10 300,190");
  const dot = doc.createElementNS(SVG_NS, "circle");
  dot.setAttribute("data-station-id", "st-1");
  svg.append(line, dot);
  view.append(svg);
  const queries = [];
  const win = {
    matchMedia(q) {
      queries.push(q);
      return { matches: q.includes("dark") ? prefersDark : false, media: q, addEventListener() {}, removeEventListener() {} };
    },
    location: { origin: "https://app.test", href: "https://app.test/" },
    requestAnimationFrame: (fn) => setImmediate(fn),
  };
  return { doc, win, view, svg, queries };
}

/** Structural snapshot of a fake element subtree (tag, attrs, hidden, inline style, children). */
function snap(n) {
  if (n == null || typeof n !== "object") return n;
  const style = Object.fromEntries(Object.entries(n.style ?? {}).filter(([, v]) => typeof v !== "function"));
  return { tag: n.tagName, attrs: { ...n.attrs }, hidden: n.hidden, style, kids: n.children.map(snap) };
}

const inDom = (view, svg) => svg.parent === view && view.children.includes(svg);

/** A loader over a scene, with fetch answering respond(). */
function rig(respond, sceneOpts, libOpts) {
  const s = scene(sceneOpts);
  const libs = fakeLibs(libOpts);
  const fetch = fakeFetch(respond);
  const loader = createRealMapLoader({ fetch, loadLibs: libs.loadLibs, doc: s.doc, win: s.win });
  return { ...s, libs, fetch, loader };
}

/** Accepts a style/extract URL as the relative constant or that constant resolved against the module. */
function matchesRelative(actual, rel) {
  return actual === rel || actual === new URL(rel, MODULE_URL).href;
}

const isRelative = (u) => typeof u === "string" && u.length > 0 && !u.startsWith("/") &&
  !/^[a-z][a-z0-9+.-]*:/i.test(u);

function hasRangeHeader(call) {
  const lists = [call.init?.headers, call.input?.headers];
  return lists.some((h) => {
    if (h == null) return false;
    if (typeof h.has === "function") return h.has("range");
    const entries = Array.isArray(h) ? h : Object.entries(h);
    return entries.some(([k]) => String(k).toLowerCase() === "range");
  });
}

describe("real map: bbox and archive validation (MEM-076)", () => {
  test("REAL_MAP_BBOX and MAX_EXTRACT_BYTES match ADR 0041", () => {
    assert.deepEqual(REAL_MAP_BBOX, { west: -71.1083, south: 42.3494, east: -71.0719, north: 42.3764 });
    assert.equal(MAX_EXTRACT_BYTES, 3145728);
  });

  test("inRealMapBbox: true only when every station has finite coords inside the bbox", () => {
    assert.equal(inRealMapBbox(stationsAt(KENDALL)), true);
    assert.equal(inRealMapBbox([]), false, "empty route");
    assert.equal(inRealMapBbox(stationsAt(LONDON)), false, "London");
    assert.equal(inRealMapBbox(stationsAt([...KENDALL, LONDON[0]])), false, "one station outside");
    assert.equal(inRealMapBbox([...stationsAt(KENDALL), { id: "x", n: 9 }]), false, "one station without coords");
    assert.equal(inRealMapBbox(stationsAt([[NaN, -71.08]])), false, "NaN lat");
    assert.equal(inRealMapBbox(stationsAt([[-71.0856, 42.36238]])), false, "lat/lon swapped");
    // Just inside / just outside each edge.
    assert.equal(inRealMapBbox(stationsAt([[42.3495, -71.1082], [42.3763, -71.072]])), true, "just inside corners");
    assert.equal(inRealMapBbox(stationsAt([[42.3493, -71.09]])), false, "south of bbox");
    assert.equal(inRealMapBbox(stationsAt([[42.3765, -71.09]])), false, "north of bbox");
    assert.equal(inRealMapBbox(stationsAt([[42.36, -71.1084]])), false, "west of bbox");
    assert.equal(inRealMapBbox(stationsAt([[42.36, -71.0718]])), false, "east of bbox");
  });

  test("isPmtilesV3: magic PMTiles, version 3, 127 <= byteLength <= MAX_EXTRACT_BYTES", () => {
    assert.equal(isPmtilesV3(archive(127)), true, "127-byte header");
    assert.equal(isPmtilesV3(archive(MAX_EXTRACT_BYTES)), true, "exactly the cap");
    assert.equal(isPmtilesV3(archive(126)), false, "126 bytes");
    assert.equal(isPmtilesV3(archive(MAX_EXTRACT_BYTES + 1)), false, "one byte over the cap");
    assert.equal(isPmtilesV3(archive(127, { version: 2 })), false, "version 2");
    assert.equal(isPmtilesV3(archive(127, { magic: "PMTilez" })), false, "wrong magic");
    assert.equal(isPmtilesV3(new TextEncoder().encode(HTML_PAGE).buffer), false, "HTML page");
    assert.equal(isPmtilesV3(new ArrayBuffer(0)), false, "empty");
  });

  test("the committed extract static/map/kendall.pmtiles passes isPmtilesV3", () => {
    const file = readFileSync(fileURLToPath(new URL("./map/kendall.pmtiles", import.meta.url)));
    const buf = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
    assert.equal(isPmtilesV3(buf), true);
  });
});

describe("real map: loader and sketch fallback (MEM-076)", () => {
  // Criterion 1.
  for (const [label, respond] of [
    ["404", () => new Response("not found", { status: 404 })],
    ["HTML body with 200", () => new Response(HTML_PAGE, { status: 200, headers: { "content-type": "text/html" } })],
    ["body < 127 bytes", () => bytesResponse(archive(126))],
    ["oversize body", () => bytesResponse(archive(MiB3 + 1))],
    ["wrong magic", () => bytesResponse(archive(4096, { magic: "PMTilez" }))],
    ["wrong version", () => bytesResponse(archive(4096, { version: 2 }))],
    ["network error", () => Promise.reject(new TypeError("Failed to fetch"))],
  ]) {
    test(`invalid extract (${label}) -> null, 0 map instances, sketch untouched`, async () => {
      const r = rig(respond);
      const before = snap(r.view);
      const res = await r.loader.mount(r.svg, stationsAt(KENDALL));
      assert.equal(res, null);
      assert.equal(r.libs.maps.length, 0, "no map instance");
      assert.equal(r.fetch.extractCalls().length, 1, "the extract was requested");
      assert.ok(inDom(r.view, r.svg), "sketch still in the route view");
      assert.deepEqual(snap(r.view), before, "route view and sketch unchanged, no container left behind");
    });
  }

  test("Map constructor throws (no WebGL) -> null, sketch stays visible", async () => {
    const r = rig(() => bytesResponse(archive(4096)), {}, { mapThrows: true });
    const res = await r.loader.mount(r.svg, stationsAt(KENDALL));
    assert.equal(res, null);
    assert.ok(inDom(r.view, r.svg), "sketch still in the route view");
    assert.equal(r.svg.hidden, false, "sketch not hidden");
  });

  // Criterion 2.
  test("valid archive -> exactly 1 map instance, returned as { map }", async () => {
    const r = rig(() => bytesResponse(archive(4096)));
    const res = await r.loader.mount(r.svg, stationsAt(KENDALL));
    assert.equal(r.libs.maps.length, 1, "one new maplibregl.Map");
    assert.ok(res && res.map === r.libs.maps[0], "mount resolves { map } with that instance");
    assert.equal(r.libs.loadCalls.length, 1, "libraries loaded once");
  });

  // Criterion 3.
  test("0 extract fetches before route-view entry; 1 per session after", async () => {
    const r = rig(() => bytesResponse(archive(4096)));
    assert.equal(r.fetch.calls.length, 0, "creating the loader fetches nothing");
    assert.equal(r.libs.loadCalls.length, 0, "creating the loader loads no libraries");

    const london = await r.loader.mount(r.svg, stationsAt(LONDON));
    assert.equal(london, null, "out-of-bbox route stays sketch");
    assert.equal(r.fetch.calls.length, 0, "out-of-bbox route fetches nothing");
    assert.equal((await r.loader.mount(r.svg, [])), null, "empty route stays sketch");
    assert.equal(r.fetch.calls.length, 0, "empty route fetches nothing");

    const first = await r.loader.mount(r.svg, stationsAt(KENDALL));
    assert.ok(first?.map, "first in-bbox mount gets a map");
    assert.equal(r.fetch.extractCalls().length, 1, "one extract fetch");

    const other = withInsert(r.doc.createElementNS(SVG_NS, "svg"));
    r.view.append(other);
    const second = await r.loader.mount(other, stationsAt(KENDALL));
    assert.ok(second?.map, "second route-view entry still gets a map");
    assert.equal(r.fetch.extractCalls().length, 1, "extract reused from the session cache");
  });

  test("two mounts before the first fetch settles share one extract fetch", async () => {
    const r = rig(() => bytesResponse(archive(4096)));
    const other = withInsert(r.doc.createElementNS(SVG_NS, "svg"));
    r.view.append(other);
    const [a, b] = await Promise.all([
      r.loader.mount(r.svg, stationsAt(KENDALL)),
      r.loader.mount(other, stationsAt(KENDALL)),
    ]);
    assert.ok(a?.map && b?.map, "both mounts get a map");
    assert.equal(r.fetch.extractCalls().length, 1);
  });

  // Criterion 4.
  test("the extract request carries no Range header (whole-file fetch)", async () => {
    const r = rig(() => bytesResponse(archive(4096)));
    await r.loader.mount(r.svg, stationsAt(KENDALL));
    const [call] = r.fetch.extractCalls();
    assert.ok(call, "extract fetched");
    assert.equal(hasRangeHeader(call), false, `headers: ${JSON.stringify(call.init?.headers ?? null)}`);
  });

  // Criterion 5.
  test("extract URL is module-relative (neither root-relative nor absolute); no api_base.js import", async () => {
    assert.ok(isRelative(EXTRACT_URL), `EXTRACT_URL ${EXTRACT_URL}`);
    assert.ok(EXTRACT_URL.endsWith("map/kendall.pmtiles"), `EXTRACT_URL ${EXTRACT_URL}`);
    for (const theme of ["dark", "light"]) {
      const u = styleUrlFor(theme);
      assert.ok(isRelative(u), `styleUrlFor(${theme}) ${u}`);
      assert.ok(u.endsWith(`map/style-${theme}.json`), `styleUrlFor(${theme}) ${u}`);
    }
    const r = rig(() => bytesResponse(archive(4096)));
    await r.loader.mount(r.svg, stationsAt(KENDALL));
    const [call] = r.fetch.extractCalls();
    assert.ok(call, "extract fetched");
    assert.ok(matchesRelative(call.url, EXTRACT_URL), `fetched ${call.url}`);
    const src = readFileSync(fileURLToPath(MODULE_URL), "utf8");
    assert.doesNotMatch(src, /api_base/, "real_map.js must not import api_base.js");
  });

  // Criterion 6.
  for (const [label, opts, want] of [
    ["data-theme dark", { theme: "dark", prefersDark: false }, "dark"],
    ["data-theme light wins over prefers dark", { theme: "light", prefersDark: true }, "light"],
    ["no data-theme, prefers dark", { theme: null, prefersDark: true }, "dark"],
    ["no data-theme, prefers light", { theme: null, prefersDark: false }, "light"],
  ]) {
    test(`theme (${label}) -> style-${want}.json`, async () => {
      const r = rig(() => bytesResponse(archive(4096)), opts);
      await r.loader.mount(r.svg, stationsAt(KENDALL));
      assert.equal(r.libs.maps.length, 1, "one map");
      const styles = r.libs.maps[0].styles;
      const other = want === "dark" ? "light" : "dark";
      assert.ok(styles.length > 0, "a style URL reached MapLibre (options.style or setStyle)");
      assert.ok(matchesRelative(styles.at(-1), styleUrlFor(want)), `styles: ${JSON.stringify(styles)}`);
      assert.ok(!styles.some((s) => matchesRelative(s, styleUrlFor(other))), `styles: ${JSON.stringify(styles)}`);
    });
  }

  // Criterion 7.
  test("sketch stays in the DOM until the map's first idle, then gives way", async () => {
    const r = rig(() => bytesResponse(archive(4096)));
    const sketch = snap(r.svg);
    const res = await r.loader.mount(r.svg, stationsAt(KENDALL));
    assert.ok(res?.map, "map created");
    assert.ok(inDom(r.view, r.svg), "sketch in DOM after the map is created");
    assert.equal(r.svg.hidden, false, "sketch visible after the map is created");
    assert.deepEqual(snap(r.svg), sketch, "sketch drawing untouched before idle");

    res.map.emit("load");
    assert.ok(inDom(r.view, r.svg), "sketch in DOM after load");
    assert.equal(r.svg.hidden, false, "sketch visible after load");

    res.map.emit("idle");
    await settle(5);
    assert.ok(!inDom(r.view, r.svg) || r.svg.hidden, "sketch removed or hidden after the first idle");
  });
});
