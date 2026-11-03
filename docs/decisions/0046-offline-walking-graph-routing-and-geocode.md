# 0046: Route search runs offline: a build-time OSM walking graph and POI table, in-process A*, local geocode with aliases

Status: Accepted
Relates: [0041](0041-real-map-whole-file-pmtiles.md) (real map), [0042](0042-kendall-demo-route-seeding.md) (demo
route), MEM-072 S2 (`.claude/spec-cache/memripal/references/spec-4.md`).
Date: 2026-11-03
Source: demo-flow eval (agent-workflow plan note memripal-2026-11-03-demo-flow-eval-h28), findings Da, R2.
Kev, 2026-11-03: must-have; endpoint confirmed as Meta office, 100 Binney St, 42.36554,-71.0809.

## Context

The demo route must come from a typed start and end ("Kendall/MIT T" -> "Meta office"), not a hand-walked station
list. Nothing in the app routes or geocodes today: no haversine or polyline helper exists anywhere. Constraints:

- CSP is `default-src 'self'` with no `connect-src` (`src/memripal/security_headers.py::SECURITY_HEADERS`), so any
  external router or geocoder must be backend-proxied or the CSP widened.
- The public URL runs fixture mode; the demo must not depend on a third-party service being up during judging.
- The real map's pmtiles extract has 1068 named POIs but no routing graph; it has no "Meta" or "100 Binney" POI.
- A computed route must land in the store without a schema change.

Measured on real OSM for the Kendall bbox: 8301 ways, 29153 nodes, 35 connected components (largest 28471).

## Options considered

- (a) One Overpass bbox query at BUILD time, committed as a compact walking-graph + named-POI JSON (990 KB, 269 KB
  gz); A* with a haversine heuristic in-process (client JS is fine) (chosen).
  Pros: Kendall T -> 100 Binney computed in 0.055 s, 674 m via Main -> Third -> Binney (DEMO_ROUTE polyline 607 m);
  no runtime network, so no CSP change and no judging-day outage; one query, so no Geofabrik/osmium/osmnx toolchain.
  Cons: graph is frozen at build time; public Overpass 502'd once, so the build step must retry; adds ~1 MB to the
  repo.
- (b) Route over the pmtiles `roads` layer already shipped.
  Pros: no new data file.
  Cons: not routable. Raw decode gives NO PATH across 4328 components; after noding, 549 components and a 1119 m route
  with spurs.
- (c) Google Routes / Places / Geocoding.
  Pros: best geocode quality.
  Cons: Maps Service Terms 3.3/5.3/11.3 bar use with a non-Google map (archived terms, 2024-05-22); key custody and
  spend; runtime dependency.
- (d) Public OSRM demo, Nominatim or Overpass at runtime.
  Pros: no build step.
  Cons: 1 req/s, non-commercial or no SLA, no autocomplete, often overloaded; needs a backend proxy under the CSP.
- (e) Stadia free tier.
  Pros: hosted routing and geocoding with no build step.
  Cons: non-commercial, proxying forbidden.
- (f) OpenRouteService live.
  Pros: real routing API.
  Cons: 2000 directions/day, third-party, no SLA.
- (g) Geofabrik extract clipped with osmium or osmnx at build time.
  Pros: same offline result as (a).
  Cons: a heavier toolchain for the same bbox one Overpass query already covers.

Geocode:

- (a) Normalized fuzzy match over POI and street names, plus an alias table, plus map-click as the fallback
  (chosen). Mandatory alias: "meta office" -> 42.36554,-71.0809, because the OSM node "Meta" sits at 1 Broadway
  (42.36263,-71.08366), 209 m from the T. Also "Kendall/MIT T" -> the railway station node.
  Pros: deterministic, offline, every demo phrase covered by an alias; a miss shows a suggestion dropdown over the
  local index, then map-click.
  Cons: alias table is hand-kept; arbitrary addresses outside the POI/street index miss.
- (b) Any live geocoder from the list above.
  Pros: covers arbitrary addresses.
  Cons: the same ToS, rate and outage problems as the routing options.

## Decision

Routing (a), geocode (a). Endpoints snap to the largest connected component. When A* finds no path, the app draws a
straight polyline between the endpoints with the nearby POIs and labels it honestly as unrouted. The result maps into
`seedRoute` (`static/route_store.js:339-357`): no Route or Station schema change. Attribution "(c) OpenStreetMap
contributors" is already in `static/map/style-light.json:9` (ODbL).

## Why this over the others

Only (a) and (g) give a routable graph with no runtime dependency, and (a) does it with one query instead of a
toolchain. (b) is measurably not routable. (c) is barred by ToS with our MapLibre map. (d)-(f) are rate-limited,
non-commercial or SLA-free services the demo would depend on live. The alias table is the only way to land on 100
Binney: OSM's own "Meta" node is the wrong building.

## Consequences

- New build script (with retry) writes the committed graph + POI JSON; the POI table feeds auto-loci
  ([0047](0047-derived-auto-loci-and-swap.md)).
- Golden test: A* Kendall T -> Meta office stays within ~40 m of the `DEMO_ROUTE` polyline (`static/demo_route.js`).
- Snap-to-largest-component and the labelled straight-line fallback each need a test.
- Not decided: refreshing the graph after OSM edits (rebuild by hand).
