// @ts-check
// Pure pieces of "Map a new route" (MEM-088): the distance line, station picking, the miss message.
// The page wiring lives in route_new.js; these stay DOM-free so route_builder.test.mjs pins them directly.
import { emojiFor } from "./landmark_emoji.js";
import { newId } from "./uuid.js";

/** Typical walking pace, metres per minute. */
const WALK_M_PER_MIN = 80;

/**
 * @param {number} m walk length in metres
 * @param {boolean} fallback true when walk_route.js route() had no graph and drew a straight line
 */
export function distanceLabel(m, fallback) {
  const dist = m < 1000 ? `${Math.round(m / 50) * 50} m` : `${(m / 1000).toFixed(1)} km`;
  const mins = Math.max(1, Math.round(m / WALK_M_PER_MIN));
  return `About ${dist}, about ${mins} min walk${fallback ? " (straight line; walking paths unavailable)" : ""}`;
}

/**
 * @typedef {{ name: string, lat: number, lng: number, address?: string | null }} Place
 * @typedef {{ name: string, lat: number, lng: number, address?: string | null, label?: string }} Cand
 * @typedef {{ id: string, n: number, name: string, coords: { lat: number, lon: number },
 *   address?: string, emoji: string }} NewStation
 */

/**
 * Start, up to max - 2 evenly sampled landmarks, end. Emoji is picked once here, at creation (ADR 0057).
 * @param {Place} from @param {Place} to @param {ReadonlyArray<Cand>} cands in route order
 * @param {number} [max]
 * @returns {NewStation[]}
 */
export function pickStations(from, to, cands, max = 8) {
  const k = max - 2;
  const middle = cands.length <= k
    ? cands
    : Array.from({ length: k }, (_, i) => cands[Math.round((i * (cands.length - 1)) / (k - 1))]);
  return [from, ...middle, to].map((p, i) => {
    const address = p.address || /** @type {Cand} */ (p).label;
    /** @type {NewStation} */
    const st = { id: newId(), n: i + 1, name: p.name, coords: { lat: p.lat, lon: p.lng }, emoji: emojiFor({ name: p.name }) };
    if (address) st.address = address;
    return st;
  });
}

/** @param {string} phrase @param {ReadonlyArray<{ name: string }>} suggestions */
export function missText(phrase, suggestions) {
  const miss = `No match for "${phrase}".`;
  return suggestions.length ? `${miss} Try: ${suggestions.map((s) => s.name).join(", ")}.` : miss;
}
