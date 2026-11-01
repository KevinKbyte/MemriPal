# 0038: Route-first flow: map-first shell, capture anytime as an unfiled candidate, stylized SVG map now

Status: Accepted; amended 2026-11-01 (map-first shell, map source; see the two Amendment sections)
Date: 2026-10-31
Source: MEM-072 (`.claude/spec-cache/memripal/references/spec-4.md`); amends the capture-first screens in
`docs/design/route/` (S1 "New walk", S2 "Walking: capture") at 975c2a3.

The 2026-10-31 sections below record the original decision. Its flow rules (Decision 1-3) still hold; its layout
(A's card-list S1-S4 spine) is superseded by "Amendment 2026-11-01: map-first shell".

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
  placeholder until that ADR lands. (The basemap, a separate question, is decided in "Amendment 2026-11-01: map
  source".)
- `static/encode.js` keys associations by locus label and pairs by position; the swap rule needs station-id keys.
  Code follow-up, not part of this design change.
- Typed place search, if ever wanted, needs its own privacy decision (off by default, like `#place-toggle`).

## Amendment 2026-11-01: map-first shell

Kev rejected the card-list design (route-first 375 px shots at 1f8bec8) and approved the map-first shell in
`docs/design/route/map-shell.html` + `map-shell.css`. Contract: `docs/design/route/route-contract-2.md` (section M).

Options:
- (A') Keep the card-list S1-S4 spine (2026-10-31 decision). Pros: passes the 9-state gate with no new ids.
  Cons: owner rejected it; a list hides that a route is a place.
- (B') Map-first shell (chosen). The map is home and shows ONLY the selected route; a right-side drawer holds this
  route's settings, "Map a new route" and existing routes; bottom tabs Routes / Landmarks / Recall / Settings.
  Pros: matches the owner's Google-Maps-like model; one route at a time keeps the map uncluttered and bounds
  render cost at 1000+ routes. Cons: its own preview page and states, outside preview.html's 9 states; needs
  culling and windowing to stay fast at scale.

Decision: B'. Rules:
1. One route drawn: topic-coloured path, numbered stations, emoji landmark markers. On route switch: viewBox
   drift (800 ms tween), path draw-in, staggered landmark pop-in; `prefers-reduced-motion` = instant.
2. Landmark card on click or long-press (~500 ms); keyboard Enter/Space opens the same card.
3. Landmark filter "This route" (default) / "All landmarks". Off-route landmarks are muted grey and exist in the
   DOM only inside the viewport plus a margin, recomputed on pan end, zoom end and tween end.
4. Scale to 1000+ topics, routes and landmarks: no global legend (current route's topic = colour dot + name in
   the chip); fixed ~8-colour palette, deterministic per topic id, user-overridable, text always beside colour;
   topic field = typeahead with recents; existing routes = search + recents + grouped by topic, virtualized list.
5. Flow rules 1-3 of the 2026-10-31 decision carry over unchanged.

Why B' beat A': the owner's requirement decides it, and the 2026-10-31 cons against a map canvas no longer bind:
the drawer is a `<details>` (no sliding transform), the shell has its own `?s=` / `?lm=` states for
`scripts/screenshot_design.py`, and each marker has a hit circle larger than its dot.

## Amendment 2026-11-01: map source

Question: what draws the map under the route. Routes are `geo` (real places) or `sketch` (imagined or indoor,
e.g. inside grandma's house). Hackathon deadline ~2026-11-04; `docs/plans/2026-10-31-map-to-palace.md` lists
basemap tiles as a non-goal and B15 as the basemap stretch.

Options:
- (B) Stylized SVG map only, no real tiles. Pros: already built (map-shell.html); deterministic and offline, so
  the design gate can screenshot it; no CSP, CORS, tile-terms or privacy work; keeps the non-goal. Cons: no real
  streets under `geo` routes.
- (A) Hybrid: MapLibre GL JS + self-hosted Protomaps PMTiles for `geo` routes; SVG canvas for `sketch` routes,
  optionally anchored to a real pin (tap pin -> fly to it -> cross-fade to the sketch). Pros: real streets with no
  third-party key and no viewport leak (same-origin tiles); covers imagined places. Cons: MapLibre's blob: worker
  is blocked by the CSP (`security_headers.py`, no `worker-src`); PMTiles range requests are cross-origin in the
  Capacitor WebView; two basemaps; HTML emoji markers break virtualization; glyphs, sprites, extract size and
  attribution all need work; not doable by Nov 4.
- (C) Google Maps / Mapbox SDK. Pros: polished, fast to wire. Cons: third-party key and terms, viewport sent to the
  vendor, Google Maps already a non-goal.
- (D) Leaflet + raster OSM tiles via a backend proxy (B15 as first written). Pros: simple library, CSP unchanged
  behind the proxy. Cons: raster only (no vector dark style, no vector draw-in), proxy cost, tile-policy burden
  (tile.openstreetmap.org is off-limits for apps).

Decision: B now, for the hackathon. A is staged as amended B15 in the map-to-palace plan; adopt A only when every
condition below holds (2026-11-01 three-lens adversary round, no veto):

1. CSP: vendor `maplibre-gl-csp` and `setWorkerUrl` to a same-origin worker file; the `security_headers.py` CSP
   stays unchanged; a test asserts 0 CSP violations on the map page.
2. Tile origin: in Capacitor (`https://localhost`) either bundle the PMTiles extract in `www/` (verify it answers
   206 to Range) or wire `cors.py` (`add_cors` is not wired today) to allow `Range` and expose `Content-Range` /
   `ETag`. Probe the PMTiles range fetch in the Capacitor WebView before RED. Offline -> sketch fallback.
3. One route renderer: one SVG overlay positioned via `map.project()` on move, MapLibre as basemap only; the
   sketch canvas is the second basemap, never a second route renderer.
4. Markers: emoji via a GeoJSON symbol layer with an emoji sprite (or add/remove markers on `moveend` from a bbox
   query); a test asserts marker count == in-viewport count.
5. Glyph and sprite PBFs vendored (the stock Protomaps style fetches fonts from a CDN).
6. Extract budget: pinned bbox, maxzoom 14, a byte-budget test; a `geo` route outside the bbox renders as sketch.
7. Attribution always visible: "(c) OpenStreetMap contributors" (ODbL) + Protomaps; the per-image Mapillary
   credit stays as ADR 0012.
8. Privacy: tiles same-origin, so no third party sees the viewport; access logs off on the tile path (Range
   offsets reveal coarse location); no coords in URLs, logs, analytics or backups (ADR 0033).
9. Dark style + a11y: light/dark style flavours follow the app theme; the map canvas is `aria-hidden`, the route
   and landmark lists are the accessible path.
10. The design gate keeps the stylized SVG (deterministic, offline); MapLibre only in production `static/`.

Why B beat the others: it is the only option that ships by Nov 4 without overturning the basemap non-goal, and its
design is already built. A is the long-term answer (real streets plus imagined places, no third-party key) but
carries the CSP, CORS, virtualization and size defects above, so it waits behind explicit conditions. C leaks the
viewport to a vendor and needs a key; D is raster-only with a proxy burden and no vector dark style.
