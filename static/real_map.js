// @ts-check
// Real Kendall map loader (MEM-076, plan S3, ADR 0041 conditions 1-4): a geo route with every station inside
// the extract bbox gets a MapLibre map over the self-hosted PMTiles extract; anything else, and any failure on
// the way, keeps the SVG sketch (static/route_map.js). The sketch stays until the map's first idle, so the
// route view is never blank.
//
// Every URL resolves against this module, never root-relative and never via the API base: the native shell
// sends root-relative paths cross-origin, and Capacitor may answer a missing asset with index.html 200.

/** Extract bounds, same as scripts/build_map_extract.py. */
export const REAL_MAP_BBOX = Object.freeze({ west: -71.1083, south: 42.3494, east: -71.0719, north: 42.3764 });
export const MAX_EXTRACT_BYTES = 3 * 1024 * 1024;
export const EXTRACT_URL = "map/kendall.pmtiles";
// A PMTiles v3 header is 127 bytes; anything shorter cannot be an archive.
const HEADER_BYTES = 127;
const MAGIC = "PMTiles";

const MODULE_DIR = new URL(".", import.meta.url).href;
// CSP has no worker-src and no blob:, so the CSP build's worker loads same-origin.
const WORKER_URL = new URL("vendor/maplibre/maplibre-gl-csp-worker.js", import.meta.url).href;
const VENDOR_SCRIPTS = ["vendor/maplibre/maplibre-gl-csp.js", "vendor/pmtiles/pmtiles.js"];
const VENDOR_CSS = "vendor/maplibre/maplibre-gl.css";
// The committed styles carry root-relative sprite/glyph paths under /static/; mapped onto this module's
// directory so they follow the extract wherever the app is served from.
const STATIC_ROOT = "/static/";
const DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * @typedef {{ id?: string, coords?: { lat?: unknown, lon?: unknown } }} Station
 * @typedef {{ maplibregl: any, pmtiles: any }} MapLibs the vendored UMD/IIFE globals
 * @typedef {{
 *   fetch?: typeof globalThis.fetch,
 *   loadLibs?: () => Promise<MapLibs>,
 *   doc?: any,
 *   win?: any,
 * }} LoaderDeps
 */

/**
 * @param {string} theme "dark" | "light"
 * @returns {string} module-relative style URL
 */
export function styleUrlFor(theme) {
  return `map/style-${theme === "dark" ? "dark" : "light"}.json`;
}

/** @param {Station} s */
function inside(s) {
  const lat = s?.coords?.lat;
  const lon = s?.coords?.lon;
  return typeof lat === "number" && typeof lon === "number" && Number.isFinite(lat) && Number.isFinite(lon) &&
    lat >= REAL_MAP_BBOX.south && lat <= REAL_MAP_BBOX.north && lon >= REAL_MAP_BBOX.west && lon <= REAL_MAP_BBOX.east;
}

/**
 * One station outside the bbox (or without coords) sends the whole route to the sketch.
 * @param {Station[]} stations
 */
export function inRealMapBbox(stations) {
  return Array.isArray(stations) && stations.length > 0 && stations.every(inside);
}

/**
 * Header check only (magic, spec version, size); the tile directory is MapLibre's to read.
 * @param {ArrayBuffer} buf
 */
export function isPmtilesV3(buf) {
  if (!(buf instanceof ArrayBuffer) || buf.byteLength < HEADER_BYTES || buf.byteLength > MAX_EXTRACT_BYTES) return false;
  const head = new Uint8Array(buf, 0, MAGIC.length + 1);
  return String.fromCharCode(...head.subarray(0, MAGIC.length)) === MAGIC && head[MAGIC.length] === 3;
}

/** @type {Promise<MapLibs> | null} */
let vendorLibs = null;

/**
 * Default loadLibs: same-origin <script> tags (CSP script-src 'self'), injected once per page.
 * @param {any} doc
 * @returns {Promise<MapLibs>}
 */
function loadVendorLibs(doc) {
  vendorLibs ??= (async () => {
    const css = doc.createElement("link");
    css.rel = "stylesheet";
    css.href = new URL(VENDOR_CSS, import.meta.url).href;
    doc.head.append(css);
    await Promise.all(VENDOR_SCRIPTS.map((path) => new Promise((resolve, reject) => {
      const s = doc.createElement("script");
      s.src = new URL(path, import.meta.url).href;
      s.addEventListener("load", resolve);
      s.addEventListener("error", () => reject(new Error(`map library failed to load: ${path}`)));
      doc.head.append(s);
    })));
    const g = /** @type {any} */ (globalThis);
    if (!g.maplibregl || !g.pmtiles) throw new Error("map libraries missing after load");
    return { maplibregl: g.maplibregl, pmtiles: g.pmtiles };
  })();
  return vendorLibs;
}

