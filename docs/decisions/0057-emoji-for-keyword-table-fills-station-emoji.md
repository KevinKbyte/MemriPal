# 0057: A deterministic keyword/category table fills `Station.emoji` at creation; demo stations are hand-picked

Status: Accepted
Relates: [0055](0055-landmark-emoji-on-live-map.md) (optional `Station.emoji`, left open who sets it), MEM-100.
Date: 2026-11-03

## Context

ADR 0055 chose an optional stored `Station.emoji` (default U+1F4CD) and left open who sets it. Nothing does, so
every live-map marker shows U+1F4CD. Kev: "where are the best fit emoji, i only see red pins/ballon".

- "Load demo" seeds `static/demo_route.js` `DEMO_ROUTE` through `route_store` `seedRoute` (called from
  `static/flow.js`), not backup import.
- `seedRoute` copied only id/n/name/coords/address, so an emoji on a seed station was dropped.

## Options considered

- (1) Hand-picked emoji on the demo stations only (chosen, for demo stations).
  Pros: best fit; no heuristic.
  Cons: captured stations keep U+1F4CD.
- (2) Pure deterministic keyword/category table `emojiFor({ name, category?, tags? })` in
  `static/landmark_emoji.js`, called once when a station is created; result stored in `Station.emoji` (chosen,
  for every other station).
  Pros: same input -> same glyph, unit-tested per row; render path unchanged (0055's single fallback rule); the
  `category`/`tags` inputs are the landing spot for 0055 option (C) OSM tags.
  Cons: keyword misfires (why 0055 rejected render-time derivation) and table upkeep; mitigated because the value
  is stored once and a later source can overwrite it.
- (3) Render-time derivation again (0055 option B).
  Pros: no stored value to keep in sync.
  Cons: changes the renderer; a name edit silently flips the glyph.
- (4) OSM tags (0055 option C).
  Pros: grounded in real data.
  Cons: still a build/POI/candidate/backup pipeline change before the freeze.

## Decision

(1) for demo stations, (2) for every station created after.

`emojiFor` rules:

- Precedence: `category` > `tags` > `name`. Tags: values in insertion order, `_` -> space; any `shop` key -> shop.
- Matching: case-insensitive, diacritics folded, whole word with optional plural `s`/`es`.
- Earliest match position wins; tie -> longest keyword. No match -> U+1F4CD.

`seedRoute` keeps a station's `emoji`. Demo stations:

| Station | Emoji |
|---|---|
| Kendall/MIT station | U+1F687 |
| One Broadway tower | U+1F3D9 U+FE0F |
| Watermark towers | U+1F3E2 |
| Third Square Apartments | U+1F3D8 U+FE0F |
| Kendall Building boiler works | U+1F3ED |
| Meta office | U+1F4BB |

## Why this over the others

(1) gives the demo the best fit with no heuristic. (2) is deterministic and testable, and storing its result once
keeps 0055's renderer and fallback unchanged, unlike (3), which re-derives on every render and flips on a rename.
(4) stays the upgrade path: it feeds `category`/`tags` into the same table and fills the same field.

## Consequences

- New captures call `emojiFor`; the wiring in the capture flow (`static/app.js` / `static/route_capture.js`) lands
  in a separate slice.
- Still open: backup v2 `STATION_KEYS` omits `emoji`, so an imported station shows U+1F4CD.
- No user override UI yet.
