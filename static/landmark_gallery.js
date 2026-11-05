// @ts-check
// Landmarks tab photo gallery (MEM-127, ADR 0074): every landmark across every route as a tile, narrowed by a
// name typeahead and by one or more route chips (union), or a switch to the chosen routes' auto-loci
// candidates. Text via textContent only: landmark and route names are user data.

import { candidates } from "./auto_loci.js";
import { emojiFor } from "./landmark_emoji.js";
import { factsFor } from "./landmark_facts.js";
import { openGalleryDetail } from "./landmark_gallery_detail.js";
import { createPhotoStore } from "./landmark_pull_photo.js";
import { filterItems, normalize } from "./list_filter.js";

/**
 * @typedef {import("./route_store.js").Station} Station
 * @typedef {{ id: string, name: string, stations?: Station[] }} GalleryRoute
 * @typedef {import("./auto_loci.js").Poi} Poi
 * @typedef {{
 *   key: string, name: string, emoji: string, photo_ref: string | null, osm_id: string | null,
 *   candidate: boolean, routes: string[], routeNames: string[], station: Station | null,
 *   poi?: import("./auto_loci.js").Candidate,
 * }} GalleryItem
 */

const UNTITLED = "Untitled landmark";

/** @param {GalleryItem} item @param {GalleryRoute} route */
function addRoute(item, route) {
  if (item.routes.includes(route.id)) return;
  item.routes.push(route.id);
  item.routeNames.push(route.name);
}

/**
 * One item per landmark across all routes: same osm_id, else same normalized name, is one landmark.
 * @param {ReadonlyArray<GalleryRoute>} routes
 * @returns {GalleryItem[]}
 */
export function galleryItems(routes) {
  /** @type {Map<string, GalleryItem>} */
  const byKey = new Map();
  for (const route of routes) {
    for (const station of route.stations ?? []) {
      const name = String(station.name ?? "").trim();
      const osm = station.osm_id || null;
      // A nameless osm-less station has nothing to match on, so it is its own landmark.
      const key = osm ? `osm:${osm}` : name ? `name:${normalize(name)}` : `station:${route.id}:${station.id}`;
      let item = byKey.get(key);
      if (!item) {
        item = {
          key, name: name || UNTITLED, emoji: station.emoji || emojiFor({ name }), photo_ref: null, osm_id: osm,
          candidate: false, routes: [], routeNames: [], station,
        };
        byKey.set(key, item);
      }
      item.photo_ref ||= station.photo_ref || null;
      addRoute(item, route);
    }
  }
  return [...byKey.values()];
}

/**
 * Auto-loci candidates of every route with >= 2 coord stations, merged by key; a POI already a station on any
 * route is never a candidate.
 * @param {ReadonlyArray<GalleryRoute>} routes
 * @param {ReadonlyArray<Poi>} pois
 * @returns {GalleryItem[]}
 */
export function candidateItems(routes, pois) {
  const stationIds = new Set(routes.flatMap((r) => (r.stations ?? []).flatMap((s) => (s.osm_id ? [s.osm_id] : []))));
  // Dropped before candidates() so an excluded POI never takes a spacing slot from a real one.
  const pool = pois.filter((p) => !stationIds.has(p.osm_id));
  /** @type {Map<string, GalleryItem>} */
  const byKey = new Map();
  for (const route of routes) {
    const stations = route.stations ?? [];
    const line = stations.flatMap((s) => (s.coords ? [[s.coords.lat, s.coords.lon]] : []));
    if (line.length < 2) continue;
    for (const c of candidates(line, pool, stations)) {
      let item = byKey.get(c.key);
      if (!item) {
        item = {
          key: c.key, name: c.name, emoji: emojiFor({ name: c.name }), photo_ref: null, osm_id: c.osm_id,
          candidate: true, routes: [], routeNames: [], station: null, poi: c,
        };
        byKey.set(c.key, item);
      }
      addRoute(item, route);
    }
  }
  return [...byKey.values()];
}

/**
 * Name tokens AND-matched; when routeIds is non-empty, only items on any of those routes.
 * @param {GalleryItem[]} items
 * @param {{ query?: string, routeIds?: Iterable<string> }} opts
 */
