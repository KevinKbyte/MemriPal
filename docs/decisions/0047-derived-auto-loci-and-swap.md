# 0047: Auto-loci are derived on demand from the POI table; only acted-on candidates persist; swap moves, never drops

Status: Accepted
Relates: [0046](0046-offline-walking-graph-routing-and-geocode.md) (POI table), [0031](0031-route-station-store.md)
(store), [0033](0033-backup-v2-routes-no-coordinates.md) / [0043](0043-station-photo-optional-in-backups.md)
(backup), MEM-072 S3 (`.claude/spec-cache/memripal/references/spec-4.md`).
Date: 2026-11-03
Source: demo-flow eval (agent-workflow plan note memripal-2026-11-03-demo-flow-eval-h28), findings Db, Dc; Db wins
the Db-vs-Dc conflict. Kev, 2026-11-03: auto landmarks + swap is a must-have.

## Context

A routed walk ([0046](0046-offline-walking-graph-routing-and-geocode.md)) needs landmarks along it without a walk,
and the user must be able to swap a landmark for another nearby one. Constraints:

- Backup v2 is a strict allowlist: export builds routes from `ROUTE_KEYS` / `STATION_KEYS` only
  (`static/backup_routes.js:9-10`, `:146`) and import rejects any other key (`stationIn` `:173-177`, route `:227`).
  A new Route or Station field is invisible to backups or breaks import.
- `MAX_STATIONS = 8` (`static/route_store.js:28`, enforced `:215`, `:284`).
- `dropStation` deletes the station's photo (`static/route_store.js:276`, undo only via `lastDrop`).
- Real OSM along the Kendall demo route: 33 named POIs within 30 m (29 unique), 43 within 50 m (39 unique). The
  pmtiles POIs alone give 3-4, and the demo stations One Broadway, Watermark and Kendall Building are absent from the
  tiles.

## Options considered

Where candidates come from:

- (a) A pure function over the 0046 POI table and the route polyline, run on demand (chosen): POIs within 30-50 m,
  ordered by distance along the route, deduped by name and OSM id, ranked deterministically (tourism / artwork /
  station / landmark > shop / amenity > office) with even spacing along the walk. Spark only rewrites a chosen
  locus's one-line name; it never names candidates.
  Pros: deterministic, so fixture mode and tests see the same list; 0 model calls to list candidates; nothing new to
  store or back up.
  Cons: quality bounded by OSM names; ranking weights are hand-set.
- (b) Spark names the landmarks.
  Pros: richer descriptions.
  Cons: nondeterministic; breaks fixture mode; may name places that are not there.
- (c) Overpass at runtime.
  Pros: always current.
  Cons: the rate/outage/CSP problems 0046 rejected.

Where the unused pool lives:

- (a) Not stored: the pool is re-derived; only a candidate the user acted on persists, as KV `candidate:<osm_id>`
  (chosen).
  Pros: no Route or Station schema change, so backup v2 import and export stay as they are; nothing to migrate.
  Cons: acted-on candidates are not in backups.
- (b) Per-route `Route.alternates: Station[]` with `origin: "auto" | "walk"`; Landmarks tab a view over all routes
  (finding Dc).
  Pros: one record holds the route and its spares; swap is a move between two arrays.
  Cons: a Route schema change the backup allowlist drops on export; `deleteRoute` / `undoDelete` photo hold and drop
  (`static/route_store.js:182-200`) must be extended to alternates; stores data (a) can recompute.
- (c) A global landmark library across routes.
  Pros: reuse across routes.
  Cons: a new store and lifecycle for no demo need; candidates are route-relative by definition.
- (d) `Station.alternates` per station.
  Pros: spares sit next to the station they replace.
  Cons: a Station key, rejected by `stationIn`.

## Decision

Candidates (a), pool (a). Swap exchanges one station and one candidate in a single `putRoute`, never drops data
(the outgoing station keeps its `photo_ref` and persists as a candidate), does not call `dropStation`, and respects
`MAX_STATIONS`. The Landmarks tab is a derived view: the route's stations
plus its unused auto candidates.

## Why this over the others

Only (a) for candidates is deterministic and needs no runtime network; Spark naming breaks fixture mode, and Overpass
live was already rejected. For the pool, (a) is the only option that changes no persisted shape: (b) and (d) collide
with the backup allowlist and the photo hold/drop paths, and (c) adds a store with no consumer. Persisting only what the
user touched keeps the store minimal while the rest is recomputable.

## Consequences

- New pure module (candidate derivation) with golden tests on the Kendall route: counts, order, dedupe, spacing.
- Swap needs its own store method and test that the outgoing station's photo survives.
- `candidate:<osm_id>` KV entries are local-only; backups do not carry them.
- Not decided: tuning the 30 m vs 50 m radius per route density.
