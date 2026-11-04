// @ts-check
// Auto-loci (MEM-085, ADR 0047 / 0053): the POIs worth standing at along a routed walk, derived on demand
// from the POI table and the route polyline. Pure and deterministic, so fixture mode and tests see the
// same list and nothing about the pool is stored.

/**
 * @typedef {{ osm_id: string, name: string, lat: number, lng: number, address: string | null,
 *   street: string | null }} Poi
 * @typedef {{ key: string, osm_id: string, name: string, lat: number, lng: number,
 *   address: string | null, label: string }} Candidate
 */

/** ADR 0047's outer radius; 30 vs 50 m tuning is undecided (plan item 48), so nearer POIs qualify too. */
const RADIUS_M = 50;
/** ADR 0053: seeded stations have no osm_id, so a POI this close to a station is that station. */
const STATION_DEDUPE_M = 15;
/** Even spacing: consecutive candidates at least this far apart measured along the route. */
const SPACING_M = 40;

const R = 6371008.8;
const RAD = Math.PI / 180;

/**
 * Local equirectangular metres of b relative to a (sub-metre accurate at walk scale).
 * @param {number[]} a [lat, lng] @param {number[]} b [lat, lng] @returns {[number, number]}
 */
function xy(a, b) {
  return [(b[1] - a[1]) * RAD * R * Math.cos(a[0] * RAD), (b[0] - a[0]) * RAD * R];
}

/**
 * Distance from p to the polyline and the along-route position of its nearest point.
 * @param {number[]} p @param {number[][]} line @returns {{ dist: number, along: number }}
 */
function project(p, line) {
  let best = { dist: Infinity, along: 0 };
  let walked = 0;
  for (let i = 0; i + 1 < line.length; i++) {
    const [bx, by] = xy(line[i], line[i + 1]);
    const [px, py] = xy(line[i], p);
    const len = Math.hypot(bx, by);
    const t = len === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / (len * len)));
    const dist = Math.hypot(px - t * bx, py - t * by);
    if (dist < best.dist) best = { dist, along: walked + t * len };
    walked += len;
  }
  return best;
}

const SUFFIXES = new Map([["street", "st"], ["avenue", "ave"]]);

/** "100 Binney Street" and "100 binney st." compare equal. @param {string} address */
function addressKey(address) {
  const words = address.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ");
  return words.map((w) => SUFFIXES.get(w) ?? w).join(" ");
}

/**
 * @param {number[][]} polyline [[lat, lng], ...] (walk_route.js route().polyline)
 * @param {ReadonlyArray<Poi>} pois kendall_pois.json rows
 * @param {ReadonlyArray<{ coords?: { lat: number, lon: number } }>} [existingStations] stations without
 *   coords (imported from a backup) are ignored
 * @returns {Candidate[]} in route order, start to end
 */
export function candidates(polyline, pois, existingStations = []) {
  if (polyline.length < 2) return [];
  const stations = existingStations.flatMap((s) => (s.coords ? [[s.coords.lat, s.coords.lon]] : []));
  const seenIds = new Set();
  const seenNames = new Set();
  // One building is one landmark (MEM-088): two POIs at one address read as a duplicate station.
  const seenAddresses = new Set(existingStations.flatMap((s) => (s.address ? [addressKey(s.address)] : [])));
  /** @type {Array<{ poi: Poi, along: number, label: string }>} */
  const eligible = [];
  for (const poi of pois) {
    const label = poi.address ? poi.address : poi.street ? `near ${poi.street}` : null;
    if (label === null || seenIds.has(poi.osm_id) || seenNames.has(poi.name)) continue;
    const p = [poi.lat, poi.lng];
    const { dist, along } = project(p, polyline);
    if (dist > RADIUS_M) continue;
    if (stations.some((s) => Math.hypot(...xy(s, p)) <= STATION_DEDUPE_M)) continue;
    const addr = poi.address ? addressKey(poi.address) : null;
    if (addr !== null && seenAddresses.has(addr)) continue;
    if (addr !== null) seenAddresses.add(addr);
    seenIds.add(poi.osm_id);
    seenNames.add(poi.name);
    eligible.push({ poi, along, label });
  }
  eligible.sort((a, b) => a.along - b.along);
  /** @type {Candidate[]} */
  const out = [];
  let last = -Infinity;
  for (const { poi, along, label } of eligible) {
    if (along - last < SPACING_M) continue;
    last = along;
    const { osm_id, name, lat, lng, address } = poi;
    out.push({ key: `candidate:osm:${osm_id}`, osm_id, name, lat, lng, address, label });
  }
  return out;
}
