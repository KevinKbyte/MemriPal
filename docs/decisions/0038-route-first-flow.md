# 0038: Route-first flow: linear set-route spine, capture anytime as an unfiled candidate

Status: Accepted
Date: 2026-10-31
Source: MEM-072 (`.claude/spec-cache/memripal/references/spec-4.md`); amends the capture-first screens in
`docs/design/route/` (S1 "New walk", S2 "Walking: capture") at 975c2a3.

## Context

The design was capture-first: the user walks, photographs landmarks, and the route is built from the photos. Kev's
requirement (2026-10-31) reverses this: the user sets the route first, the app generates landmark loci with
alternatives the user can swap or add (fine-grained), the route stabilises, and own landmark photos supplement it at
any time, either as a hint for Meta-model generation or as a stop the user adds. The design must still pass the
MEM-067/MEM-070 gates: 9 fixed screen states (`1 2 3 4 "5,6" 7 8 9`), ids only from `ALLOWED_IDS`, class-only new
styling, no transform, no overflow at 375 px, axe-clean. Stops stay 3-8 (ADR 0031).

## Options considered

Three adversarial agents (defend A, defend B, framing adversary) evaluated at 975c2a3.

- (A) Linear wizard (chosen as the spine). S1 "New route"; S2 set route; S3 pick landmarks (map + locus cards with an
  alternatives row: "Use this" swaps, "Add too" inserts, per-locus "Add all"); S4 fix the route; S5-S9 as before.
  Pros: follows the owner's order; fits the 9 fixed states; needs zero new ids (every id it uses is already allowed);
  `#finish-save` already enforces 3-8.
  Cons: more steps; as drafted, a required "hint or stop?" choice at capture time (extra taps in the street, and a
  pre-route capture cannot be a stop); typed start/end implies geocoding, a new egress path.
- (B) Map-first single canvas: pins for loci, bottom sheet per pin, floating capture.
  Pros: the map is the route; reuses `#route-map` station nodes; one-tap capture.
  Cons: one canvas must still be cut into 9 static states; sliding sheets need transform (banned); 20 px pins fail
  axe target size; a fixed overlay sheet competes with the stacked preview.
- (C) Keep capture-first, add generation afterwards.
  Pros: no screen rework; the capture flow already passes the gates.
  Cons: contradicts the requirement (the route comes first); the framing adversary rejected it; generation would have
  nothing to seed it until the user has walked.

## Decision

Hybrid: A's linear S1-S4 spine, with three rules taken from B and the framing adversary.

1. Capture is never a fork. Every capture is an unfiled candidate. Before Find landmarks it is a generation hint;
   after, it appears as a "Your photo" alternative on the nearest locus, promoted with the same "Use this" / "Add
   too" controls. A capture opened from a locus card lands on that locus. Capture is reachable from every screen
   via a class-styled topbar button (`.topbar-capture`).
2. No new egress. Start and end are picked on the map or from familiar places (stations of past routes, on the
   phone); no typed geocoding. Only landmark positions leave the phone, and only with the place setting on.
3. 3-8 holds on every add path. A counter chip shows `n/8`; "Add all" adds only into free slots and says how many
   ("Add 2 (room for 2)"), leftovers stay as alternatives with a notice, and it is disabled at 8 with the reason.
   While a list is memorised on the route, insert, drop and reorder are blocked ("Retire the list first", via the
   existing `#list-retire` flow); a 1:1 swap keeps the station id and warns that its items need re-learning.

## Why this over the others

A alone fits every gate with no new ids, which B cannot (transform ban, target size, single canvas vs 9 states).
B's real strengths (no capture fork, map-picked endpoints, room-aware add-all) are flow rules, not layout, so they
transplant onto A's spine at no gate cost. The framing adversary showed the capture-time fork and typed endpoints
were the actual defects; the hybrid removes both.

## Consequences

- The landmark source is still unchosen (route-contract.md 0.2, ADR pending); S2's map-source chips stay a
  placeholder until that ADR lands.
- `static/encode.js` keys associations by locus label and pairs by position; the swap rule needs station-id keys.
  Code follow-up, not part of this design change.
- Typed place search, if ever wanted, needs its own privacy decision (off by default, like `#place-toggle`).
