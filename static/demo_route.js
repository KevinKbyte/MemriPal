// @ts-check
// Kendall demo route (MEM-077, plan S6): the Kendall/MIT -> Meta (100 Binney St) walk the real map was
// designed around. Stations mirror docs/design/map/preview.js STATIONS in order; coords come from its
// [lng, lat] pairs at 5 dp, swapped to the store's { lat, lon }. Kept as code, not in
// fixtures/demo/route_backup.json, because backups never carry coordinates (ADR 0033). Ids are fixed so the
// demo is stable across loads. Addresses (ADR 0053) were hand-checked against OSM addr tags (Nominatim,
// 2026-11-03): the named landmark's own address; station 5's "Kendall Building" has no OSM entry, so it
// takes the address nearest its pin (Sumiao Hunan Kitchen / Vivo Apartments, ~20 m). Emoji are hand-picked
// (ADR 0057), not emojiFor's: a walking-direction name misleads the keyword table (station 5 has no keyword).

/**
 * @typedef {Pick<import("./route_store.js").Station, "id" | "n" | "name"> & {
 *   coords: import("./route_store.js").Coords, address: string, emoji: string,
 * }} DemoStation
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
      name: "Kendall/MIT station: exit onto Main St and walk east toward the One Broadway tower",
      coords: { lat: 42.36238, lon: -71.0856 },
      address: "300 Main St",
      emoji: "\u{1F687}",
    },
    {
      id: "1b8f6d42-3e5c-4a97-b2da-4f9e7c3a8b02",
      n: 2,
      name: "One Broadway tower (Brothers Marketplace at its base): bear left onto Third St",
      coords: { lat: 42.36265, lon: -71.08441 },
      address: "1 Broadway",
      emoji: "\u{1F3D9}\u{FE0F}",
    },
    {
      id: "2c9a7e53-4f6d-4ba8-83eb-5a0f8d4b9c03",
      n: 3,
      name: "Watermark Kendall towers at Kendall St / Potter St: keep straight on Third St",
      coords: { lat: 42.36385, lon: -71.08347 },
      address: "350 Third St",
      emoji: "\u{1F3E2}",
    },
    {
      id: "3dab8f64-5a7e-4cb9-94fc-6b1a9e5cad04",
      n: 4,
      name: "Third Square Apartments at Munroe St / Linskey Way: keep straight on Third St",
      coords: { lat: 42.36509, lon: -71.08277 },
      address: "285 Third St",
      emoji: "\u{1F3D8}\u{FE0F}",
    },
    {
      id: "4ebc9a75-6b8f-4dca-a50d-7c2baf6dbe05",
      n: 5,
      name: "Kendall Building (old brick boiler works) at Binney St: turn right onto Binney St",
      coords: { lat: 42.36573, lon: -71.08237 },
      address: "270 Third St",
      emoji: "\u{1F3ED}",
    },
    {
      id: "5fcdab86-7c9a-4edb-b61e-8d3cba7ecf06",
      n: 6,
      name: "Meta office, 100 Binney St: on your right, Toomey Park across the street",
      coords: { lat: 42.36554, lon: -71.0809 },
      address: "100 Binney St",
      emoji: "\u{1F4BB}",
    },
  ],
});