export function filterGallery(items, { query = "", routeIds = [] }) {
  return filterItems(items, query, { anyOf: routeIds, groupKey: (item) => item.routes });
}

/** @param {number} n @param {string} noun */
const plural = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/**
 * @param {{
 *   doc: Document,
 *   routes: { listRoutes: () => Promise<GalleryRoute[]> },
 *   loadPois: () => Promise<Poi[]>,
 *   onOpen: (item: GalleryItem, opener: HTMLButtonElement) => unknown,
 *   getPhotoUrl: (ref: string) => Promise<string | null>,
 * }} deps
 * @returns {{ refresh(): Promise<void> }}
 */
export function createLandmarkGallery({ doc, routes, loadPois, onOpen, getPhotoUrl }) {
  const byId = (/** @type {string} */ id) => /** @type {HTMLInputElement | null} */ (doc.getElementById(id));
  const search = byId("landmarks-search");
  const routeInput = byId("landmarks-route-input");
  const options = byId("landmarks-route-options");
  const chips = byId("landmarks-route-chips");
  const showCandidates = byId("landmarks-show-candidates");
  const countEl = byId("landmarks-count");
  const grid = byId("landmarks-grid");
  const emptyEl = byId("landmarks-empty");

  /** @type {GalleryRoute[]} */
  let allRoutes = [];
  /** @type {string[]} selected route ids, in the order they were picked */
  let selected = [];
  /** @type {GalleryItem[]} */
  let landmarks = [];
  /** @type {GalleryItem[] | null} built on the first Candidates view after each refresh */
  let candidatePool = null;
  // Each render bumps this; a render still awaiting the POIs drops its result once a newer one started.
  let renderSeq = 0;

  const renderRoutes = () => {
    options?.replaceChildren(...allRoutes.filter((r) => !selected.includes(r.id)).map((r) => {
      const opt = doc.createElement("option");
      opt.value = r.name;
      return opt;
    }));
    chips?.replaceChildren(...selected.flatMap((id) => {
      const route = allRoutes.find((r) => r.id === id);
      if (!route) return [];
      const li = doc.createElement("li");
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.className = "lg-chip";
      btn.setAttribute("aria-label", `Remove route ${route.name}`);
      btn.textContent = route.name;
      btn.addEventListener("click", () => {
        selected = selected.filter((s) => s !== id);
        renderRoutes();
        void render();
      });
      li.append(btn);
      return [li];
    }));
  };

  /** @param {GalleryItem} item */
  const tile = (item) => {
    const li = doc.createElement("li");
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.className = item.candidate ? "lg-tile lg-candidate" : "lg-tile";
    const thumb = doc.createElement("span");
    thumb.className = "lg-thumb";
    thumb.setAttribute("aria-hidden", "true");
    thumb.textContent = item.emoji;
    if (item.photo_ref) {
      void getPhotoUrl(item.photo_ref).then((url) => {
        if (!url) return;
        const img = doc.createElement("img");
        img.setAttribute("alt", "");
        img.src = url;
        thumb.removeAttribute("aria-hidden");
        thumb.replaceChildren(img);
      });
    }
    const name = doc.createElement("span");
    name.className = "lg-name";
    name.textContent = item.name;
    const meta = doc.createElement("span");
    meta.className = "lg-meta";
    const names = item.routeNames.join(", ");
    meta.textContent = item.candidate ? `Candidate - ${names}` : names;
    btn.append(thumb, name, meta);
    btn.addEventListener("click", () => onOpen(item, btn));
    li.append(btn);
    return li;
  };

  const render = async () => {
    const seq = ++renderSeq;
    const wantCandidates = Boolean(showCandidates?.checked);
    /** @type {GalleryItem[]} */
    let pool = landmarks;
    if (wantCandidates) {
      pool = [];
      if (selected.length) {
        candidatePool ??= candidateItems(allRoutes, await loadPois());
        if (seq !== renderSeq) return;
        pool = candidatePool;
      }
    }
    const shown = filterGallery(pool, { query: search?.value ?? "", routeIds: selected });
    grid?.replaceChildren(...shown.map(tile));
    if (countEl) countEl.textContent = plural(shown.length, wantCandidates ? "candidate" : "landmark");
    if (!emptyEl) return;
    emptyEl.hidden = shown.length > 0;
    emptyEl.textContent = shown.length ? ""
      : wantCandidates && !selected.length ? "Pick a route to see its candidates."
        : !wantCandidates && !landmarks.length ? "No landmarks yet. Build a route to add some."
          : "No landmarks match.";
  };

  // An exact (case-insensitive) route name picks that route; anything else is still being typed.
  const pickRoute = () => {
    const typed = normalize(routeInput?.value);
    if (!routeInput || !typed) return;
    const route = allRoutes.find((r) => !selected.includes(r.id) && normalize(r.name) === typed);
    if (!route) return;
    selected = [...selected, route.id];
    routeInput.value = "";
    renderRoutes();
    void render();
  };

  search?.addEventListener("input", () => void render());
  routeInput?.addEventListener("input", pickRoute);
  routeInput?.addEventListener("change", pickRoute);
  for (const id of ["landmarks-show-on-routes", "landmarks-show-candidates"]) {
    byId(id)?.addEventListener("change", () => void render());
  }

  return {
    async refresh() {
      allRoutes = await routes.listRoutes();
      selected = selected.filter((id) => allRoutes.some((r) => r.id === id));
      landmarks = galleryItems(allRoutes);
      candidatePool = null;
      renderRoutes();
      await render();
    },
  };
}

