# 0053: Stations carry an optional street address; public-place coords at 5 dp, the user's own GPS stays at 4 dp

Status: Accepted
Amends: [0031](0031-route-station-store.md) (the 4 dp cap now applies to the user's own GPS location only),
[0042](0042-kendall-demo-route-seeding.md) (seeded coords at 5 dp). Relates:
[0033](0033-backup-v2-routes-no-coordinates.md) (backup), [0046](0046-offline-walking-graph-routing-and-geocode.md)
(POI JSON, aliases), [0047](0047-derived-auto-loci-and-swap.md) (candidates), MEM-084 / MEM-085 / MEM-088
(`docs/plans/2026-11-03-demo-flow.md` S2, S3, S6).
Date: 2026-11-03
Source: Kev, 2026-11-03: "the landmarks should have the exact coordinates/street, I was having trouble finding where
to go when i was taking pictures since none had exact street numbers". Decided after an adversarial pass.

## Context

A station today is a name plus coords rounded to 4 dp; nothing tells the walker which door to stand at. Constraints:

- `coordsOf` / `round4` (`static/route_store.js:53-59`) round every stored coord to 4 dp, `seedRoute` included
  (`:348`); `static/route_store.test.mjs:229-252` pins 4 dp. At Kendall a 4 dp step is about 11 m north-south and
  8 m east-west, enough to put a Maps pin on the wrong side of Binney St.
- The "meta office" endpoint (42.36554,-71.0809) is a hand-kept 0046 alias, not a POI row; the OSM "Meta" node sits
  about 209 m away.
- Backup v2 is an allowlist (`STATION_KEYS`, `static/backup_routes.js:10`) with no coords (0033). The demo loads via
  `seedRoute` (`static/flow.js:352`), not import.
- The walk graph + POI JSON is about 990 KB against the plan's < 1 MB cap.

## Options considered

- (a) Optional `Station.address` (<= 100 chars, e.g. "285 Third St"); precision set by the call site (chosen).
  Address sources, first hit wins: hand-verified for the 6 `static/demo_route.js` stations and for alias endpoints
  (alias entries gain `address`, e.g. "100 Binney St"); then the POI's OSM `addr:housenumber` + `addr:street`, falling
  back to the enclosing building's addr tags; else the display reads "near <street>" and never claims a number.
  Public POI, seeded and alias coords are stored at 5 dp (about 1 m); GPS-captured stations and map-click endpoints
  stay at 4 dp. No persisted origin flag: `coordsOf` / `round4` take a dp parameter.
  Pros: fixes the complaint with verifiable numbers; 5 dp only on public places, so 0031's cap still guards the
  user's own location; no backup change.
  Cons: hand-verified addresses for seeds and aliases; a new Station key; the POI JSON grows.
- (b) 5 dp for every station.
  Pros: one rounding rule.
  Cons: breaks 0031's privacy cap on the user's own GPS.
- (c) Address and coords in backups.
  Pros: they survive an import.
  Cons: reopens 0033's no-coordinates rule.
- (d) A `geo:` URI link instead of a Google Maps URL.
  Pros: a native intent on Android.
  Cons: fails on iOS Safari.
- (e) "on <nearest named way>" from the walk graph when OSM has no address.
  Pros: always has a label.
  Cons: repeats Kev's no-number complaint and can name an alley (Linskey Way).

## Decision

Option (a).

- Display (station card, routes list, Landmarks tab): "<number> <street>", 5-dp coords, and an "Open in Maps" plain
  `<a href="https://www.google.com/maps/search/?api=1&query=<lat>,<lng>" rel="noopener noreferrer">`; no inline
  handlers (CSP-safe; Capacitor hands external links to the OS).
- Tapping it on a GPS-captured station sends that location to Google: a user-initiated exception to the "locations
  stay on the phone" stance of 0031/0033.
- Backup v2 unchanged: address and coords stay out (0033 holds). After an import, hide the address and Maps link
  when coords are absent.
- Candidates (0047) carry `address`; a candidate within about 15 m of an existing station is deduped (seeded
  stations have no `osm_id`).
- Re-measure the walk graph + POI JSON after adding addresses; if over 1 MB, drop the lowest-value fields first.

## Why this over the others

Only (a) gives exact numbers without widening what leaves the phone: (b) stores the user's own GPS at 1 m, (c)
puts coords in backups. (d) breaks on iOS. (e) is the problem Kev reported. Setting precision at the call site
avoids a persisted origin flag the backup allowlist would also have to drop.

## Consequences

- `static/route_store.test.mjs:229-252` changes: 4 dp for GPS captures, 5 dp for seeded stations.
- `static/demo_route.js` gains hand-verified addresses and 5-dp coords; the S2 alias table gains `address`.
- e2e asserts the Open in Maps `href` per station.
- Not decided: refreshing addresses after OSM edits (rebuild by hand, as 0046).
