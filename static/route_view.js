// @ts-check
// S1 route cards + S5 Route view (MEM-051, plan B6): one card per route with kind, station count and
// "Learned n/N"; Open shows the route's map, stations and per-station hit rates; delete is arm -> confirm
// -> Undo (route, photos and its rehearsals); Practice opens #recall in route mode. Text via textContent only.

import { countInOrder } from "./recall_match.js";
import { routeHitRates } from "./rehearsals.js";
import { learnedCount, renderRouteMap } from "./route_map.js";

/**
 * @typedef {import("./route_store.js").Route} Route
 * @typedef {ReturnType<typeof renderRouteMap>} RouteMap
 * @typedef {ReturnType<typeof import("./real_map.js").createRealMapLoader>} RealMap
 */

export const ROUTE_MODE_TEXT = "Route practice: say them in order";

/**
 * A finished route run: stations counted in route order and the hits record keyed by station id.
 * @param {Route} route
 * @param {(number | null)[]} starts the matcher's per-point window starts, route order
 */
export function routeRun(route, starts) {
  const counted = countInOrder(starts);
  const hits = Object.fromEntries(route.stations.map((s, i) => [s.id, counted[i] === true]));
  return { counted, hits };
}

/**
 * @param {{
 *   doc: Document,
 *   routes: ReturnType<typeof import("./route_store.js").createRouteStore>,
 *   rehearsals: ReturnType<typeof import("./rehearsals.js").createRehearsalStore>,
 *   onPractice: (route: Route, map: RouteMap) => void,
 *   realMap?: RealMap,
 * }} deps
 */
