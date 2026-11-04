# 0060: Demo route seeds photo-derived taps and profile, no photos

Status: Accepted
Amends: [0042](0042-kendall-demo-route-seeding.md) (seeded stations carried no sensory data).
Date: 2026-11-03
Source: MEM-110 (`.claude/spec-cache/memripal/references/spec-5.md`).

## Context

The 6 Kendall demo stations seeded by Load demo (0042) had no `taps` or `profile`. Kev walked the route and took 6
photos, one per `DEMO_ROUTE` station in walk order: "I took pictures of the route, can you add multisensory info for
them too".

- Tap values are limited to the `static/station_card.js` `TAP_GROUPS` labels; profile lines are <= 200 printable-ASCII
  chars.
- `static/route_view.js` renders `taps.turn` as " then <turn>" after each station in the S5 station list, and the
  MEM-077 Load demo test requires plain station titles there.

## Options considered

- (A) Hand-author `taps` `{ sound, smell, feel, mood }` and `profile` `{ visual, spatial, conceptual }` into the frozen
  `static/demo_route.js` seed; `seedRoute` (`static/route_store.js`) copies them per station (chosen).
  Pros: Load demo shows the data with no extra step; stays inside 0042's frozen-module home; no photo bytes or privacy
  exposure in the repo.
  Cons: sensory data is code; editing it means a code change.
- (B) Ship an importable backup file carrying the data.
  Pros: demo data stays out of `static/`; reuses the import path.
  Cons: an extra import step, and Load demo still seeds empty stations.
- (C) Commit the photos and attach them to stations.
  Pros: the source images travel with the route.
  Cons: 1-6 MB each; strangers in shot (privacy); the station card renders no photo anyway.

Sub-decision, `turn`:

- Seed `taps.turn`.
  Pros: complete tap set.
  Cons: `route_view.js` appends " then <turn>" to S5 list titles, breaking the MEM-077 plain-title test.
- Omit `taps.turn`; describe the walk's turns in `profile.spatial` (chosen).
  Pros: S5 list and MEM-077 unchanged; turn information still recorded.
  Cons: the `turn` tap group stays empty on demo stations.

## Decision

(A), without `turn`: each `DEMO_ROUTE` station carries 4 tap keys and 3 profile keys, hand-authored from the photos;
`seedRoute` stores copies of both.

## Why this over the others

(A) is the only option where Load demo itself shows the data. (B) leaves the seed empty behind an import step; (C)
puts multi-MB images of strangers in the repo for a card that does not show photos. Seeding `turn` would change the
S5 list text MEM-077 pins.

## Consequences

- Photos stay local and uncommitted. Photo 6 is a nearby stand-in for the Meta office, where security barred photos.
- No page renders station taps yet (`station_card.js` has no caller); visible taps await the phase B mount after
  MEM-088.
