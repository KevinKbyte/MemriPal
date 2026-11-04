// @ts-check
// "Map a new route" page wiring (MEM-088): #route-new in the route drawer. Find geocodes the typed start and
// end, walks the committed Kendall graph, picks landmarks along it and previews them; Save stores the route
// through routes.seedRoute and hands its id back. Text via textContent only (typed input is user data).

import { candidates } from "./auto_loci.js";
import { distanceLabel, missText, pickStations } from "./route_builder.js";
import { geocode, route } from "./walk_route.js";

const NAME_MAX = 40;
const GRAPH_URL = "/static/data/kendall_walk_graph.json";
const POIS_URL = "/static/data/kendall_pois.json";

/**
 * @param {{
 *   doc: Document,
 *   routes: ReturnType<typeof import("./route_store.js").createRouteStore>,
 *   fetch: typeof fetch,
 *   onSaved: (routeId: string) => unknown,
 *   onCancel: () => unknown,
 * }} deps
 * @returns {{ open(): void }}
 */
export function createRouteNew({ doc, routes, fetch, onSaved, onCancel }) {
  const byId = (/** @type {string} */ id) => /** @type {HTMLElement | null} */ (doc.getElementById(id));
  const input = (/** @type {string} */ id) => /** @type {HTMLInputElement | null} */ (byId(id));
  const error = byId("route-new-error");
  const result = byId("route-new-result");
  /** @param {string} [text] shown when given, cleared and hidden otherwise */
  const say = (text) => {
    if (!error) return;
    error.textContent = text ?? "";
    error.hidden = !text;
  };

  // Each data file is fetched once per page; an answer that is not ok is not cached, so a later Find retries.
  /** @type {Map<string, Promise<any>>} */
  const cache = new Map();
  /** @param {string} url @param {unknown} fallback */
  const load = async (url, fallback) => {
    if (!cache.has(url)) cache.set(url, fetch(url).then((r) => (r.ok ? r.json() : null), () => null));
    const data = await cache.get(url);
    if (data == null) cache.delete(url);
    return data ?? fallback;
  };

  /** @type {ReturnType<typeof pickStations> | null} */
  let stations = null;
  let defaultName = "";

  const find = async () => {
    say();
    if (result) result.hidden = true;
    stations = null;
    // An empty graph makes route() draw the straight line, flagged fallback, so a 404 never dead-ends.
    const [graph, pois] = await Promise.all([load(GRAPH_URL, { nodes: [], edges: [] }), load(POIS_URL, [])]);
    /** @type {{ name: string, lat: number, lng: number, address?: string | null }[]} */
    const places = [];
    for (const [id, what] of [["route-from", "start"], ["route-to", "end"]]) {
      const phrase = input(id)?.value.trim() ?? "";
      if (!phrase) return say(`Type a ${what}, like Kendall/MIT T or Meta office.`);
      const hit = geocode(phrase, pois);
      if ("miss" in hit) return say(missText(phrase, hit.suggestions));
      places.push(hit);
    }
    const [from, to] = places;
    const walk = route(graph, from, to);
    const ends = places.map((p) => ({ coords: { lat: p.lat, lon: p.lng }, address: p.address ?? undefined }));
    stations = pickStations(from, to, candidates(walk.polyline, pois, ends));
    defaultName = `${from.name} to ${to.name}`.slice(0, NAME_MAX);
    const distance = byId("route-distance");
    if (distance) distance.textContent = distanceLabel(walk.length_m, walk.fallback);
    byId("route-new-stations")?.replaceChildren(...stations.map((s) => {
      const li = doc.createElement("li");
      li.textContent = s.name;
      if (s.address && s.address !== s.name) {
        const meta = doc.createElement("span");
        meta.className = "route-meta";
        meta.textContent = ` ${s.address}`;
        li.append(meta);
      }
      return li;
    }));
    const name = input("route-new-name");
    if (name) name.value = defaultName;
    if (result) result.hidden = false;
  };

  const save = async () => {
    if (!stations) return;
    const name = (input("route-new-name")?.value.trim() || defaultName).slice(0, NAME_MAX);
    const id = crypto.randomUUID();
    try {
      await routes.seedRoute({ id, name, kind: "daily", stations });
    } catch {
      // The preview is kept, so pressing Save again retries the same route.
      return say("Couldn't save the route. Try again.");
    }
    say();
    stations = null;
    hide();
    await onSaved(id);
  };

  const hide = () => {
    const form = byId("route-new");
    if (form) form.hidden = true;
  };

  /** @param {string} id @param {() => unknown} fn */
  const onClick = (id, fn) => byId(id)?.addEventListener("click", () => void fn());
  onClick("route-find", find);
  onClick("route-new-save", save);
  onClick("route-new-cancel", () => {
    hide();
    return onCancel();
  });

  return {
    /** Shows the form with a fresh preview; the typed start and end are kept for a retry. */
    open() {
      say();
      if (result) result.hidden = true;
      stations = null;
      const form = byId("route-new");
      if (form) form.hidden = false;
      input("route-from")?.focus?.();
    },
  };
}
