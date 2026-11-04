# 0070: Uncrossed route numbering: reading-order seed, 2-opt, y-monotone fallback

Status: Accepted
Relates: MEM-013 (`route_order` reading order, the seed), MEM-113 (spec),
[0051](0051-static-part-sub-loci.md) (sub-loci; manual numbering has no backend surface yet).
Date: 2026-11-04

## Context

The numbers on segmented landmarks read as a route: 1 -> 2 -> ... -> n. `src/memripal/loci.py::route_order`
numbers loci in MEM-013 row-aware reading order, and the jump from the end of one row to the start of the next can
cut across the walk already drawn. Kev (2026-11-04): "numbering on the segmented landmarks would show a route and we
should have the auto numbering from segmentation to follow the strict rule of no crossing own path to make it easier
to remember - unless if the user explicitly wants to  have a certain numbering they can overwrite it themselves".

"No crossing" here means no two non-adjacent legs of the centroid path meet: a proper crossing, a T-touch, or a
collinear overlap. Two loci at one centroid (a coincident duplicate endpoint) do not count.

## Options considered

- (A) Keep MEM-013 reading order.
  Pros: no change; rows read like text.
  Cons: row-to-row jumps can cross the path, which is the bug Kev reported.
- (B) Snake (boustrophedon) rows: alternate left-to-right and right-to-left per row.
  Pros: simple; removes the long row-return diagonals.
  Cons: jittered or uneven rows can still cross or touch; no guarantee; changes numbering even where reading order
  was already clean.
- (C) Nearest-neighbour tour, then 2-opt.
  Pros: short walks; standard heuristic.
  Cons: discards reading order entirely, so numbering looks arbitrary; the start point is a free choice; 2-opt alone
  can stall on a degenerate (collinear or touching) meeting that no reversal shortens.
- (D) Reading-order seed, 2-opt over meeting legs, y-monotone fallback (chosen).
  Pros: leaves MEM-013 order untouched whenever it is already clean; each reversal strictly shortens the walk, so it
  terminates; the fallback guarantees no self-meeting; meeting tests use exact integer geometry on doubled centroids;
  under 1 s on 4000 random layouts.
  Cons: two code paths (2-opt and fallback); a fallback layout loses row-aware order.
- (E) Pure y-monotone sort by (cy, cx).
  Pros: always valid; one line.
  Cons: discards row-aware order everywhere, and side-by-side loci at slightly different heights zigzag in long
  left-right swings.

## Decision

(D), applied as the final step of `route_order`, before numbering:

- Seed: the MEM-013 reading order.
- 2-opt: while some pair of non-adjacent legs meets, reverse the stretch between them, but only on a strict decrease
  in total walk length.
- Fallback: if a meeting remains that no reversal shortens, sort by (cy, cx); a y-monotone walk never meets itself.
- Geometry: doubled centroids (`x1 + x2`, `y1 + y2`) keep orientation and on-segment tests in exact integers.

`static/auto_loci.js` (along-route distance ordering, MEM-085) is unchanged.

## Why this over the others

(D) is the only option that both guarantees Kev's strict no-self-crossing rule and keeps the familiar MEM-013 order
when that order is already clean. (A) is the bug. (B) and (C) carry no guarantee; (C) also throws away reading order.
(E) has the guarantee but pays for it on every layout; (D) uses it only as the last resort.

## Consequences

- Locus numbers change only for layouts whose reading order met itself; each locus is still numbered exactly once,
  1..n, deterministically.
- Future work: a user-set manual order overrides the auto numbering (Kev's "overwrite it themselves"). Not built: no
  backend surface for manual numbering or sub-loci ([0051](0051-static-part-sub-loci.md)) exists yet.