export function createRouteView({ doc, routes, rehearsals, onPractice, realMap }) {
  /** @param {string} id */
  const byId = (id) => doc.getElementById(id);
  /**
   * Real map over an already drawn sketch (MEM-076). Not awaited and failures swallowed: the sketch is
   * the fallback, so a slow or broken map never delays or blanks the view.
   * @param {string} id @param {Route} route
   */
  const mountRealMap = (id, route) => {
    const svg = byId(id);
    if (realMap && svg) realMap.mount(svg, route.stations).catch(() => {});
  };
  /** @param {string} tag @param {string} text @param {string} [className] */
  const textEl = (tag, text, className) => {
    const e = doc.createElement(tag);
    e.textContent = text;
    if (className) e.className = className;
    return e;
  };
  /** @param {string} id @param {boolean} hidden */
  const setHidden = (id, hidden) => {
    const e = byId(id);
    if (e) e.hidden = hidden;
  };
  /** @param {string} text @param {() => unknown} onClick */
  const button = (text, onClick) => {
    const b = /** @type {HTMLButtonElement} */ (doc.createElement("button"));
    b.type = "button";
    b.className = "btn";
    b.textContent = text;
    b.addEventListener("click", () => void onClick());
    return b;
  };
  const kindLabel = (/** @type {string} */ kind) => (kind === "occasional" ? "Occasional" : "Daily");

  /** @type {Route | null} */
  let current = null;
  // routeGone: deleteRoute landed, so Undo must restore it; records: the rehearsals to put back.
  /** @type {{ id: string, records: import("./rehearsals.js").Rehearsal[], routeGone: boolean } | null} */
  let deleted = null;

  // Created once and prepended, so the markup's map, stations and buttons stay in place.
  const heading = textEl("h2", "");
  const back = button("Back to routes", () => showHome());
  const viewError = textEl("p", "", "notice");
  const homeError = textEl("p", "", "notice");
  for (const e of [viewError, homeError]) {
    e.setAttribute("role", "alert");
    e.hidden = true;
  }
  byId("route-view")?.prepend(back, heading, viewError);
  byId("routes-home")?.prepend(homeError);
  /** @param {HTMLElement} e @param {string} [text] shown when given, cleared and hidden otherwise */
  const say = (e, text) => {
    e.textContent = text ?? "";
    e.hidden = !text;
  };

  /** @param {Route} route */
  const card = async (route) => {
    const { n, N } = learnedCount(route, await rehearsals.list(route.id));
    const li = doc.createElement("li");
    const open = button("Open", () => openRoute(route.id));
    open.dataset.action = "open";
    open.setAttribute("aria-label", `Open ${route.name}`);
    const meta = `${kindLabel(route.kind)}, ${N} station${N === 1 ? "" : "s"}, Learned ${n}/${N}`;
    li.append(textEl("strong", route.name), textEl("span", meta, "route-meta"));
    if (route.status === "draft") li.append(textEl("span", "Draft", "chip"));
    li.append(open);
    return li;
  };

  const renderHome = async () => {
    try {
      const list = await routes.listRoutes();
      byId("routes-list")?.replaceChildren(...(await Promise.all(list.map(card))));
      say(homeError);
    } catch {
      byId("routes-list")?.replaceChildren();
      say(homeError, "Couldn't load your routes. Reload the page to try again.");
    }
  };

  const showHome = async () => {
    setHidden("route-view", true);
    setHidden("route-view-undo", true);
    deleted = null;
    setHidden("routes-home", false);
    await renderHome();
  };

  /** @param {Route} route */
  const renderRates = async (route) => {
    const rates = routeHitRates(route, await rehearsals.list(route.id));
    byId("hit-rates")?.replaceChildren(...rates.map((r) => {
      const li = textEl("li", `${r.name}: ${r.runs ? `${Math.round(r.rate * 100)}%` : "not practiced yet"}`);
      li.dataset.stationId = r.id;
      return li;
    }));
    setHidden("history", false);
  };

  /** @param {Route} route */
  const renderRoute = (route) => {
    heading.textContent = `${route.name} (${kindLabel(route.kind)})`;
    byId("route-view-stations")?.replaceChildren(...route.stations.map((s) => {
      const li = textEl("li", s.name);
      const turn = s.taps?.turn;
      if (turn) li.append(textEl("span", ` then ${String(turn).toLowerCase()}`, "route-meta"));
      return li;
    }));
    renderRouteMap(byId("route-map"), route.stations, doc);
    mountRealMap("route-map", route);
    for (const id of ["route-view-practice", "route-view-delete"]) setHidden(id, false);
    for (const id of ["route-view-delete-confirm", "route-view-delete-cancel"]) setHidden(id, true);
  };

  /** @param {string} id */
  const openRoute = async (id) => {
    const route = await routes.getRoute(id);
    if (!route) return;
    current = route;
    setHidden("route-view-undo", true);
    deleted = null;
    say(viewError);
    renderRoute(route);
    await renderRates(route);
    setHidden("routes-home", true);
    setHidden("route-view", false);
  };

  /** @param {boolean} armed */
  const arm = (armed) => {
    setHidden("route-view-delete-confirm", !armed);
    setHidden("route-view-delete-cancel", !armed);
  };

  const confirmDelete = async () => {
    if (!current) return;
    const route = current;
    arm(false);
    // State first, so a store write that rejects partway still leaves Undo able to put back what went.
    const stash = { id: route.id, records: /** @type {import("./rehearsals.js").Rehearsal[]} */ ([]), routeGone: false };
    deleted = stash;
    current = null;
    heading.textContent = `Deleted ${route.name}`;
    byId("route-view-stations")?.replaceChildren();
    byId("route-map")?.replaceChildren();
    byId("hit-rates")?.replaceChildren();
    for (const id of ["route-view-practice", "route-view-delete"]) setHidden(id, true);
    setHidden("route-view-undo", false);
    try {
      stash.records = await rehearsals.list(route.id);
      await routes.deleteRoute(route.id);
      stash.routeGone = true;
      for (const r of stash.records) await rehearsals.delete(r.id);
    } catch {
      // deleteRoute drops the route from memory before its write can fail, so ask the store what went.
      stash.routeGone = !(await routes.getRoute(route.id));
      say(viewError, "Delete failed. Press Undo to put the route back.");
    }
    await renderHome();
  };

  const undoDelete = async () => {
    const stash = deleted;
    if (!stash) return;
    try {
      if (stash.routeGone) {
        // A failed restore write rejects and leaves the delete undoable, so the catch keeps Undo for a retry.
        if (!(await routes.undoDelete())) throw new Error("nothing to restore");
      }
      stash.routeGone = false;
      for (const r of stash.records) await rehearsals.restore(r);
    } catch {
      say(viewError, "Couldn't restore the route. Try again.");
      return;
    }
    deleted = null;
    setHidden("route-view-undo", true);
    await renderHome();
    await openRoute(stash.id);
  };

  const practice = () => {
    if (!current) return;
    const mode = byId("recall-mode");
    if (mode) mode.textContent = ROUTE_MODE_TEXT;
    const map = renderRouteMap(byId("recall-map"), current.stations, doc);
    mountRealMap("recall-map", current);
    setHidden("route-view", true);
    setHidden("recall", false);
    onPractice(current, map);
  };

  /** @param {string} id @param {() => unknown} fn */
  const onClick = (id, fn) => byId(id)?.addEventListener("click", () => void fn());
  onClick("route-view-delete", () => arm(true));
  onClick("route-view-delete-cancel", () => arm(false));
  onClick("route-view-delete-confirm", confirmDelete);
  onClick("route-view-undo", undoDelete);
  onClick("route-view-practice", practice);

  return {
    renderHome,
    /** After a route run: Learned on S1 and the practiced route's hit rates. */
    async refresh(/** @type {Route} */ route) {
      await renderHome();
      await renderRates(route);
    },
  };
}
