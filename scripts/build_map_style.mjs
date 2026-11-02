// Build the self-hosted MapLibre styles for the Kendall map extract (MEM-075). Node built-ins only.
// Usage: node scripts/build_map_style.mjs   -> writes static/map/style-light.json and style-dark.json
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const BASEMAPS_JS = join(REPO, "vendor-node", "protomaps-basemaps", "basemaps.js");
const MAP_DIR = join(REPO, "static", "map");
const FLAVORS = ["light", "dark"];

// The vendored build is a browser IIFE (`var basemaps = ...`), not a module; run it in a sandbox.
function loadBasemaps() {
  const sandbox = {};
  vm.runInNewContext(readFileSync(BASEMAPS_JS, "utf8"), sandbox, { filename: BASEMAPS_JS });
  return sandbox.basemaps;
}

let basemaps;

/** Version-8 MapLibre style for "light" | "dark", every asset served from /static/map/ (offline-safe). */
export function buildStyle(flavor) {
  if (!FLAVORS.includes(flavor)) throw new Error(`unknown flavor: ${flavor}`);
  basemaps ??= loadBasemaps();
  // JSON round-trip drops the sandbox realm's prototypes so deepEqual against parsed JSON holds.
  const layers = JSON.parse(
    JSON.stringify(basemaps.layers("protomaps", basemaps.namedFlavor(flavor), { lang: "en" })),
  );
  // Only icons in the vendored sprite may be requested (a missing one logs `Image "x" could not be
  // loaded`); other kinds get "" so the label draws without an icon.
  const pois = layers.find((layer) => layer.id === "pois");
  if (!pois) throw new Error(`no pois layer in ${flavor} basemap`);
  const sprite = JSON.parse(readFileSync(join(MAP_DIR, "sprites", "v4", `${flavor}.json`), "utf8"));
  const icons = Object.keys(sprite).filter((key) => key !== "station").sort();
  pois.layout["icon-image"] = ["match", ["get", "kind"], "station", "train_station", icons, ["get", "kind"], ""];
  return {
    version: 8,
    glyphs: "/static/map/fonts/{fontstack}/{range}.pbf",
    sprite: `/static/map/sprites/v4/${flavor}`,
    sources: {
      protomaps: {
        type: "vector",
        url: "pmtiles://kendall",
        attribution: "(c) OpenStreetMap contributors, Protomaps",
      },
    },
    layers,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const flavor of FLAVORS) {
    const path = join(MAP_DIR, `style-${flavor}.json`);
    writeFileSync(path, `${JSON.stringify(buildStyle(flavor), null, 2)}\n`);
    console.log(`wrote ${path}`);
  }
}
