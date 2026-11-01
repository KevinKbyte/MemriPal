# MemriPal route UX, part 2: map-first shell contract (section M)

Goes with `map-shell.html` + `map-shell.css` (ADR 0038 amendment 2026-11-01). Home is this shell; part 1
(`route-contract.md`) S1 card-list home is superseded, S2-S9 stay the reference for the flows the shell enters
("Map a new route" -> S2 route setup; Recall tab -> S8). Map source for the hackathon: stylized SVG only (no tiles);
MapLibre + PMTiles is staged behind ADR 0038's conditions.

## M.1 Preview states (query)

| param | values | effect |
|---|---|---|
| `s` | `closed` (default) | Map + chip + filter + tab bar; drawer closed (handle only). |
| | `open` | Drawer open (also `?drawer=open`). |
| | `landmark` | Landmark card open on station 2 of the drawn route. |
| | `hidden` | Drawer hidden entirely: full-map view. |
| `lm` | `route` (default) / `all` | Landmark filter. `?s=all` is an alias for `?lm=all`. |
| `theme` | `light` / `dark` | Forces a theme. |

## M.2 Regions

| id / class | element | contract |
|---|---|---|
| `#map` `.map` | svg | Basemap layers (`.map-land`, `.map-river`, `.map-street-casing`, `.map-street`, `.map-park`, `.map-water`, `.map-label`), then `#offroute`, then `#route`. `--k` = map units per CSS px, so marker sizes stay constant at any zoom. |
| `#route` `.route.tc-N` | g | The ONE drawn route: `polyline.route-halo` + `polyline.route-line` under `mask#reveal`, then one `g.lm` per station. `tc-N` (N = 0-7) is the topic colour. |
| `g.lm` | g[role=button][tabindex=0] | `circle.lm-hit` (touch target), `g.lm-mark` (`circle.lm-dot` + `text.lm-num`), `text.lm-emoji` (aria-hidden). aria-label "n. Name". |
| `#offroute` > `g.lm.lm-off` | g | Off-route landmark: muted grey dot, no number, no emoji; aria-label "Name, on Route". Hidden unless filter = All. |
| `.map-attrib` | p | Credit slot: "Illustrative map" while the map is stylized SVG; the OSM credit once tiles ship (ADR 0038 option A). |
| `#chip` `.map-chip.tc-N` | p[aria-live=polite] | `#chip-name`, `.chip-topic` (`.topic-dot` + `#chip-topic` text), `#chip-meta` ("Daily, 6 stations"). Replaces a global legend. |
| `.lm-filter` | fieldset | `#lm-route` "This route" (checked) / `#lm-all` "All landmarks" radios. |
| `#lm-card` `.lm-card` | div[role=dialog] | `#lm-card-emoji`, `#lm-card-title`, `#lm-card-meta` ("Station 2 of 6, topic" or "On Route, topic Topic"), `#lm-card-close`. |
| `#drawer` `.drawer` | details (right side) | `summary.drawer-handle` ("Route settings" / "Close"); body: "This route" (`#route-name`, `#route-often`, `#route-topic` + `#topic-options` + `#topic-hint`, `#route-count`), `#map-new` "Map a new route", "Existing routes" (`#route-search`, `#pick-count`, `#pick-viewport` > `#pick-space`). |
| `.pick-head` / `.pick-row` | div | Windowed list items: header (aria-hidden, "Recent" or "Topic (n)") / row (role=listitem, aria-setsize/posinset) holding `button.route-pick.tc-N` (`.pick-swatch`, `.pick-name`, `.pick-meta`). |
| `.tabbar` | nav | Routes / Landmarks / Recall / Settings; current tab `aria-current="page"`. |

## M.3 Behaviour

| trigger | result |
|---|---|
| route picked (drawer row) | Map drifts to frame the route (800 ms viewBox tween), path draws in, landmarks pop in staggered; reduced motion = instant. Chip, drawer fields and `#map-title` sync. |
| click, Enter/Space, or ~500 ms long-press on `g.lm` | `#lm-card` opens beside the marker; Escape or `#lm-card-close` closes and refocuses the marker. |
| filter = All | `#offroute` holds only landmarks inside the viewBox + 25% margin (DOM nodes exist only there); recomputed on pan end, zoom end and tween end; a focused node is kept. |
| topic typed | Must match an existing topic (else `aria-invalid`); recents first in the datalist; route colour updates. |
| search / scroll in Existing routes | Recents, then groups by topic (sorted); only rows in view + overscan exist; arrows/Home/End/PageUp/PageDown rove focus. |

Colour: 8 fixed `tc-0`..`tc-7`, deterministic per topic id, user-overridable; topic text always beside the colour.
Scale target: 1000+ topics, routes and landmarks (the preview seeds 1000 routes, 125 topics).