const POIS_URL = "/static/data/kendall_pois.json";

/**
 * flow.js wiring: the gallery over the route store, refreshed on mount and whenever the Landmarks tab opens.
 * @param {Document} doc
 * @param {ReturnType<typeof import("./route_store.js").createRouteStore>} routes
 * @param {typeof fetch} fetchFn
 * @param {{ onOpenRoute?: (routeId: string) => unknown }} [opts] the detail dialog's Open route action
 */
export function mountLandmarkGallery(doc, routes, fetchFn, { onOpenRoute } = {}) {
  // One POI fetch per page; a failed one is not cached, so the next Candidates view retries.
  /** @type {Promise<any> | null} */
  let pois = null;
  const loadPois = async () => {
    pois ??= fetchFn(POIS_URL).then((r) => (r.ok ? r.json() : null), () => null);
    const data = await pois;
    if (!Array.isArray(data)) pois = null;
    return Array.isArray(data) ? data : [];
  };
  // Object URLs are never revoked: one per photo for the page's life, reused by every re-render.
  /** @type {Map<string, Promise<string | null>>} */
  const photoUrls = new Map();
  /** @param {string} ref */
  const getPhotoUrl = (ref) => {
    if (!photoUrls.has(ref)) {
      photoUrls.set(ref, routes.getPhoto(ref).then((bytes) =>
        bytes ? URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" })) : null));
    }
    return /** @type {Promise<string | null>} */ (photoUrls.get(ref));
  };
  // Lazy: merely touching localStorage throws where storage is disabled; the store then keeps choices in memory.
  const win = /** @type {any} */ (doc.defaultView);
  const pullStore = createPhotoStore({
    storage: {
      getItem: (k) => win.localStorage.getItem(k),
      setItem: (k, v) => win.localStorage.setItem(k, v),
      removeItem: (k) => win.localStorage.removeItem(k),
    },
  });
  /** @param {GalleryItem} item @param {HTMLButtonElement} opener */
  const onOpen = (item, opener) =>
    openGalleryDetail(item, { doc, getPhotoUrl, onOpenRoute, factsFor, opener, fetchFn, pullStore });
  const gallery = createLandmarkGallery({ doc, routes, loadPois, onOpen, getPhotoUrl });
  // A failed store read keeps the last grid; the Routes home already shows the storage error.
  const refresh = () => void gallery.refresh().catch(() => {});
  refresh();
  doc.addEventListener("click", (/** @type {any} */ ev) => {
    if (ev.target?.closest?.('a.tab[href="#landmarks"]')) refresh();
  });
  (doc.defaultView ?? doc).addEventListener("hashchange", () => {
    if (doc.location?.hash === "#landmarks") refresh();
  });
  return gallery;
}
