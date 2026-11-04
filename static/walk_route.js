// @ts-check
// Offline walk routing + geocode (MEM-084, ADR 0046, 0053): A* over the committed walk graph built by
// scripts/build_walk_graph.py, and a local geocode over its POI table plus a hand-kept alias table. Pure:
// no DOM, no network, so the demo never depends on a third-party service being up.

/**
 * @typedef {{ nodes: [number, number][], edges: [number, number, number][] }} WalkGraph
 * @typedef {{ lat: number, lng: number }} LatLng
 * @typedef {{ polyline: [number, number][], length_m: number, fallback: boolean }} WalkRoute
 * @typedef {{ osm_id: string, name: string, lat: number, lng: number, address: string | null,
 *   street: string | null }} Poi
 * @typedef {{ name: string, lat: number, lng: number, address: string | null }} Place
 */

const R = 6371008.8;
const MAX_SUGGESTIONS = 5;

const META_OFFICE = { name: "Meta office", lat: 42.36554, lng: -71.0809, address: "100 Binney St" };
// Hand-verified (ADR 0053). OSM's own "Meta" node sits at 1 Broadway, 209 m from the T, so the office is an
// alias, never a POI lookup. The T coords are the OSM Kendall/MIT station node carrying 300 Main Street.
const KENDALL_T = { name: "Kendall/MIT T", lat: 42.36242, lng: -71.08572, address: "300 Main Street" };
/** @type {Map<string, Place>} normalized phrase -> place */
const ALIASES = new Map([
  ["meta office", META_OFFICE],
  ["100 binney", META_OFFICE],
  ["100 binney st", META_OFFICE],
  ["100 binney street", META_OFFICE],
  ["kendall mit t", KENDALL_T],
  ["kendall t", KENDALL_T],
]);

const rad = (/** @type {number} */ d) => (d * Math.PI) / 180;

/**
 * Great-circle metres between [lat, lng] pairs.
 * @param {[number, number]} a
 * @param {[number, number]} b
 */
