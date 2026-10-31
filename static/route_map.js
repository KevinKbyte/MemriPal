// @ts-check
// Route map + route practice helpers (MEM-051, plan B6 / D9): stations drawn as dots on a 320x200 SVG in
// route order, practice points built from station names only, and "Learned n/N" keyed by station id so an
// Up/Down reorder keeps what was learned with the station.

const SVG_NS = "http://www.w3.org/2000/svg";
const W = 320;
const H = 200;
// Keeps node circles fully inside the viewBox.
const PAD = 16;
const NODE_R = 6;

/**
 * @typedef {{ id: string, name?: string, coords?: { lat?: unknown, lon?: unknown } }} Station
 * @typedef {{ stations: Station[] }} Route
 */

/** @param {Station} s */
const hasCoords = (s) => Number.isFinite(s?.coords?.lat) && Number.isFinite(s?.coords?.lon);

/** @param {number} v */
const round = (v) => Math.round(v * 10) / 10;

/**
 * @param {Station[]} stations
 * @returns {{ id: string, x: number, y: number }[]} route order, inside [0,320] x [0,200]
 */
export function projectStations(stations) {
  const list = Array.isArray(stations) ? stations : [];
  if (list.length === 0) return [];
  if (list.every(hasCoords)) {
    // Equirectangular is plenty at walking scale; north is up, so latitude flips to SVG y.
    const xs = list.map((s) => Number(s.coords?.lon));
    const ys = list.map((s) => -Number(s.coords?.lat));
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const dx = Math.max(...xs) - minX;
    const dy = Math.max(...ys) - minY;
    const scale = Math.min(dx > 0 ? (W - 2 * PAD) / dx : Infinity, dy > 0 ? (H - 2 * PAD) / dy : Infinity);
    const k = Number.isFinite(scale) ? scale : 0;
    // Center the scaled bounding box so a thin route is not pinned to one edge.
    const offX = (W - dx * k) / 2;
    const offY = (H - dy * k) / 2;
    return list.map((s, i) => ({ id: s.id, x: round(offX + (xs[i] - minX) * k), y: round(offY + (ys[i] - minY) * k) }));
  }
  if (list.length === 1) return [{ id: list[0].id, x: W / 2, y: H / 2 }];
  const step = (W - 2 * PAD) / (list.length - 1);
  return list.map((s, i) => ({ id: s.id, x: PAD + i * step, y: H / 2 }));
}

/**
 * @param {any} svg
 * @param {Station[]} stations
 * @param {Pick<Document, "createElementNS">} doc
 */
export function renderRouteMap(svg, stations, doc) {
  const pts = projectStations(stations);
  const line = doc.createElementNS(SVG_NS, "polyline");
  line.setAttribute("points", pts.map((p) => `${p.x},${p.y}`).join(" "));
  line.classList.add("route-line");
  const nodes = pts.map((p) => {
    const n = doc.createElementNS(SVG_NS, "circle");
    n.setAttribute("data-station-id", p.id);
    n.setAttribute("cx", String(p.x));
    n.setAttribute("cy", String(p.y));
    n.setAttribute("r", String(NODE_R));
    n.classList.add("route-node");
    return n;
  });
  svg.replaceChildren(line, ...nodes);
  return {
    nodes,
    /** @param {boolean[]} counted */
    light(counted) {
      nodes.forEach((n, i) => n.classList.toggle("lit", counted?.[i] === true));
    },
    /** @param {boolean[]} counted */
    finish(counted) {
      nodes.forEach((n, i) => {
        const got = counted?.[i] === true;
        n.classList.toggle("lit", got);
        n.classList.toggle("missed", !got);
      });
    },
  };
}

/**
 * The turn cue is shown beside the station but never matched, so "red bench left" cannot hit a second name.
 * @param {Route} route
 * @returns {{ id: string, label: string, source_quote: string }[]}
 */
export function routePracticePoints(route) {
  return (route?.stations ?? []).map((s) => {
    const name = String(s?.name ?? "");
    return { id: s.id, label: name, source_quote: name };
  });
}

/**
 * @param {Route} route
 * @param {{ mode?: string, hits?: Record<string, boolean> }[]} records oldest first
 * @returns {{ n: number, N: number }}
 */
export function learnedCount(route, records) {
  const stations = route?.stations ?? [];
  const latest = (Array.isArray(records) ? records : []).filter((r) => r?.mode === "route").at(-1);
  const hits = latest?.hits ?? {};
  const n = stations.filter((s) => Object.hasOwn(hits, s.id) && hits[s.id] === true).length;
  return { n, N: stations.length };
}
