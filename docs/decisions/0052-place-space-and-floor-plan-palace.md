# 0052: Floor-plan palace: Route.space "geo" | "plan" in the same store, stations at normalized plan_xy on an SVG overlay

Status: Deferred (cut for the Nov 4 deadline)
Relates: [0031](0031-route-station-store.md) (store), [0033](0033-backup-v2-routes-no-coordinates.md) (backup),
[0044](0044-route-review-drag-and-edit-trash.md) (pointer drag), [0041](0041-real-map-whole-file-pmtiles.md)
(real map).
Date: 2026-11-03
Source: demo-flow eval (agent-workflow plan note memripal-2026-11-03-demo-flow-eval-h28), findings Dj, Di. Kev,
2026-11-03: floor plan cut from the demo; this ADR is kept complete so a later build can pick it up.

## Context

An indoor palace (home, office) has no lat/lon: the user photographs a floor plan with numbered spots and walks the
plan instead of a street route. Constraints:

- `Route.kind` already means cadence: `"daily" | "occasional"` (`static/route_store.js:30`), and `kindOf` throws on
  anything else (`:48-51`).
- Backups are field allowlists: export copies only `ROUTE_KEYS` / `STATION_KEYS` (`static/backup_routes.js:9-10`,
  `:146`), import rejects other keys (`:227`, `stationIn` `:173-177`).
- The model JSON schema checker supports only `type`, `properties`, `required`, `additionalProperties`, `items`
  (`src/memripal/backend.py::_SCHEMA_KEYWORDS`): no `minimum`, `maximum` or `enum`.
- Spark vision with strict `json_schema` is available (`src/memripal/meta_client.py::MetaClient.chat_json`).

## Options considered

Where a plan palace lives:

- (a) The same route store with `Route.space: "geo" | "plan"` (absent = geo), `Route.plan_ref` (the plan image) and
  `Station.plan_xy` (chosen).
  Pros: walk, recall, memorize and backup paths work unchanged on a plan route; absent = geo, so every existing route
  stays valid.
  Cons: new keys the backup allowlists must learn; geo-only code must check `space`.
- (b) Overload `Route.kind` with `"plan"`.
  Pros: no new field.
  Cons: `kind` is cadence; `kindOf` throws, and a plan route also needs a cadence.
- (c) A separate plan store.
  Pros: isolated.
  Cons: duplicates the store, walk and recall wiring for one difference: where a station sits.

Plan rendering:

- (a) `<img>` of the plan + an SVG `viewBox="0 0 1 1"` overlay, `plan_xy` normalized 0..1, pointer-drag to move a
  station as in `static/route_review.js` ([0044](0044-route-review-drag-and-edit-trash.md)), SVG built as in
  `static/route_map.js` (chosen).
  Pros: resolution-independent coords; reuses existing SVG and drag code; CSP-safe.
  Cons: no zoom or pan beyond what the browser gives.
- (b) Load the plan as a MapLibre raster source.
  Pros: zoom and pan for free.
  Cons: needs fake geo bounds for a non-geo image; ties plan routes to the map stack.

Reading the numbered spots:

- (a) Spark vision with schema `{numbers: [{n: integer, x: number, y: number, legible: boolean}]}`, range and
  consistency checks in Python; low confidence by code (missing or duplicate `n`, out of range, `legible=false`) goes
  to an "unplaced" tray; fallback = the user taps the numbers in order (chosen).
  Pros: deterministic acceptance despite the schema checker's limits; nothing silently misplaced; a no-model path.
  Cons: one new prompt (new digest, new fixtures).
- (b) Manual placement only.
  Pros: no prompt.
  Cons: slow for a plan with many spots; drops the Meta AI beat.

## Decision

Store (a), rendering (a), reading (a). Deferred: not built for the Nov 4 deadline.

## Why this over the others

Store: (b) breaks `kindOf` and conflates cadence with space; (c) duplicates every flow; (a) changes only where a
station sits. Rendering: a normalized SVG overlay reuses code the app has, while MapLibre needs fake geography.
Reading: the schema checker cannot range-check, so Python must; the unplaced tray and tap-in-order fallback mean a bad
read never places a station wrongly.

## Consequences

- `ROUTE_KEYS` gains `space` and `plan_ref`, `STATION_KEYS` gains `plan_xy`, each accepted absent on import; the
  plan image follows the backup photo rules.
- Geo-only code paths (real map overlay, routing, auto-loci) skip `space: "plan"` routes.
- A new vision prompt: record fixtures before any deploy.