function haversine(a, b) {
  const h =
    Math.sin(rad(b[0] - a[0]) / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(rad(b[1] - a[1]) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** @param {WalkGraph} graph */
function adjacency(graph) {
  /** @type {[number, number][][]} */
  const adj = graph.nodes.map(() => []);
  for (const [i, j, w] of graph.edges) {
    adj[i].push([j, w]);
    adj[j].push([i, w]);
  }
  return adj;
}

/**
 * Node indices of the largest connected component.
 * @param {[number, number][][]} adj
 */
function largestComponent(adj) {
  const seen = new Uint8Array(adj.length);
  /** @type {number[]} */
  let best = [];
  for (let start = 0; start < adj.length; start += 1) {
    if (seen[start]) continue;
    seen[start] = 1;
    const comp = [start];
    for (let k = 0; k < comp.length; k += 1) {
      for (const [j] of adj[comp[k]]) {
        if (!seen[j]) {
          seen[j] = 1;
          comp.push(j);
        }
      }
    }
    if (comp.length > best.length) best = comp;
  }
  return best;
}

/**
 * @param {[number, number][]} nodes
 * @param {number[]} candidates
 * @param {[number, number]} p
 */
function nearest(nodes, candidates, p) {
  let best = candidates[0];
  let bestD = Infinity;
  for (const i of candidates) {
    const d = haversine(nodes[i], p);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Binary min-heap of [priority, node]; stale entries are skipped by the caller (lazy deletion). */
class Heap {
  constructor() {
    /** @type {[number, number][]} */
    this.items = [];
  }

  get size() {
    return this.items.length;
  }

  /** @param {[number, number]} item */
  push(item) {
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (a[parent][0] <= a[i][0]) break;
      [a[parent], a[i]] = [a[i], a[parent]];
      i = parent;
    }
  }

  pop() {
    const a = this.items;
    const top = a[0];
    const last = /** @type {[number, number]} */ (a.pop());
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * A* from s to t; both lie in one component, so a path always exists.
 * @param {[number, number][]} nodes
 * @param {[number, number][][]} adj
 * @param {number} s
 * @param {number} t
 */
function aStar(nodes, adj, s, t) {
  const g = new Float64Array(nodes.length).fill(Infinity);
  const prev = new Int32Array(nodes.length).fill(-1);
  const closed = new Uint8Array(nodes.length);
  const heap = new Heap();
  g[s] = 0;
  heap.push([haversine(nodes[s], nodes[t]), s]);
  while (heap.size) {
    const [, u] = heap.pop();
    if (u === t) break;
    if (closed[u]) continue;
    closed[u] = 1;
    for (const [v, w] of adj[u]) {
      const cost = g[u] + w;
      if (cost < g[v]) {
        g[v] = cost;
        prev[v] = u;
        heap.push([cost + haversine(nodes[v], nodes[t]), v]);
      }
    }
  }
  const path = [t];
  while (path[path.length - 1] !== s) path.push(prev[path[path.length - 1]]);
  return { path: path.reverse(), length: g[t] };
}

/**
 * Shortest walk from `from` to `to`. Endpoints snap to the nearest node of the LARGEST component (a closer
 * island would strand the walk); an empty graph yields the straight line, flagged `fallback: true`.
 * @param {WalkGraph} graph
 * @param {LatLng} from
 * @param {LatLng} to
 * @returns {WalkRoute}
 */
export function route(graph, from, to) {
  /** @type {[number, number]} */
  const a = [from.lat, from.lng];
  /** @type {[number, number]} */
  const b = [to.lat, to.lng];
  const adj = adjacency(graph);
  const comp = largestComponent(adj);
  if (!comp.length) return { polyline: [a, b], length_m: haversine(a, b), fallback: true };
  const s = nearest(graph.nodes, comp, a);
  const t = nearest(graph.nodes, comp, b);
  const { path, length } = aStar(graph.nodes, adj, s, t);
  return { polyline: path.map((i) => graph.nodes[i]), length_m: length, fallback: false };
}

/** @param {string} text */
function normalize(text) {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** @param {Poi} poi @returns {Place} */
const placeOf = (poi) => ({ name: poi.name, lat: poi.lat, lng: poi.lng, address: poi.address });

/** @param {string} key @param {string} phrase whole-word containment */
const contains = (key, phrase) => ` ${key} `.includes(` ${phrase} `);

/**
 * Resolve a typed place: alias, then exact POI name, then the shortest alias/POI name containing the phrase as
 * whole words. A miss (blank phrase included) returns the closest names by shared words so it never dead-ends.
 * @param {string} phrase
 * @param {Poi[]} pois
 * @returns {Place | { miss: true, suggestions: Place[] }}
 */
export function geocode(phrase, pois) {
  const q = normalize(phrase);
  /** @type {[string, Place][]} */
  const entries = [...ALIASES, ...pois.map((p) => /** @type {[string, Place]} */ ([normalize(p.name), placeOf(p)]))];
  if (q) {
    const exact = entries.find(([key]) => key === q);
    if (exact) return exact[1];
    const partial = entries.filter(([key]) => contains(key, q)).sort((x, y) => x[0].length - y[0].length)[0];
    if (partial) return partial[1];
  }
  const words = new Set(q.split(" ").filter(Boolean));
  const score = (/** @type {string} */ key) => key.split(" ").filter((w) => words.has(w)).length;
  const ranked = entries.map(([key, place], i) => ({ s: score(key), i, place })).sort((x, y) => y.s - x.s || x.i - y.i);
  /** @type {Place[]} */
  const suggestions = [];
  for (const { place } of ranked) {
    if (suggestions.length === MAX_SUGGESTIONS) break;
    if (!suggestions.some((s) => s.name === place.name)) suggestions.push(place);
  }
  return { miss: true, suggestions };
}