/**
 * MapLibre rejects a relative sprite URL. String concat, not new URL(): URL would percent-encode the
 * {fontstack}/{range} glyph placeholders.
 * @param {unknown} u
 */
const absolutize = (u) => (typeof u === "string" && u.startsWith(STATIC_ROOT) ? MODULE_DIR + u.slice(STATIC_ROOT.length) : u);

const styleOptions = {
  /** @param {unknown} _prev @param {any} next */
  transformStyle: (_prev, next) => ({ ...next, sprite: absolutize(next.sprite), glyphs: absolutize(next.glyphs) }),
};

/** @param {string} theme */
const styleHref = (theme) => new URL(styleUrlFor(theme), import.meta.url).href;

/**
 * fetch has no default: MEM-063's grep lets only withApiBase take the global fetch, so the caller injects one.
 * The extract URL is absolute, which apiUrl() passes through untouched either way.
 * @param {LoaderDeps & { fetch: typeof globalThis.fetch }} deps
 * @returns {{ mount(svg: any, stations: Station[]): Promise<{ map: any } | null> }}
 */
export function createRealMapLoader({ fetch, loadLibs, doc = globalThis.document, win = globalThis.window }) {
  const libsLoader = loadLibs ?? (() => loadVendorLibs(doc));
  // Session cache: one extract fetch and one library load, shared by every mount, failures included.
  /** @type {Promise<any> | null} */
  let ready = null;

  /** @returns {Promise<ArrayBuffer | null>} */
  async function fetchExtract() {
    // Whole file, no Range header: the archive is served to MapLibre from memory.
    const res = await fetch(new URL(EXTRACT_URL, import.meta.url).href);
    if (!res.ok || Number(res.headers.get("content-length")) > MAX_EXTRACT_BYTES) return null;
    const buf = await res.arrayBuffer();
    return isPmtilesV3(buf) ? buf : null;
  }

  /** @returns {Promise<any>} maplibregl wired to the extract, or null */
  function prepare() {
    // The extract and the libraries download in parallel; the extract is the slow one on web links.
    ready ??= Promise.all([fetchExtract(), libsLoader()]).then(([buf, { maplibregl, pmtiles }]) => {
      if (!buf) return null;
      const protocol = new pmtiles.Protocol();
      // The style's source url is pmtiles://kendall; FileSource keys the archive by the file name.
      protocol.add(new pmtiles.PMTiles(new pmtiles.FileSource(new File([buf], "kendall"))));
      maplibregl.addProtocol("pmtiles", protocol.tile);
      maplibregl.setWorkerUrl(WORKER_URL);
      return maplibregl;
    }).catch(() => null);
    return ready;
  }

  /** html data-theme wins over the OS preference. */
  function explicitTheme() {
    const t = doc.documentElement?.getAttribute("data-theme");
    return t === "dark" || t === "light" ? t : null;
  }

  return {
    async mount(svg, stations) {
      if (!inRealMapBbox(stations)) return null;
      const maplibregl = await prepare();
      if (!maplibregl) return null;
      const box = doc.createElement("div");
      // Pending: laid over the sketch and invisible until the first idle (static/style.css .real-map).
      box.classList.add("real-map", "real-map-pending");
      svg.after(box);
      let map;
      try {
        const lons = stations.map((s) => Number(s.coords?.lon));
        const lats = stations.map((s) => Number(s.coords?.lat));
        map = new maplibregl.Map({
          container: box,
          bounds: [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
          fitBoundsOptions: { padding: 40, maxZoom: 16 },
          maxBounds: [[REAL_MAP_BBOX.west, REAL_MAP_BBOX.south], [REAL_MAP_BBOX.east, REAL_MAP_BBOX.north]],
          minZoom: 12,
          // Tiles stop at z14; MapLibre overzooms them for display up to 16.
          maxZoom: 16,
          attributionControl: { compact: false },
        });
      } catch {
        // No WebGL: the constructor throws and the sketch stays.
        box.remove();
        return null;
      }
      const mq = win.matchMedia(DARK_QUERY);
      const theme = () => explicitTheme() ?? (mq.matches ? "dark" : "light");
      map.setStyle(styleHref(theme()), styleOptions);
      // An explicit app theme pins the style; only the OS preference is followed live.
      const onScheme = () => {
        if (!explicitTheme()) map.setStyle(styleHref(theme()), styleOptions);
      };
      mq.addEventListener("change", onScheme);
      map.once("remove", () => mq.removeEventListener("change", onScheme));
      map.once("idle", () => {
        box.classList.remove("real-map-pending");
        svg.setAttribute("hidden", "");
      });
      return { map };
    },
  };
}
