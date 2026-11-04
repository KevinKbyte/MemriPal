// Generates static/data/demo_routes.json (MEM-133, ADR 0079): curated demo routes made by planRoute over the
// committed Kendall graph + POIs. Deterministic: station ids are fixed (<routeId>-s<n>), never pickStations'
// random ids. Run directly to rewrite the file: node scripts/gen_demo_routes.mjs. Importing it writes nothing.
import { writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { emojiFor } from "../static/landmark_emoji.js";
import { planRoute } from "../static/route_plan.js";

const COFFEE = /caf|coffee|starbucks|blue bottle|dunkin/i;
// Well-known Kendall/MIT landmarks a visitor would recognise; looked up by exact POI name.
const LANDMARKS = ["The Big Sail", "Transparent Horizon", "List Visual Arts Center", "MIT.nano", "Hayden Memorial Library", "Barker Library", "Radome", "Picower Institute for Learning and Memory (MIT)"];
const LOOP_MAX = 8;

/** @param {string} routeId @param {any[]} stations */
const fixIds = (routeId, stations) => stations.map((s, i) => ({ ...s, id: `${routeId}-s${i + 1}`, n: i + 1 }));

/** @param {string} id @param {string} name @param {string} from @param {string} to @param {any} data */
function planned(id, name, from, to, data) {
  const plan = planRoute(from, to, data);
  if (!plan.ok) throw new Error(`${id}: ${plan.text}`);
  return { id, name, kind: "daily", stations: fixIds(id, plan.stations) };
}

/** Landmarks sorted counter-clockwise by angle around their centroid (lng = x, lat = y): a simple polygon. */
function landmarkLoop(pois) {
  const seen = new Set();
  const marks = [];
  for (const name of LANDMARKS) {
    const p = pois.find((q) => q.name === name);
    if (p && !seen.has(name) && marks.length < LOOP_MAX) {
      seen.add(name);
      marks.push(p);
    }
  }
  const cx = marks.reduce((s, p) => s + p.lng, 0) / marks.length;
  const cy = marks.reduce((s, p) => s + p.lat, 0) / marks.length;
  const angle = (p) => Math.atan2(p.lat - cy, p.lng - cx);
  marks.sort((a, b) => angle(a) - angle(b));
  const stations = marks.map((p) => {
    const st = { id: "", n: 0, name: p.name, coords: { lat: p.lat, lon: p.lng }, emoji: emojiFor({ name: p.name }) };
    if (p.address) st.address = p.address;
    return st;
  });
  return { id: "demo-route-landmarks", name: "Landmark loop", kind: "daily", stations: fixIds("demo-route-landmarks", stations) };
}

/** @param {{ graph: any, pois: any[] }} data */
export function generateDemoRoutes(data) {
  const cafe = data.pois.find((p) => COFFEE.test(p.name));
  if (!cafe) throw new Error("no cafe POI");
  return [
    planned("demo-route-commute", "Morning commute to the T", "Meta office", "Kendall T", data),
    planned("demo-route-coffee", "Coffee run", "Meta office", cafe.name, data),
    landmarkLoop(data.pois),
  ];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const file = (f) => new URL(`../static/data/${f}`, import.meta.url);
  const read = (f) => JSON.parse(readFileSync(file(f), "utf8"));
  const routes = generateDemoRoutes({ graph: read("kendall_walk_graph.json"), pois: read("kendall_pois.json") });
  writeFileSync(file("demo_routes.json"), `${JSON.stringify(routes, null, 2)}\n`);
}
