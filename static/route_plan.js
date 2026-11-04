// @ts-check
// The MEM-088 Find core as a pure function (MEM-132, ADR 0079): geocode both phrases on the committed POIs,
// walk the committed graph, pick landmarks along it. Shared by the Map-a-new-route form (route_new.js), the
// Pal chat create_route tool (chat_route.js) and the demo-route generator (scripts/gen_demo_routes.mjs).

import { candidates } from "./auto_loci.js";
import { missText, pickStations } from "./route_builder.js";
import { geocode, route } from "./walk_route.js";

export const NAME_MAX = 40;

/**
 * @typedef {{ name: string, lat: number, lng: number, address?: string | null }} Place
 * @typedef {{ ok: true, from: Place, to: Place, stations: ReturnType<typeof pickStations>, name: string,
 *   walk: ReturnType<typeof route> } | { ok: false, text: string }} Plan
 */

/**
 * @param {string} fromPhrase
 * @param {string} toPhrase
 * @param {{ graph: any, pois: any[] }} data
 * @returns {Plan} never throws on a blank or unmapped phrase
 */
export function planRoute(fromPhrase, toPhrase, { graph, pois }) {
  /** @type {Place[]} */
  const places = [];
  for (const [raw, what] of [[fromPhrase, "start"], [toPhrase, "end"]]) {
    const phrase = String(raw ?? "").trim();
    if (!phrase) return { ok: false, text: `Type a ${what}, like Kendall/MIT T or Meta office.` };
    const hit = geocode(phrase, pois);
    if ("miss" in hit) return { ok: false, text: missText(phrase, hit.suggestions) };
    places.push(hit);
  }
  const [from, to] = places;
  const walk = route(graph, from, to);
  const ends = places.map((p) => ({ coords: { lat: p.lat, lon: p.lng }, address: p.address ?? undefined }));
  const stations = pickStations(from, to, candidates(walk.polyline, pois, ends));
  return { ok: true, from, to, stations, name: `${from.name} to ${to.name}`.slice(0, NAME_MAX), walk };
}
