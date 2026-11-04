// Covers: MEM-100
// Requirement: every landmark gets the best-fit emoji for what it is, so the live map shows a coffee cup on a cafe,
// a tower on a tower and a train on a station instead of the same red pushpin everywhere (Kev: "where are the
// best fit emoji, i only see red pins"). The pick comes from the landmark's category, then its OSM tags, then its
// name: the first source that matches wins. Matching is case-insensitive, ignores accents (Cafe with an accent is
// a cafe), and only whole words count (a barber shop is a shop, not a bar; a parking garage is not a park), plural
// s/es included. In a long walking-direction name the landmark named first wins (the station you exit, not the
// tower you walk toward). Anything unrecognised, missing or malformed gets U+1F4CD (round pushpin) and never throws.
// Contract (RED; GREEN adds static/landmark_emoji.js, a pure module):
//   export const EMOJI_DEFAULT = "\u{1F4CD}";
//   export function emojiFor(input) -> non-empty string; input { name?, category?, tags?: Record<string,string> }.
//   Precedence category > tags > name. Tag values in insertion order with "_" read as " " (place_of_worship ->
//   "place of worship"); any shop key (any value) -> the shop emoji. Within one string: NFKD + strip combining
//   marks, lower-case, whole-word keyword (bounded by non-[a-z0-9] or string ends; optional trailing s / es),
//   multi-word keywords as phrases; the earliest match position wins, a tie goes to the longest keyword.
//   Non-object input, non-string name/category, non-object tags are ignored. No match -> EMOJI_DEFAULT.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

/** The module, or {} while it does not exist (so RED fails on assertions, not on load). */
const lib = await import("./landmark_emoji.js").catch(() => ({}));

/** @param {unknown} input */
function emojiFor(input) {
  assert.equal(typeof lib.emojiFor, "function", "static/landmark_emoji.js exports emojiFor");
  return lib.emojiFor(input);
}

const PUSHPIN = "\u{1F4CD}";
const E = {
  postOffice: "\u{1F3E4}",
  station: "\u{1F689}",
  bus: "\u{1F68F}",
  tower: "\u{1F3D9}\u{FE0F}",
  office: "\u{1F3E2}",
  tech: "\u{1F4BB}",
  beer: "\u{1F37A}",
  cafe: "\u{2615}",
  restaurant: "\u{1F374}",
  museum: "\u{1F3DB}\u{FE0F}",
  church: "\u{26EA}",
  park: "\u{1F333}",
  library: "\u{1F4DA}",
  university: "\u{1F393}",
  school: "\u{1F3EB}",
  bridge: "\u{1F309}",
  hotel: "\u{1F3E8}",
  shop: "\u{1F6D2}",
  hospital: "\u{1F3E5}",
  bank: "\u{1F3E6}",
  theater: "\u{1F3AD}",
  factory: "\u{1F3ED}",
  apartment: "\u{1F3D8}\u{FE0F}",
  stadium: "\u{1F3DF}\u{FE0F}",
  fountain: "\u{26F2}",
  statue: "\u{1F5FD}",
};

// One realistic landmark name per table row.
const BY_NAME = [
  ["Kendall Square Post Office", E.postOffice],
  ["Kendall/MIT Station", E.station],
  ["Ames St bus stop", E.bus],
  ["One Broadway Tower", E.tower],
  ["Akamai Headquarters", E.office],
  ["Kendall Tech Hub", E.tech],
  ["Night Shift Brewery", E.beer],
  ["Blue Bottle Coffee", E.cafe],
  ["Sumiao Hunan Kitchen", E.restaurant],
  ["MIT Museum", E.museum],
  ["Old North Church", E.church],
  ["Toomey Park", E.park],
  ["Cambridge Public Library", E.library],
  ["Massachusetts Institute of Technology", E.university],
  ["Cambridge Rindge and Latin School", E.school],
  ["Longfellow Bridge", E.bridge],
  ["Kendall Hotel", E.hotel],
  ["Brothers Marketplace", E.shop],
  ["Massachusetts General Hospital", E.hospital],
  ["Cambridge Savings Bank", E.bank],
  ["Brattle Theatre", E.theater],
  ["Old Boiler Factory", E.factory],
  ["Third Square Apartments", E.apartment],
  ["Harvard Stadium", E.stadium],
  ["Kendall Square Fountain", E.fountain],
  ["Statue of Liberty", E.statue],
];

const graphemes = (s) => [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(s)].length;

/** @param {Array<[unknown, string]>} cases */
function expectAll(cases) {
  for (const [input, want] of cases) {
    assert.equal(emojiFor(input), want, `emojiFor(${JSON.stringify(input)})`);
  }
}

