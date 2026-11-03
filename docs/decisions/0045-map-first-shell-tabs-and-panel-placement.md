# 0045: Map-first shell build: hash-addressed tab panels, legacy panels rehomed to tabs and drawer, map fills home

Status: Accepted
Relates: [0038](0038-route-first-flow.md) (option B', amended 2026-11-01: the map-first shell itself), MEM-072
(`.claude/spec-cache/memripal/references/spec-4.md`).
Date: 2026-11-03
Source: Kev, 2026-11-03: "this looks pretty bad compared to the design we had with map first + with the nav at the
bottom for the routes, landmarks, recall, settings". Design: `docs/design/route/map-shell.html`, `map-shell.css`,
`map-drawer.css`, `route-contract-2.md` M.1-M.3.

## Context

0038 already decided the shell: home is a map of the selected route, a right-side drawer, bottom tabs Routes /
Landmarks / Recall / Settings. The live `static/index.html` still stacks every panel on one page, with the real map
([0041](0041-real-map-whole-file-pmtiles.md)) inside `#route-view` at a fixed aspect ratio. This ADR decides only how
the build gets there. Constraints:

- Every existing id must stay in the page exactly once: existing flows and the markup tests (`BASE_IDS`, A5, MEM id
  lists) look them up.
- The app also runs offline in the Capacitor shell ([0032](0032-capacitor-android-shell.md)); CSP forbids inline
  style.
- MEM-044: no filter, transform, z-index, overflow etc. on `main` or any ancestor of `#scene-overlay`, so the overlay
  stays viewport-fixed.

## Options considered

Tab switching:

- (a) Four `section.tab-panel` in one page, toggled by `hidden`, active `a.tab` marked `aria-current="page"`,
  addressed by `#routes` / `#landmarks` / `#recall` / `#settings` (chosen). `static/tabbar.js` `showTab` /
  `initTabbar` (click, initial hash, `hashchange`).
  Pros: one DOM keeps every id once, so flows and tests find them unchanged; no navigation, so it works offline in
  Capacitor; state is unit-testable without a browser; a hash deep-links a tab.
  Cons: all tabs load at once; a small JS module to keep `hidden` and `aria-current` in step.
- (b) A separate HTML page per tab.
  Pros: each page small; no tab JS.
  Cons: splits ids across pages, breaking flows that reach across panels (Load demo -> route view, practice ->
  recall) and the one-page markup tests; per-page loads lose in-memory state; more files for the Capacitor bundle.
- (c) CSS `:target` only.
  Pros: no JS.
  Cons: cannot set `aria-current` on the active tab; no tab shown when the hash is empty or names another id;
  flows cannot switch tabs programmatically without rewriting the hash.

Legacy panel placement:

- (a) Rehome by job (chosen). Recall tab: `#walk`, `#recall`, `#history`, the room-photo palace panel, `#route-review`,
  `#scenes`. Settings tab: `#routes-settings` (live settings), `#place-settings` (place history), `#backup`. Routes
  drawer: `#public-banner`, `#status`, `#route-view`, `#routes-home` (routes list, "Map a new route", Load demo),
  `#capture-session`, `#station-card`. Landmarks tab: new `ol#landmarks-list` of the selected route's stations.
  Pros: home shows only the map; every id kept, so every flow still runs; each panel sits where its job is.
  Cons: some flows must now switch tab or open the drawer to show their panel.
- (b) Delete the legacy panels.
  Pros: smallest DOM.
  Cons: flows still use them (walk, recall, backup, capture, room demo until B10 per
  [0040](0040-retire-room-photo-flow.md)); breaks their tests.
- (c) Keep them stacked on home under the map.
  Pros: no flow changes.
  Cons: the look Kev rejected; the map cannot fill the viewport.

Real map mount:

- (a) Move `svg#route-map` out of `#route-view` into `div.map-wrap` in the Routes tab; `real_map.js` mounts
  `div.real-map` after it, filling the wrap; `.map-wrap` is fixed from below the topbar to `var(--tabbar-h)` above the
  bottom (chosen).
  Pros: the map fills the viewport above the tabbar as designed; the drawer overlays it rather than containing it.
  Cons: `#route-view` and the map are no longer one block; the 8/5 aspect ratio must not apply inside `.map-wrap`.
- (b) Keep the map inside `#route-view`.
  Pros: no markup move.
  Cons: `#route-view` sits in the drawer, so the map would be drawer-sized, not home.

## Decision

Tabs (a), placement (a), map mount (a). `#scene-overlay` stays a direct child of `main`, outside every tab panel and
the drawer; `main` sets none of the MEM-044 properties. Load demo seeds the route
([0042](0042-kendall-demo-route-seeding.md)), then lands on the Routes tab with the Kendall route on the home map;
capture opens the drawer; practice/recall entry points call `showTab("recall")`.

## Why this over the others

Tabs: (a) is the only option that keeps every id once in one DOM (flows and tests untouched), works offline with no
navigation, and sets `aria-current`; (b) splits the ids, (c) cannot mark the active tab. Placement: (b) breaks live
flows, (c) is the rejected look; only (a) gives a map-only home with every flow intact. Map: only a mount outside the
drawer lets the map fill home.

## Consequences

- New `static/tabbar.js`; `app.js` calls `initTabbar(document)`.
- Flows that reveal a panel in a hidden tab must call `showTab` or open the drawer first.
- `.drawer-body` may scroll (`overflow`): it is not an ancestor of `#scene-overlay`.
- Not decided: loci generation and alternatives (MEM-072 S2-S4), still PLANNED.
