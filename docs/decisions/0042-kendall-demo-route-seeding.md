# 0042: Kendall demo route lives in a frozen code module, seeded by Load demo via route_store.seedRoute

Status: Accepted
Amended by [0053](0053-station-street-address-and-poi-precision.md): seeded coords are stored at 5 dp, not 4, and
the 6 seeded stations carry hand-verified street addresses.
Date: 2026-11-02
Source: MEM-077 (`.claude/spec-cache/memripal/references/spec-4.md`); plan `docs/plans/2026-11-02-real-map.md` slice S6;
commits 4269149, b772120.

## Context

The real map ([0041](0041-real-map-whole-file-pmtiles.md)) renders only `geo` routes whose stations carry coords inside
the Kendall bbox. The demo needs one such route on screen without a walk: the Kendall/MIT -> Meta (100 Binney St) walk
the map was designed around (`docs/design/map/preview.js` STATIONS). Constraints found:

- Backups never carry coordinates ([0033](0033-backup-v2-routes-no-coordinates.md)); `static/backup_routes.js`
  `stationIn` rejects any station key outside `STATION_KEYS` (`id`, `n`, `name`, `status`, `box`, `profile`, `taps`,
  `photo`) and requires a JPEG `photo`.
- `route_store.restoreRoute` builds stations from those fields only, so it drops coords by design.
- `#load-demo` still runs the room demo ([0040](0040-retire-room-photo-flow.md) keeps it until B10), and the load-demo
  tests pin that chain.

## Options considered

Demo route home:

- (a) `static/demo_route.js`, a frozen `DEMO_ROUTE` module (chosen). Fixed ids, six stations with `{ lat, lon }`.
  Pros: coords live outside the backup format, so 0033 holds; breaks 0 tests; imported like any module, so no fetch, no
  new URL and no CSP change; type-checked against `route_store.js` `Station`/`Coords`.
  Cons: demo data in code; editing it means a code change.
- (b) Extend `fixtures/demo/route_backup.json` (the backup-v2 fixture).
  Pros: one demo-data file; reuses the import path.
  Cons: a `coords` key fails `exactKeys(st, STATION_KEYS)`; allowing it reverses 0033's no-coordinates rule for every
  backup; needs a JPEG per station.
- (c) A new route file under `fixtures/demo/`.
  Pros: data stays out of `static/`.
  Cons: a runtime fetch from a path outside the served app, or a new served path plus CSP/same-origin review; a new
  parser and validator for a format with one consumer.

Loader:

- (a) Existing `#load-demo` click also seeds the route, then `routeView.renderHome()` (chosen).
  Pros: no new UI surface; the room demo still runs and its tests stay green; a failed seed is swallowed, never blocking
  the room demo.
  Cons: one button does two things until B10 retires the room chain.
- (b) A new dedicated "Load demo route" button.
  Pros: each demo independent and separately testable.
  Cons: new UI, copy, design-gate and screenshot work for a stand-in B10 replaces; two demo entry points to explain.

Store write:

- (a) New `route_store.seedRoute` (chosen): keeps coords via `coordsOf` (rounded to 4 dp), stations `status: "named"`,
  route `status: "saved"`, a fresh `photo_ref` per station with nothing stored under it, `lists: []`; returns null and
  writes nothing if the route id already exists.
  Pros: coords survive, so the route renders on the real map; idempotent, so repeat clicks keep one route; same
  persist-then-cache order as `restoreRoute`, so a failed write leaves nothing for a retry to skip.
  Cons: a second write path beside `restoreRoute`.
- (b) Reuse `restoreRoute`.
  Pros: no new store method.
  Cons: drops coords by design (0033), so the demo would render as sketch only; expects a decoded photo per station.

## Decision

Home (a), loader (a), store write (a): `flow.js` calls `deps.routes?.seedRoute(DEMO_ROUTE)` on the `#load-demo` click,
then `renderHome()`; rejection is ignored.

## Why this over the others

Home: (b) and (c) both need coords in a backup-shaped or new file format, against 0033 or with a new fetch path; the
module keeps 0033 intact, breaks 0 tests and needs no fetch or CSP change. Loader: reusing `#load-demo` adds no UI for
a stand-in and leaves the room demo and its tests untouched; a second button is design-gate work B10 throws away.
Store: `restoreRoute` is the backup import path and must keep dropping coords; only a separate seed keeps them.

## Consequences

- `scripts/screenshot_ui.py` adds `demo_route_light.png` and `demo_route_dark.png` at 375 px after the real map's
  first idle; `DEMO_ROUTE.name` must match its `Open <name>` button lookup.
- Seeded stations have no photos: each `photo_ref` points at nothing stored.
- Not decided: how B10 (0040, MEM-055) loads its recorded demo route; the room chain and this seed coexist until then.
