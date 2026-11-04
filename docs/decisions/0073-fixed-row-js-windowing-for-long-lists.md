# 0073: Long lists use a client-side token filter plus fixed-row JS windowing (windowing pending)

Status: Accepted
Relates: MEM-124.
Date: 2026-11-04

The filter half is in force. The windowing half is pending: it lands with the `static/virtual_window.js` fix, and
that module is not on main yet. <!-- claim-exempt: planned -->

## Context

The "Your routes" list (`#routes-list`, `static/route_view.js` renderHome) renders every route card; with hundreds
of routes it is slow and unsearchable. Kev: "shouldnt there be also a typeahead search for which route in case we
have so many routes? and we can have the most recent ones in a scrollable view that uses virtualization".

## Options considered

Filter (accepted, on main as `static/list_filter.js`):

- (F1) Client-side in-memory token-AND filter over the already-loaded list (`static/list_filter.js`, chosen).
  Pros: no round trip (routes already load client-side from the local store); pure, unit-testable; generic
  `key`/`groupKey` accessors let the Landmarks gallery (item 73) reuse it with a multi-route OR filter.
  Cons: filters only what the client holds; linear scan per keystroke (debounced).
- (F2) Server/SQL search.
  Pros: scales past client memory.
  Cons: the backend is stateless and palace state lives client-side (ADR 0003), so there is nothing to query.

Windowing (PENDING, lands with the virtual_window fix; that module is not on main):

- (1) Fixed-row-height JS windowing (`static/virtual_window.js`, chosen). <!-- claim-exempt: planned -->
  Pros: DOM row count bounded (~viewport/rowHeight + 2*overscan, <= 30 for 1000 routes); O(1) math; unit-testable
  without layout; no dependency; CSP-safe via CSSOM padding.
  Cons: rows must share one height (cards must be fixed-height); Ctrl+F finds only rendered rows (mitigated by the
  typeahead filter); screen readers see only rendered rows (mitigated by `aria-setsize`/`aria-posinset`).
- (2) CSS `content-visibility: auto` + `contain-intrinsic-size`.
  Pros: zero JS; browser-native; all rows stay in the DOM, so find-in-page works.
  Cons: every card is still created (renderHome awaits a rehearsal lookup per card), so 1000 routes still means
  1000 nodes and lookups; uneven support in older Safari.
- (3) Pagination / "Show more" button.
  Pros: trivial.
  Cons: Kev asked for a scrollable virtualized view; extra taps on mobile.
- (4) Third-party virtual-list library.
  Pros: variable heights.
  Cons: a dependency in a no-build vendor-free static app; more than needed.
- (5) Variable-height windowing (measured rows).
  Pros: flexible cards.
  Cons: measurement and position caches, untestable in the fake DOM; YAGNI.

## Decision

Filter: (F1), accepted. Windowing: (1), pending; it takes effect when the virtual_window fix lands.

## Why this over the others

Filter: routes are already loaded client-side from the local store, so (F1) needs no round trip, and (F2) has no
server-side data to search.

Windowing (pending): (1) bounds the DOM with testable math and no dependency; (2) still builds every card and
lookup, (3) is not what Kev asked for, (4) adds a dependency to a vendor-free app, and (5) needs layout measurement
the fake DOM cannot test.

## Consequences

- `filterItems`/`sortRecentFirst` are available to any list; nothing mounts them yet.
- Windowing (pending, lands with the virtual_window fix): Phase B (MEM-124 PLANNED) must make route
  cards fixed-height and precompute learned counts so `renderRow` is synchronous.
