// @ts-check
// Station overlay on the real map (MEM-077, plan S4, ADR 0038/0041): the route is drawn once, in the route
// view's own sketch svg, never in the map style. On the map's first idle that svg moves into the map
// container (which clips it) and every station node and route-line point follows map.project on move and
// resize. The nodes are the ones renderRouteMap returned, so its light/finish controller keeps working.
// Positions are attributes only, never a style attribute (CSP).

const SVG_NS = "http://www.w3.org/2000/svg";
// Edge insets (docs/design/map/preview.js): the top one clears the map's own controls.
const PIN_SIDE = 24;
const PIN_TOP = 48;
const PIN_BOTTOM = 24;
// Points right from the station's centre, clear of the 6 px node; rotated toward the true spot.
const ARROW_PATH = "M22 0 L14 -6 L14 6 Z";

/**
 * @typedef {{ id?: string, coords?: { lat?: unknown, lon?: unknown } }} Station
 */

/** @param {any} svg @returns {any[]} */
const kids = (svg) => Array.from(svg.children ?? []);
/** @param {any} n @param {string} c */
const has = (n, c) => Boolean(n?.classList?.contains(c));
/** @param {number} v */
const fmt = (v) => v.toFixed(1);
/** @param {Station} s @returns {[number, number]} */
const lonLat = (s) => [Number(s.coords?.lon), Number(s.coords?.lat)];

/**
 * Turns the sketch svg into the live overlay of map. Call on the map's first idle.
 * @param {any} map MapLibre map
 * @param {any} svg the route view's sketch, already drawn by renderRouteMap
 * @param {Station[]} stations route order
 * @param {any} doc
 */
export function attachOverlay(map, svg, stations, doc) {
  const box = map.getContainer();
  svg.classList.add("route-map-overlay");
  svg.removeAttribute("hidden");
  box.append(svg);
  const byId = new Map(stations.map((s) => [s.id, s]));
  const markers = kids(svg).filter((n) => has(n, "route-node") && byId.has(n.getAttribute("data-station-id")))
    .map((node) => {
      const id = node.getAttribute("data-station-id");
      // A sibling, not a child: a circle cannot hold children.
      let arrow = kids(svg).find((a) => has(a, "lm-arrow") && a.getAttribute("data-station-id") === id);
      if (!arrow) {
        arrow = doc.createElementNS(SVG_NS, "path");
        arrow.classList.add("lm-arrow");
        arrow.setAttribute("data-station-id", id);
        arrow.setAttribute("d", ARROW_PATH);
        node.before(arrow);
      }
      return { node, arrow, station: /** @type {Station} */ (byId.get(id)) };
    });
  const lines = kids(svg).filter((n) => has(n, "route-line"));

  function place() {
    const w = box.clientWidth;
    const h = box.clientHeight;
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    const points = stations.map((s) => map.project(lonLat(s))).map((p) => `${fmt(p.x)},${fmt(p.y)}`).join(" ");
    for (const line of lines) line.setAttribute("points", points);
    // Every station is always drawn (never culled). One whose spot is off the map is pressed against the
    // edge inset nearest to it with an arrow toward the spot; one on the map near the edge is only nudged in.
    for (const { node, arrow, station } of markers) {
      const p = map.project(lonLat(station));
      const x = Math.min(Math.max(p.x, PIN_SIDE), w - PIN_SIDE);
      const y = Math.min(Math.max(p.y, PIN_TOP), h - PIN_BOTTOM);
      const off = p.x < 0 || p.y < 0 || p.x > w || p.y > h;
      node.setAttribute("cx", fmt(x));
      node.setAttribute("cy", fmt(y));
      node.classList.toggle("lm-pinned", off);
      arrow.toggleAttribute("hidden", !off);
      if (off) {
        const deg = (Math.atan2(p.y - y, p.x - x) * 180) / Math.PI;
        arrow.setAttribute("transform", `translate(${fmt(x)} ${fmt(y)}) rotate(${fmt(deg)})`);
      }
    }
  }
  map.on("move", place);
  map.on("resize", place);
  place();
}

/**
 * Undoes attachOverlay so the svg can show the sketch again (repeat mount, or a route that stays sketch).
 * @param {any} svg
 * @param {string | null} viewBox the sketch's own viewBox
 */
export function detachOverlay(svg, viewBox) {
  svg.classList.remove("route-map-overlay");
  if (viewBox != null) svg.setAttribute("viewBox", viewBox);
  for (const n of kids(svg)) {
    if (has(n, "lm-arrow")) n.remove();
    else n.classList?.remove("lm-pinned");
  }
}
