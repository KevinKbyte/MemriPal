# 0082: Landmark photo slots reuse POST /loci with a cached/sample fallback (MEM-141)

Status: Accepted
Date: 2026-11-04

## Context

The demo beat: the user uploads their own photo of the Kendall station landmark, SAM 3.1 segments it, and the
three Payoff parts (resolve the question, something useful, something memorable) are placed into regions of it.
POST `/loci` (MEM-015) already returns Spark phrases mapped to SAM 3.1 boxes and outlines. The submission deadline
is hours away; `static/sticker_drag.js` and the MEM-086 photo upload are still queued, not on main.

## Options considered

- New `/slots` endpoint returning exactly 3 regions.
  Pros: server picks the slots, one tested contract.
  Cons: new server surface, passcode/budget wiring and tests hours before the deadline; duplicates `/loci`.
- Client-only fixture (hard-coded regions on a bundled photo).
  Pros: zero risk.
  Cons: not real segmentation; the demo claim would be false.
- Reuse `/loci` and pick the 3 largest distinct-label loci in the client; fall back live -> cached last-good
  (localStorage `memripal.slots.<landmarkId>`) -> bundled sample fixture. Drag via dynamic
  `import("./sticker_drag.js").catch(() => null)`; tap-to-place always works.
  Pros: real SAM 3.1 output, no server change, works offline and before sticker_drag lands.
  Cons: slot choice is a client heuristic (largest area); a cached entry can be stale.
- Same as option 3 but copy the snap math or import sticker_drag.js statically.
  Pros: drag always available.
  Cons: copying duplicates code; a static import breaks the page until pal-sticker-drag merges.

## Decision

Option 3: reuse `/loci`, client picks the 3 largest distinct-label loci, live -> cached -> sample fallback, drag by
dynamic import. The fixture is generated from real `/loci` output by `scripts/gen_landmark_slots_fixture.py`, not
hand-written.

## Why this over the others

It is the only option that shows real segmentation of the user's photo without new server surface; the source
badge keeps the fallback honest. Option 1 costs server work and tests hours before the deadline, option 2 fakes
the segmentation claim, option 4 duplicates code or breaks the page before sticker_drag merges.

## Consequences

- Slot choice is a client-side heuristic over `/loci` results (largest area, distinct labels), not a server contract.
- A cached result may be stale; it is shown with a "Cached SAM 3.1" badge.
- The committed fixture `static/fixtures/landmark_slots_kendall.json` is generated from `fixtures/demo/photo.jpg`;
  it must be regenerated from Kev's real Kendall photo via `scripts/gen_landmark_slots_fixture.py`.
