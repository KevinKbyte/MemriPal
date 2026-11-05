# 0080: Pull a street photo for a photo-less landmark, ranked client-side by a pure module

Status: Accepted
Relates: MEM-137, MEM-136 (ADR 0079), MEM-053, ADR 0064 (street-photo backend), ADR 0012 (Mapillary terms).
Date: 2026-11-04

## Context

Landmarks without a user photo show only an emoji in the gallery and the MEM-136 dialog. Kev wants to pull the
best Mapillary picture instead of walking there, while user photos (the 6 demo-route landmarks in
`fixtures/demo/loci/`) stay best and untouched. `/baseline` (MEM-053) already searches up to 20 Mapillary images
within 30 m server-side, guards the token and CDN fetch, and returns one image with its CC BY-SA credit.

## Options considered

- (a) Rank candidates client-side in a new pure module `static/landmark_pull_photo.js` over `/baseline`
  candidates (chosen). <!-- claim-exempt: planned -->
  Pros: ranking is a pure function testable in the fake DOM; token custody, CDN guard and spend caps stay in
  the existing backend; fast to land for the demo.
  Cons: `/baseline` returns only the nearest image today, so it needs an additive candidates contract (below).
- (b) A new backend ranking endpoint that returns the best image.
  Pros: one round trip; the client stays thin.
  Cons: more server work and tests; slower to land; ranking tweaks need a server change.
- (c) Spark/LLM rerank of the candidates by looking at them.
  Pros: could judge what the photo actually shows.
  Cons: latency and per-pull cost; nondeterministic; possible later add-on over (a)'s shortlist.
- (d) Take the first/nearest Mapillary result (what `/baseline` returns now).
  Pros: zero new logic.
  Cons: ignores camera facing, so it often shows the wrong side of the street or the landmark's back.

## Decision

(a).

## Why this over the others

(a) keeps the scoring (distance, facing toward the landmark, recency/quality) deterministic and unit-testable
without growing the server's guarded fetch path. (b) costs more server work for the same scores. (c) adds latency,
cost and nondeterminism the demo does not need. (d) is the status quo whose wrong-side photos motivate this.

## Consequences

- Prerequisite: `/baseline` returns one nearest image (`src/memripal/baseline.py::_nearest`) and requests no
  `compass_angle` or capture time (`FIELDS`); (a) needs an additive candidates contract carrying those per
  candidate. Its shape is a backend task for `software-engineer`.
- Fallback only: the pull is offered only when a landmark has no user photo; it never overwrites or deletes one,
  and a later user photo supersedes it.
- The top candidate auto-sets; a picker offers the rest; Undo restores no photo.
- Photo src only `data:image/jpeg` (as `/baseline` returns); credit link only `https:`; the Mapillary CC BY-SA
  credit (`static/street_photo.js::renderCredit`) renders whenever a pulled photo does.
- (c) can later rerank (a)'s top few without changing this contract.
