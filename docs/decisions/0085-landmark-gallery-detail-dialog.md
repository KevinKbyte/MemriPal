# 0085: Landmarks-tab tile opens a native dialog built by a new pure module

Status: Accepted
Relates: MEM-143, MEM-127 (ADR 0083), MEM-120.
Date: 2026-11-04

## Context

Gallery tiles (ADR 0083) call `onOpen(item)`, which `mountLandmarkGallery` wires to a no-op. Kev asked to click
into a landmark for more details: location, multisensory profile, facts, and a way to its route.

## Options considered

- (a) Native `<dialog id="landmark-detail">` inside `#tab-landmarks`, built by a new pure module
  `static/landmark_gallery_detail.js` from the gallery item (chosen).
  Pros: the user stays in the gallery; works for candidates (no station card exists for them); native modal gives
  focus trap, Escape and backdrop for free; a pure builder is testable in the fake DOM; keeps `landmark_gallery.js`
  under the 500-line cap.
  Cons: a second landmark-detail view beside the route's station card; field rendering partly overlaps it.
- (b) Tile click jumps to the route's station card on the Routes tab.
  Pros: reuses existing UI; no new module.
  Cons: leaves the gallery and loses the filter context; nothing to open for a candidate; ambiguous for a landmark
  on several routes.
- (c) Merge in `landmark_detail.js` from unmerged branch `mem-landmark-detail` (its MEM-112).
  Pros: an existing detail dialog.
  Cons: unmerged and on an old base; built around live-map SVG hit targets, not gallery items; would pull its
  unreviewed map changes in with it.

## Decision

(a).

## Why this over the others

Only (a) covers both route landmarks and candidates without leaving the tab. (b) drops the gallery context and
has no target for candidates. (c) imports an unmerged branch whose data shape and entry point fit the map, not
the gallery; adapting it costs more than a small pure builder.

## Consequences

- "Open route" closes the dialog and calls `routeView.openRoute(routeId)`, one button per route.
- Facts come from `factsFor(station.id)` (max 3, with citation links), delivering MEM-120 phase B in this tab.
- Untrusted text goes through `textContent`; hrefs allow only `http:`/`https:`; photo srcs only `blob:`/`data:image`.
- If the map dialog from `mem-landmark-detail` lands later, shared field rendering can be extracted then.
