// @ts-check
// Landmark fun facts + editable multisensory connections (MEM-120, phase A): a pure module, no UI mount.
// Facts are seeded per DEMO_ROUTE station and hand-checked (2026-11-04): every URL was fetched and its page
// states the fact. Connections use the MEM-087 station shape ({ taps, profile }) and persist through the
// injected KV adapter (idb_adapter.js shape), the way route_store.js does.

import { DEMO_ROUTE } from "./demo_route.js";
import { TAP_GROUPS } from "./station_card.js";

/** @typedef {{ text: string, title: string, url: string }} LandmarkFact */
/** @typedef {{ taps: Record<string, string>, profile: Record<string, string> }} Connections */
/** @typedef {{ id: string, taps?: Record<string, string>, profile?: Record<string, string> }} StationLike */

export const MAX_FACTS = 3;
const LINE_MAX = 200;
const TAP_KEYS = ["sound", "smell", "feel", "mood"];
const PROFILE_KEYS = ["visual", "spatial", "conceptual"];

const WIKI = (/** @type {string} */ page) => `https://en.wikipedia.org/wiki/${page}`;
const STATION = { title: "Kendall/MIT station - Wikipedia", url: WIKI("Kendall/MIT_station") };
const SQUARE = { title: "Kendall Square - Wikipedia", url: WIKI("Kendall_Square") };
const TALLEST = {
  title: "List of tallest buildings in Cambridge, Massachusetts - Wikipedia",
  url: WIKI("List_of_tallest_buildings_in_Cambridge,_Massachusetts"),
};
const PUMP_DISTRICT = {
  title: "Blake and Knowles Steam Pump Company National Register District - Wikipedia",
  url: WIKI("Blake_and_Knowles_Steam_Pump_Company_National_Register_District"),
};

const [S1, S2, S3, S4, S5, S6] = DEMO_ROUTE.stations.map((s) => s.id);

/** Seeded facts keyed by DEMO_ROUTE station id, in display order. */
export const LANDMARK_FACTS = Object.freeze({
  [S1]: [
    { text: "Kendall station opened on March 23, 1912, as part of the original Cambridge subway.", ...STATION },
    {
      text: "Between the tracks sits the Kendall Band, musical sculptures by Paul Matisse (1986-1988) that riders play with levers on the platforms.",
      ...STATION,
    },
    {
      text: "In 1982 the MBTA renamed it Cambridge Center/MIT; after complaints, the name went back to Kendall/MIT in 1985.",
      ...STATION,
    },
  ],
  [S2]: [
    { text: "One Broadway is a 17-story, 230 ft tower finished in 1970.", ...TALLEST },
    {
      text: "It is the home of the Cambridge Innovation Center, a shared office for startups founded in 1999 by two MIT graduates.",
      title: "Cambridge Innovation Center - Wikipedia",
      url: WIKI("Cambridge_Innovation_Center"),
    },
    { text: "The Brothers Marketplace grocery opened at One Broadway in November 2019.", ...SQUARE },
  ],
  [S3]: [
    { text: "Watermark Kendall West, at 350 Third St, is a tower of about 24 floors finished in 2006.", ...TALLEST },
    {
      text: "Kendall Square's Broad Canal was dug before 1810, when Cambridge was a seaport; about 1,000 ft of it still runs from the Charles River.",
      title: "Broad Canal - Wikipedia",
      url: WIKI("Broad_Canal"),
    },
  ],
  [S4]: [
    {
      text: "In World War I the Blake and Knowles pump works grew to stretch down to Monroe Street; its buildings between Binney and Monroe were later torn down.",
      ...PUMP_DISTRICT,
    },
    {
      text: "From 1880 to 1910 East Cambridge factories made organs and pianos, furniture, soap and candles, and biscuits.",
      ...SQUARE,
    },
  ],
  [S5]: [
    {
      text: "Kendall Square is named after the Kendall Boiler and Tank Company, which was named after one of its owners, Edward Kendall.",
      ...SQUARE,
    },
    {
      text: "This building was the office of the Blake and Knowles Steam Pump Company; it took the Kendall name from a later owner.",
      ...PUMP_DISTRICT,
    },
    {
      text: "The old pump works block was listed on the National Register of Historic Places in 1997.",
      ...PUMP_DISTRICT,
    },
  ],
  [S6]: [
    {
      text: "Meta began as Facebook, founded in Cambridge, Massachusetts, in 2004; it was Facebook, Inc. until 2021.",
      title: "Meta Platforms - Wikipedia",
      url: WIKI("Meta_Platforms"),
    },
    { text: "Google, Facebook and IBM have research labs in or right next to Kendall Square.", ...SQUARE },
  ],
});