describe("best-fit landmark emoji from category, OSM tags and name (MEM-100)", () => {
  test("EMOJI_DEFAULT is U+1F4CD (round pushpin)", () => {
    assert.equal(lib.EMOJI_DEFAULT, PUSHPIN);
  });

  test("a realistic landmark name maps to its row's emoji, for every row of the table", () => {
    assert.equal(new Set(BY_NAME.map(([, e]) => e)).size, Object.keys(E).length, "precondition: one name per row");
    expectAll(BY_NAME.map(([name, e]) => [{ name }, e]));
  });

  test("every table emoji and the default are exactly one grapheme", () => {
    for (const [k, e] of Object.entries({ ...E, default: PUSHPIN })) assert.equal(graphemes(e), 1, `${k} is one grapheme`);
    for (const [name] of BY_NAME) assert.equal(graphemes(emojiFor({ name })), 1, `emojiFor(${name}) is one grapheme`);
  });

  test("whole words only: a keyword inside a longer word does not match", () => {
    expectAll([
      [{ name: "Barber shop" }, E.shop],
      [{ name: "Parking garage" }, PUSHPIN],
      [{ name: "Public Market" }, E.shop],
      [{ name: "Technology Square" }, PUSHPIN],
      [{ name: "Cambridge Savings Bank" }, E.bank],
    ]);
  });

  test("plurals: a keyword followed by s or es still matches", () => {
    expectAll([
      [{ name: "Watermark Kendall towers" }, E.tower],
      [{ name: "Old churches" }, E.church],
      [{ name: "Kendall buses" }, E.bus],
    ]);
  });

  test("case-insensitive and accent-folded", () => {
    expectAll([
      [{ name: "CAMBRIDGE PUBLIC LIBRARY" }, E.library],
      [{ name: "Caf\u{E9} Nero" }, E.cafe],
      [{ name: "CAFE\u{301} NERO" }, E.cafe],
    ]);
  });

  test("multi-word keywords match as phrases", () => {
    expectAll([
      [{ name: "Central Square post office" }, E.postOffice],
      [{ name: "Main St bus stop" }, E.bus],
      [{ name: "Late night fast food" }, E.restaurant],
      [{ name: "A quiet place of worship" }, E.church],
    ]);
  });

  test("the keyword earliest in the name wins (the landmark named first in a walking direction)", () => {
    expectAll([
      [{ name: "Kendall/MIT station: exit onto Main St and walk east toward the One Broadway tower" }, E.station],
      [{ name: "One Broadway tower (Brothers Marketplace at its base)" }, E.tower],
      [{ name: "Meta office, 100 Binney St: on your right, Toomey Park" }, E.office],
      [{ name: "Central Square post office" }, E.postOffice],
    ]);
  });

  test("category beats tags and name; tags beat name; an unmatched category or tags fall through", () => {
    expectAll([
      [{ name: "Blue Bottle Cafe", category: "library" }, E.library],
      [{ name: "Blue Bottle Cafe", category: "library", tags: { amenity: "pub" } }, E.library],
      [{ name: "Corner Cafe", tags: { amenity: "pub" } }, E.beer],
      [{ name: "Corner Cafe", category: "zzz", tags: { amenity: "pub" } }, E.beer],
      [{ name: "Corner Cafe", category: "zzz", tags: { amenity: "zzz" } }, E.cafe],
      [{ name: "Corner Cafe", category: "zzz" }, E.cafe],
    ]);
  });

  test("OSM tag values: underscores read as spaces, first matching value in insertion order wins", () => {
    expectAll([
      [{ tags: { amenity: "place_of_worship" } }, E.church],
      [{ tags: { amenity: "fast_food" } }, E.restaurant],
      [{ tags: { railway: "station" } }, E.station],
      [{ tags: { building: "yes", amenity: "library" } }, E.library],
      [{ tags: { tourism: "museum", amenity: "cafe" } }, E.museum],
      [{ tags: { amenity: "cafe", tourism: "museum" } }, E.cafe],
    ]);
  });

  test("any shop tag key means a shop, whatever its value", () => {
    expectAll([
      [{ tags: { shop: "bicycle" } }, E.shop],
      [{ tags: { shop: "yes" } }, E.shop],
      [{ name: "Kendall Building", tags: { shop: "zzz" } }, E.shop],
    ]);
  });

  test("no match, empty or malformed input -> EMOJI_DEFAULT, never a throw", () => {
    const cases = [
      { name: "Kendall Building" },
      { name: "" },
      {},
      undefined,
      null,
      { name: 42 },
      { name: "x", tags: "pub" },
      "Blue Bottle Coffee",
      42,
      { name: null, category: null, tags: null },
      { category: 7 },
      { tags: { amenity: 5 } },
    ];
    for (const input of cases) {
      let got;
      assert.doesNotThrow(() => { got = emojiFor(input); }, `emojiFor(${JSON.stringify(input)}) throws`);
      assert.equal(got, PUSHPIN, `emojiFor(${JSON.stringify(input)})`);
    }
  });

  test("malformed fields are skipped, valid ones still count", () => {
    expectAll([
      [{ name: "MIT Museum", category: 7 }, E.museum],
      [{ name: "MIT Museum", tags: "pub" }, E.museum],
      [{ name: "Corner Cafe", tags: { amenity: 5 } }, E.cafe],
      [{ name: 42, category: "hotel" }, E.hotel],
    ]);
  });

  test("deterministic: the same input twice gives the same emoji", () => {
    const inputs = [{ name: "Blue Bottle Coffee" }, { tags: { amenity: "pub" } }, { name: "Kendall Building" }, null];
    for (const input of inputs) assert.equal(emojiFor(input), emojiFor(input), JSON.stringify(input));
  });
});
