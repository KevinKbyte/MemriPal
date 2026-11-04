# 0061: Route view mounts one station card that follows the selected station

Status: Accepted
Amends: [0060](0060-demo-route-seeded-taps-and-profile.md) (its "no page renders station taps yet" consequence).
Date: 2026-11-04
Source: MEM-110 phase B (overnight brief 2026-11-04 item 6, h42 85); screenshots
`docs/overnight/shots/station-card-mount/`.

## Context

0060 seeds 4 taps and a profile on each Kendall demo station, but `static/station_card.js` (MEM-050) had no page
caller, so Load demo showed none of it. The card binds fixed ids (`#station-name`, `#tap-<group>`, ...) in the
`#station-card` section of `static/index.html`, and renders 5 tap groups of 4-6 buttons each (about 900 px tall at
375 px). The S5 list `#route-view-stations` must keep plain station titles as li text (MEM-077), and an opened route
starts with no li marked `aria-current` (MEM-088).

## Options considered

- (A) One card per station, inside each `#route-view-stations` li.
  Pros: every station's taps visible at once.
  Cons: the fixed ids allow one card only (would need a template/clone rewrite of station_card.js); 6 x ~900 px of
  buttons in the 375 px drawer; li text stops being the plain title (breaks the MEM-077 Load demo test).
- (B) A read-only tap line appended to each S5 li.
  Pros: compact, all stations at once.
  Cons: changes the li text MEM-077 pins; no editing, so station_card.js stays unmounted.
- (C) Mount the existing single `#station-card` from the route view; it opens on the first station and follows the
  station the user selects (S5 li click or map marker click); a new `#station-tap-summary` chip row lists only the
  groups that have a value (chosen).
  Pros: reuses the MEM-050 card and its markup as is; S5 li text and MEM-088 open state unchanged; one card fits the
  375 px drawer; no empty group for an untapped station.
  Cons: one station's taps at a time; the card sits below the station list, so on a phone it needs a scroll.

## Decision

(C). `route_view.js` creates the card once (`createStationCard`, `show(id, routeId)` now switches route), shows it on
open for station 1, and re-shows it on each selection; leaving the route view hides it. `station_card.js` renders
`#station-tap-summary` ("Sound: Traffic", ...) from the set taps in `TAP_GROUPS` order, hidden when none. A stored
name that only breaks the <= 3 word shape rule (the long seeded titles) is not flagged on arrival; a clash still is.

## Why this over the others

(A) needs a card rewrite and is too tall at 375 px (screenshots); (A) and (B) both change the S5 li text MEM-077
pins. (C) is the only option that mounts the existing card unchanged in shape and keeps both pinned behaviours.

## Consequences

- Each demo station shows its seeded taps once selected; the summary carries no empty group.
- Renaming or dropping a station from the card does not yet re-render the S5 list or map (follow-up).
