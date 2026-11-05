// @ts-check
// Kendall demo route (MEM-077, plan S6): the Kendall/MIT -> Meta (100 Binney St) walk the real map was
// designed around. Stations mirror docs/design/map/preview.js STATIONS in order; coords come from its
// [lng, lat] pairs at 5 dp, swapped to the store's { lat, lon }. Kept as code, not in
// fixtures/demo/route_backup.json, because backups never carry coordinates (ADR 0033). Ids are fixed so the
// demo is stable across loads. Addresses (ADR 0053) were hand-checked against OSM addr tags (Nominatim,
// 2026-11-03): the named landmark's own address; station 5's Kendall Boiler and Tank building is 275 Third St
// (web-checked 2026-11-04). Emoji are hand-picked (ADR 0057), not emojiFor's: a station name naming two
// landmarks misleads the keyword table.

/**
 * @typedef {Pick<import("./route_store.js").Station, "id" | "n" | "name"> & {
 *   coords: import("./route_store.js").Coords, address: string, emoji: string,
 *   profile: Record<string, string>, taps: Record<string, string>,
 * }} DemoStation
 * Taps and profile (MEM-110) are hand-authored from Kev's six walk photos, one per station in walk order;
 * photo 6 is a nearby stand-in for the Meta office, where security barred photos. No `turn` tap: the
 * Next turn group was removed (MEM-135). No text gives a facing-dependent direction (MEM-137): places are
 * named by landmark and street, and the map draws the way between them.
 * @typedef {{ id: string, name: string, kind: "daily", stations: DemoStation[] }} DemoRoute
 */

/** @type {Readonly<DemoRoute>} */
export const DEMO_ROUTE = Object.freeze({
  id: "6f1c2a4e-8b3d-4c7a-9e21-5d0b7a3c9f10",
  name: "Kendall walk",
  kind: "daily",
  stations: [
    {
      id: "0a7e5c31-2d4b-4f86-a1c9-3e8d6b2f7a01",
      n: 1,
      name: "Kendall/MIT station: the Main St exit, a short walk from the One Broadway tower",
      coords: { lat: 42.36238, lon: -71.0856 },
      address: "300 Main St",
      emoji: "\u{1F687}",
      profile: {
        visual: "Red KENDALL OUTBOUND to Alewife sign over granite stairs going down; a TODAY TV screen at the stair head; red brick wall beside the exit",
        spatial: "Start on the Main St sidewalk at the T exit; follow the brick wall along Main St to the One Broadway tower",
        conceptual: "The red stripe on the KENDALL sign is the Red Line: picture red paint pouring through these pink granite walls into the ground",
      },
      taps: { sound: "Traffic", smell: "Fumes", feel: "Stairs", mood: "Busy" },
    },
    {
      id: "1b8f6d42-3e5c-4a97-b2da-4f9e7c3a8b02",
      n: 2,
      name: "One Broadway tower, Brothers Marketplace at its base, at Third St",
      coords: { lat: 42.36265, lon: -71.08441 },
      address: "1 Broadway",
      emoji: "\u{1F3D9}\u{FE0F}",
      profile: {
        visual: "Brown brutalist tower of ribbed window slots sitting on a pale glass box; red HY BIRD sign by the One Broadway door",
        spatial: "The tower stands where Main St meets Broadway; follow Third St from its corner",
        conceptual: "Number 1 Broadway: the ribbed brown tower is a giant numeral 1 standing on its glass box",
      },
      taps: { sound: "Traffic", smell: "Coffee", feel: "Windy", mood: "Grand" },
    },
    {
      id: "2c9a7e53-4f6d-4ba8-83eb-5a0f8d4b9c03",
      n: 3,
      name: "Watermark Kendall towers at Third St and Kendall St, Cafe Luna at the base",
      coords: { lat: 42.36385, lon: -71.08347 },
      address: "350 Third St",
      emoji: "\u{1F3E2}",
      profile: {
        visual: "White Watermark tower with a tall black banner; gold Cafe Luna script on a black awning; orange mums in the curb beds",
        spatial: "Third St at Kendall St; the cafe sits at the tower base; stay on Third St",
        conceptual: "A watermark on white paper: the tower is the sheet, the gold Cafe Luna script its mark",
      },
      taps: { sound: "Voices", smell: "Food", feel: "Shade", mood: "Cosy" },
    },
    {
      id: "3dab8f64-5a7e-4cb9-94fc-6b1a9e5cad04",
      n: 4,
      name: "Third Square Apartments, THIRD SQUARE letters on brown brick, on Third St",
      coords: { lat: 42.36509, lon: -71.08277 },
      address: "285 Third St",
      emoji: "\u{1F3D8}\u{FE0F}",
      profile: {
        visual: "Two steel squares and one orange square over THIRD SQUARE letters on brown brick; red fire hookup signs for 285 and 303 Third St below",
        spatial: "Brick wall on Third St, between the Watermark towers and Binney St; stay on Third St",
        conceptual: "Third Square on Third St: count the squares, steel one, steel two, orange three",
      },
      taps: { sound: "Quiet", smell: "None", feel: "Cold", mood: "Calm" },
    },
    {
      id: "4ebc9a75-6b8f-4dca-a50d-7c2baf6dbe05",
      n: 5,
      name: "Kendall Boiler and Tank building (old brick works) at Third St and Binney St",
      coords: { lat: 42.36573, lon: -71.08237 },
      address: "275 Third St",
      emoji: "\u{1F3ED}",
      profile: {
        visual: "Faded white ghost sign KENDALL BOILER AND TANK CO. across old red brick; tall arched black-frame windows; a walk signal at the corner",
        spatial: "Old brick works at Third St and Binney St; follow Binney St from this corner",
        conceptual: "Kendall Square is named for this boiler company: picture the whole square as steam from its tank",
      },
      taps: { sound: "Traffic", smell: "Rain", feel: "Windy", mood: "Odd" },
    },
    {
      id: "5fcdab86-7c9a-4edb-b61e-8d3cba7ecf06",
      n: 6,
      name: "Meta office, 100 Binney St: the end of the walk, One Medical at street level",
      coords: { lat: 42.36554, lon: -71.0809 },
      address: "100 Binney St",
      emoji: "\u{1F4BB}",
      profile: {
        visual: "Pink and white perforated metal swirl sculpture in a green garden bed; a pale slatted bench; red One Medical canopy behind",
        spatial: "Garden by 100 Binney St, Toomey Park a short walk away on Rogers St; Meta's door is just past it, so this sculpture marks the end",
        conceptual: "A pink and white mesh that twists into itself: a net that catches the whole walk at its last stop",
      },
      taps: { sound: "Voices", smell: "Flowers", feel: "Shade", mood: "Bright" },
    },
  ],
});

