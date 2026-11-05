# 0083: Landmarks tab is a photo-tile gallery beside the hidden list, with a datalist route typeahead

Status: Accepted
Relates: MEM-127, MEM-124 (ADR 0073).
Date: 2026-11-04

## Context

The Landmarks tab was a plain `ol#landmarks-list`. Kev asked for a Google-Photos-like gallery labeled by landmark
name, with typeahead search and filter criteria such as routes, and candidates for route XYZ, with multiple routes
selectable in the typeahead.

## Options considered

Four sub-choices, each with the options weighed.

### 1. Where the gallery lives

- (1a) Keep `ol#landmarks-list` in the page, `hidden`, and add the gallery (`ul#landmarks-grid` and its controls)
  beside it (chosen).
  Pros: existing consumers and tests that look up `#landmarks-list` keep working; no migration of the old markup;
  the gallery is additive and revertable.
  Cons: one dead hidden node in the HTML.
- (1b) Replace `ol#landmarks-list` with the gallery.
  Pros: no dead markup.
  Cons: breaks any lookup of the old id; a bigger, riskier diff for no user-visible gain.

### 2. Route typeahead control

- (2a) Native `<input list>` + `<datalist id="landmarks-route-options">` (chosen).
  Pros: zero JS for suggestion UI; platform-native on mobile; accessible by default; no CSS or listbox ARIA to
  maintain.
  Cons: suggestion styling is browser-controlled; no `input` event reports which option was clicked, so the code
  treats an exact (normalized) route name as a pick, and a half-typed name picks nothing.
- (2b) Custom listbox (`role="listbox"` plus keyboard handling).
  Pros: full styling and a real select event.
  Cons: more code and ARIA to get right and test in the fake DOM; YAGNI for a name list.

Multi-select is chips (`button.lg-chip`, click removes) beside the input; a picked route leaves the datalist.

### 3. Tile filtering

- (3a) Reuse `filterItems`/`normalize` from `static/list_filter.js` (ADR 0073) through `filterGallery` (chosen).
  Name tokens are AND-matched; the `anyOf` + `groupKey` options give the multi-route OR.
  Pros: one filter, one normalization (case, accents) across routes and landmarks; ADR 0073 already anticipated
  this reuse; no new matching bugs.
  Cons: the gallery depends on a sibling module's option shape.
- (3b) Local filter in the gallery module.
  Pros: no coupling.
  Cons: duplicates matching and normalization; the two lists would drift.

### 4. Where the flow wiring lives

- (4a) `mountLandmarkGallery(doc, routes, fetchFn)` exported from `static/landmark_gallery.js`; `flow.js` gets one
  import and one call (chosen).
  Pros: keeps `flow.js` under the 500-line file-structure cap; POI fetch, photo object-URL cache, and tab-open
  refresh stay with the code they serve; testable with injected `doc`/`fetchFn`.
  Cons: the gallery module owns some page-level wiring (tab click and `hashchange` listeners).
- (4b) Wire inside `flow.js`.
  Pros: all page wiring in one file.
  Cons: `flow.js` would exceed the 500-line cap.

## Decision

(1a), (2a), (3a), (4a).

## Why this over the others

The gallery is additive, so (1a) leaves the old list contract untouched. (2a) gives the native, accessible
typeahead at no code cost, and chips cover multi-select, which a datalist cannot. (3a) reuses the filter ADR 0073
built generically for exactly this, so name matching is identical everywhere. (4a) is the only option that keeps
`flow.js` within the cap.

## Consequences

- Multiple selected routes combine as a union (an item on any selected route shows).
- Stations are dropped from the POI pool before `candidates()` runs, so an excluded POI never takes one of its 40 m
  spacing slots from a real candidate.
- A typed route name is matched with `normalize` over the not-yet-selected routes only.
- A candidate tile lists every route it is a candidate for (merged by key across routes).
- Candidate items carry `station: null` plus the `poi` candidate.
- Photos are wrapped as `Blob` type `image/jpeg` for object URLs, cached per ref for the page's life.
- `onOpen` is a no-op: `landmark_detail.js` is not on this branch; a tile click does nothing until it lands.
- The Candidates view with no route selected shows "Pick a route to see its candidates." and fetches no POIs.
