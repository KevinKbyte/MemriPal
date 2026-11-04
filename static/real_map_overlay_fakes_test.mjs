// Fakes for static/real_map_overlay.test.mjs (MEM-077). Not a test file itself (no describe/test).
// A fake MapLibre map projects with a fake camera (center, zoom) over its container's current size, so
// tests can pan, zoom and resize deterministically; rig() draws the real sketch with renderRouteMap and
// builds a loader over it.
import { fakePage, findAll, settle } from "./fake_dom_test.mjs";
import { createRealMapLoader } from "./real_map.js";
import { renderRouteMap } from "./route_map.js";

const SVG_NS = "http://www.w3.org/2000/svg";

export const KENDALL = [[42.36238, -71.0856], [42.36265, -71.08441], [42.36385, -71.08347], [42.36554, -71.0809]];
export const LONDON = [51.5074, -0.1278];
export const IDS = ["st-1", "st-2", "st-3", "st-4"];
export const stationsAt = (pts) => pts.map(([lat, lon], i) => ({ id: `st-${i + 1}`, n: i + 1, coords: { lat, lon } }));

// Fake camera: centred on the route at z15.8; equirectangular px per degree with a fixed latitude factor.
export const CENTER = [-71.08325, 42.36396];
const ZOOM = 15.8;
const LAT_K = 1.352;

function archive(len = 4096) {
  const b = new Uint8Array(len);
  for (let i = 0; i < 7; i++) b[i] = "PMTiles".charCodeAt(i);
  b[7] = 3;
  return b.buffer;
}

function fakeFetch() {
  const calls = [];
  const fn = async (input) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    calls.push(url);
    if (!url.endsWith("kendall.pmtiles")) return new Response("not found", { status: 404 });
    const buf = archive();
    return new Response(buf, { status: 200, headers: { "content-length": String(buf.byteLength) } });
  };
  fn.calls = calls;
  return fn;
}

/** Container size as the browser reports it. */
export function setSize(el, w, h) {
  el.clientWidth = w;
  el.clientHeight = h;
  el.offsetWidth = w;
  el.offsetHeight = h;
  el.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, width: w, height: h, right: w, bottom: h });
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

function fakeLibs(doc) {
  const maps = [];
  class AttributionControl {
    constructor(options) {
      this.options = options ?? {};
    }
  }
  class FakeMap {
    constructor(opts) {
      this.opts = opts;
      this.handlers = {};
      this.styles = typeof opts?.style === "string" ? [opts.style] : [];
      this.controls = [];
      this.layersAdded = [];
      this.sourcesAdded = [];
      this.center = [...CENTER];
      this.zoom = ZOOM;
      const c = opts.container;
      if (c.clientWidth === undefined) setSize(c, 375, 300);
      // Like MapLibre: a canvas container holding the canvas, inside the map container.
      this._canvasContainer = doc.createElement("div");
      this._canvasContainer.classList.add("maplibregl-canvas-container");
      this._canvas = doc.createElement("canvas");
      this._canvasContainer.append(this._canvas);
      c.append(this._canvasContainer);
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
    getContainer() {
      return this.opts.container;
    }
    getCanvasContainer() {
      return this._canvasContainer;
    }
    getCanvas() {
      return this._canvas;
    }
    addControl(ctl) {
      this.controls.push(ctl);
      return this;
    }
    addLayer(layer) {
      this.layersAdded.push(layer);
      return this;
    }
    addSource(id, src) {
      this.sourcesAdded.push([id, src]);
      return this;
    }
    resize() {
      return this;
    }
    remove() {
      this.removed = true;
    }
    getZoom() {
      return this.zoom;
    }
    getCenter() {
      return { lng: this.center[0], lat: this.center[1] };
    }
    project(lngLat) {
      const lng = Array.isArray(lngLat) ? lngLat[0] : lngLat.lng ?? lngLat.lon;
      const lat = Array.isArray(lngLat) ? lngLat[1] : lngLat.lat;
      const k = (256 * 2 ** this.zoom) / 360;
      const c = this.getContainer();
      return { x: (lng - this.center[0]) * k + c.clientWidth / 2, y: (this.center[1] - lat) * k * LAT_K + c.clientHeight / 2 };
    }
  }
  const maplibregl = {
    Map: FakeMap,
    addProtocol() {},
    removeProtocol() {},
    setWorkerUrl() {},
    getWorkerUrl: () => "",
    AttributionControl,
    NavigationControl: class {},
  };
  class FileSource { constructor(file) { this.file = file; } }
  class PMTiles { constructor(source) { this.source = source; } }
  class Protocol {
    constructor() { this.tile = async () => ({ data: new Uint8Array(0) }); }
    add() {}
  }
  return { maps, loadLibs: async () => ({ maplibregl, pmtiles: { PMTiles, FileSource, Protocol } }) };
}

/** Route view with the real sketch: renderRouteMap draws #route-map, returning its light/finish controller. */
export function rig({ theme = null, stations = stationsAt(KENDALL) } = {}) {
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
  svg.classList.add("route-map");
  svg.setAttribute("viewBox", "0 0 320 200");
  view.append(svg);
  const ctl = renderRouteMap(svg, stations, doc);
  const win = {
    matchMedia: (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }),
    location: { origin: "https://app.test", href: "https://app.test/" },
    requestAnimationFrame: (fn) => setImmediate(fn),
  };
  const libs = fakeLibs(doc);
  const fetch = fakeFetch();
  const loader = createRealMapLoader({ fetch, loadLibs: libs.loadLibs, doc, win });
  return { doc, view, svg, ctl, libs, fetch, loader, stations, htmlWrites: page.htmlWrites };
}

/** Mount, size the container, run the first load + idle. Resolves the map (throws if none was made). */
export async function mountIdle(r, [w, h] = [375, 300]) {
  const res = await r.loader.mount(r.svg, r.stations);
  if (!res?.map) throw new Error("no map was created");
  setSize(res.map.getContainer(), w, h);
  res.map.emit("load");
  res.map.emit("idle");
  await settle(5);
  return res.map;
}

/** Camera change as MapLibre reports it: move (and moveend unless end is false). */
export async function moveTo(map, { center = map.center, zoom = map.zoom, end = true } = {}) {
  map.center = [...center];
  map.zoom = zoom;
  map.emit("move");
  if (end) map.emit("moveend");
  await settle(5);
}

export const hasClass = (n, c) => Boolean(n?.classList?.contains(c)) ||
  String(n?.getAttribute?.("class") ?? "").split(/\s+/).includes(c);

export const descendantOf = (n, root) => {
  for (let p = n?.parent; p; p = p.parent) if (p === root) return true;
  return false;
};

export const stationNodes = (svg) => findAll(svg, (n) => n !== svg && hasClass(n, "route-node") &&
  n.getAttribute?.("data-station-id") != null);

export const nodeFor = (svg, id) => stationNodes(svg).find((n) => n.getAttribute("data-station-id") === id) ?? null;

export const lonLat = (s) => [s.coords.lon, s.coords.lat];

/** Which stations the fake camera puts off the map (precondition guard). */
export function offIds(map, stations) {
  const c = map.getContainer();
  return stations.filter((s) => {
    const p = map.project(lonLat(s));
    return p.x < 0 || p.y < 0 || p.x > c.clientWidth || p.y > c.clientHeight;
  }).map((s) => s.id);
}