/**
 * @param {number} n
 * @param {string} name
 * @param {number} lat
 * @param {number} lon
 * @param {string} conceptual
 */
const principleStation = (n, name, lat, lon, conceptual) => ({
  id: `demo-route-principles-s${n}`, n, name, coords: { lat, lon }, profile: { conceptual },
});

// MEM-133: the default route a new user starts from; each station's learning point (profile.conceptual) teaches
// one of the six principles of engaging speaking, in walking order. Code, not demo_routes.json, so a failed
// fetch still seeds it. It walks DEMO_ROUTE's Kendall/MIT -> Binney St streets.
export const PRINCIPLES_ROUTE = Object.freeze({
  id: "demo-route-principles",
  name: "Six principles of engaging speaking",
  kind: /** @type {const} */ ("daily"),
  stations: [
    principleStation(1, "Kendall/MIT station exit on Main St", 42.36238, -71.0856, "Relevance: tie every point to what the audience cares about."),
    principleStation(2, "One Broadway tower", 42.36265, -71.08441, "Curiosity: open a question before you answer it."),
    principleStation(3, "Third St at Kendall St", 42.36385, -71.08347, "Clarity: one idea per sentence, plain words."),
    principleStation(4, "Third St at Munroe St", 42.36509, -71.08277, "Concreteness: show a specific example, story, or number."),
    principleStation(5, "Third St at Binney St", 42.36573, -71.08237, "Progression: each point builds on the last toward a destination."),
    principleStation(6, "100 Binney St", 42.36554, -71.0809, "Payoff: land the takeaway the audience can act on."),
  ],
});