/**
 * Up to MAX_FACTS facts for a station, as copies; [] for an unknown id.
 * @param {string | undefined} stationId
 * @param {Record<string, LandmarkFact[]>} [table] defaults to LANDMARK_FACTS
 * @returns {LandmarkFact[]}
 */
export function factsFor(stationId, table = LANDMARK_FACTS) {
  if (typeof stationId !== "string" || !Object.hasOwn(table, stationId)) return [];
  return table[stationId].slice(0, MAX_FACTS).map((f) => ({ text: f.text, title: f.title, url: f.url }));
}

const clip = (/** @type {string} */ s) => (s.length <= LINE_MAX ? s : `${s.slice(0, LINE_MAX - 3).trimEnd()}...`);

/**
 * Default generator: no model call. Taps copy the station's seeded taps; profile keeps its seeded visual and
 * spatial lines and makes the first fact the conceptual hook (falling back to the seeded conceptual line).
 * @param {StationLike} station
 * @returns {Connections}
 */
export function defaultGenerate(station) {
  const seeded = station.profile ?? {};
  const fact = factsFor(station.id)[0];
  const name = /** @type {any} */ (station).name ?? "";
  const profile = {
    visual: seeded.visual || name,
    spatial: seeded.spatial || name,
    conceptual: clip(fact ? fact.text : seeded.conceptual || name),
  };
  return { taps: { ...(station.taps ?? {}) }, profile };
}

/**
 * Throws when the connections do not fit the station card's shape.
 * @param {Connections} conn
 */
function validate(conn) {
  const taps = conn?.taps ?? {};
  const profile = conn?.profile ?? {};
  for (const k of Object.keys(taps)) {
    if (!TAP_KEYS.includes(k)) throw new Error(`Unknown tap "${k}".`);
  }
  for (const k of TAP_KEYS) {
    const options = /** @type {Record<string, string[]>} */ (TAP_GROUPS)[k];
    if (!options.includes(taps[k])) throw new Error(`Pick one of ${options.join(", ")} for ${k}.`);
  }
  for (const k of Object.keys(profile)) {
    if (!PROFILE_KEYS.includes(k)) throw new Error(`Unknown profile line "${k}".`);
  }
  for (const k of PROFILE_KEYS) {
    const v = profile[k];
    if (typeof v !== "string" || v.trim() === "") throw new Error(`The ${k} line can't be empty.`);
    if (v.length > LINE_MAX) throw new Error(`Keep the ${k} line to ${LINE_MAX} characters.`);
  }
}

const KEY = (/** @type {string} */ stationId) => `connections:${stationId}`;

/**
 * @param {import("./route_store.js").KvAdapter} adapter
 * @param {{ generate?: (station: StationLike) => Connections | Promise<Connections> }} [opts]
 */
export function createConnectionStore(adapter, { generate = defaultGenerate } = {}) {
  /** @param {string} stationId @param {Connections} conn */
  const save = async (stationId, conn) => {
    const out = { taps: { ...conn.taps }, profile: { ...conn.profile } };
    validate(out);
    await adapter.put(KEY(stationId), { type: "connections", stationId, connections: out });
    return out;
  };

  /** @param {string} stationId @returns {Promise<Connections | null>} */
  const get = async (stationId) => (await adapter.get(KEY(stationId)))?.connections ?? null;

  return {
    get,
    /** Builds and stores fresh connections, replacing any stored ones. @param {StationLike} station */
    generate: async (station) => save(station.id, await generate(station)),
    /** Merges a partial { taps?, profile? } into the stored connections. */
    edit: async (/** @type {string} */ stationId, /** @type {Partial<Connections>} */ patch) => {
      const cur = await get(stationId);
      if (!cur) throw new Error("Generate connections for this station first.");
      return save(stationId, {
        taps: { ...cur.taps, ...(patch?.taps ?? {}) },
        profile: { ...cur.profile, ...(patch?.profile ?? {}) },
      });
    },
    /** Overwrites the stored connections. */
    replace: async (/** @type {string} */ stationId, /** @type {Connections} */ conn) => save(stationId, conn),
  };
}
