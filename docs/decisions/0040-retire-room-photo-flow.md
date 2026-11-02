# 0040: Retire the room-photo flow in two steps; delete /loci at B10 with no 410

Status: Accepted
Date: 2026-11-02
Source: MEM-073 (`.claude/spec-cache/memripal/references/spec-4.md`); plan B10
(`docs/plans/2026-10-31-map-to-palace.md`). Retires the flow behind [0011](0011-s2-loci-request-shape.md) and
[0016](0016-load-demo-bypasses-reencode.md) at B10; follows the pivot in [0038](0038-route-first-flow.md).

## Context

The route-first pivot dropped room segmentation (one photo -> `POST /loci` -> up to 12 room objects) because objects
move (`docs/plans/2026-10-31-map-to-palace-ledgers.md`). The page still offers it: `static/app.js` `onPhotoChange`,
wired to `#photo` `change`, re-encodes the picked photo and posts it to `/loci`; the first screen reads "Start: a
room photo or the demo" and "Take or choose a photo of a room". Kev (2026-11-02): "Yes, retire it".

Constraints found at 72b4fe4:
- Load demo is the only working path in the served app: `Dockerfile` sets `MEMRIPAL_MODE=fixture`; `app.py` mounts no
  `routes_station` router, so `POST /station` 404s; `#routes-new`, `createCaptureSession` and `createStationCard`
  have no non-test caller. A route can only be created through `#backup-import` (backup v2, ADR 0033).
- The Load demo chain (`flow.js` -> `runDemoPalace` -> `demoUpload` -> `postLoci`) needs `/loci`, then `/split`,
  `runEncode` and recall.
- Plan A5 keeps every live id exactly once and re-homes `#photo`, `#meta-notice` and `#upload-status` to S2 capture
  (`static/index_markup.test.mjs`). Elements stay; only handlers go.
- The B10 demo route (6 recorded `/station` responses from the Kev-run K1 capture) does not exist yet.

## Options considered

Four Opus adversaries attacked A, B, C and the framing.

- (A) Full retirement now: remove Load demo's room chain, the `/loci` route and its tests in this change.
  Pros: one change; no legacy endpoint or room fixtures left behind.
  Cons: the deployed app loses its only working path with no replacement until B10; the ~16 load-demo test files are
  deleted now and rewritten at B10.
- (B) Demo route now: repoint Load demo at a stand-in route seeded through backup v2 (3 named stations, each
  `fixtures/demo/photo.jpg`; seeding via `importBackup` is idempotent, `{added:1}` then `{present:1}`).
  Pros: `/loci` goes now; the demo shows the route-first flow early.
  Cons: the stand-in is thrown away when B10's recorded stations land, so Load demo and its tests are ported twice;
  `/split`, `/associate`, `/scenes` replays are keyed on the room demo, so a stand-in route needs new replays; imported
  routes may render only after a reload (backup import calls `renderHistory`, not `routeView.renderHome`; unverified).
- (C) A plus removing unreachable modules: also delete `routes_station.py`, `route_capture.js`, `station_card.js`
  and their markup.
  Pros: no dead code at all.
  Cons: those modules are route-first pieces waiting to be wired (B3/B5/B7), not legacy; deleting them reverses landed
  work and breaks plan A5's id contract.
- (D) Two-step (chosen). NOW: remove the room-photo upload behaviour (`onPhotoChange` and its `#photo` listener; the
  `#photo` element stays, unhandled, per A5); first-screen copy names no room photo; `scripts/screenshot_ui.py` adds a
  route-view shot by importing a committed backup-v2 fixture (`fixtures/demo/route_backup.json`) through
  `#backup-import`. LATER (B10): Load demo -> demo route; delete the `/loci` route with no 410.
  Pros: users can no longer start the dropped flow; Load demo keeps working until its replacement exists; load-demo
  tests are ported once; the UI screenshot covers the route view from now on.
  Cons: `/loci`, `demoUpload`, `postLoci` and the room demo fixtures live on until B10; `#photo` is an inert input
  until S2 capture re-homes it; two changes instead of one.

At B10, deleting `/loci` outright beat a 410 Gone stub: the page is its only client (no external clients, plan A7),
so a stub would be code with no reader.

## Decision

Option D, under MEM-073 now and B10 later. B10 carries: Load demo -> demo route; delete the `/loci` route,
`tests/test_loci_api.py` and the `/loci` POST in `tests/test_demo_assoc_fixtures.py` (call `find_loci` directly);
drop `/loci` from `src/memripal/ratelimit.py` and `static/flow.js` `PASSCODE_ROUTES`; port the load-demo test files
once; drop the `load_demo.png` shot.

## Why this over the others

All four adversaries converged: Load demo cannot go before B10, because it is the only working path in the served
app and its chain needs `/loci`. A ships a deployed app with no working demo; B builds a stand-in route that B10
throws away, porting Load demo and its tests twice; C deletes live route-first work, not legacy. D removes everything
a user can reach of the room flow now and leaves only what Load demo still needs, which B10 replaces in one pass.

## Consequences

- The user-photo place lookup (GPS from the picked photo, else geolocation) goes with `onPhotoChange`; Load demo's
  sidecar lookup (`lookupDemoPlace`) stays.
- Tests that drive `onPhotoChange` move to `onLoadDemo` or are removed; the repo rule
  `.claude/rules/client-transform-tests-drive-browser-path.md` names `onLoadDemo`.
- Until B10, `scripts/screenshot_ui.py` writes both `load_demo.png` (room demo) and `route_view.png` (backup fixture).
- B10 lands the `/loci` deletion list above as one slice; until then a `/loci` change must keep Load demo green.
