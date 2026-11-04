# 0055: Stations carry an optional emoji, default U+1F4CD, drawn above each station on the live map

Status: Accepted
Relates: [0038](0038-route-first-flow.md) (rule 1 "emoji landmark markers"; condition 4 planned a symbol-layer
emoji sprite), [0053](0053-station-street-address-and-poi-precision.md) (the last optional Station key),
[0046](0046-offline-walking-graph-routing-and-geocode.md) / [0047](0047-derived-auto-loci-and-swap.md) (POI JSON,
candidates), MEM-100.
Date: 2026-11-03

## Context

The live Routes map draws each station as a bare SVG circle; no emoji anywhere. Constraints:

- `static/real_map_overlay.js` `attachOverlay` repositions the sketch's `route-node` circles via `map.project()` on
  every move and adds an `lm-arrow` sibling per station (a circle cannot hold children); `detachOverlay` removes the
  arrows.
- ADR 0038 rule 1 and `docs/plans/2026-10-31-map-to-palace.md` B15 (3) planned emoji markers. Only the design
  previews render them: `.lm-emoji` text in `docs/design/map/preview.{css,js}` (offset `-30px` up) and
  `docs/design/route/map-shell.{css,js}`. No `static/` code does.
- The `Station` typedef (`static/route_store.js`) has no category or OSM tags; `osm_id` is the only OSM link.
- Backup v2 is an allowlist (`STATION_KEYS`, `static/backup_routes.js:10`).
- Feature freeze Wed noon.

## Options considered

- (A) Optional `Station.emoji`; the map draws U+1F4CD when missing (chosen).
  Pros: deterministic, one fallback rule; no pipeline change; any later source fills the same field.
  Cons: every station shows U+1F4CD until something sets the field; a new Station key.
- (B) Derive the emoji from station-name keywords ("cafe" -> U+2615, etc.).
  Pros: no stored field; varied markers today.
  Cons: heuristic misfires (a name matching the wrong keyword, or none); the table grows without end and needs a
  test per keyword.
- (C) Capture OSM tags on POIs and map tag -> emoji.
  Pros: grounded in real data (`amenity=cafe` -> U+2615).
  Cons: needs Overpass tag capture in `scripts/build_walk_graph.py` and the POI JSON, carried through
  `static/auto_loci.js` candidates and backup; too much before the freeze; GPS-captured stations have no tags.

## Decision

Option (A).

- `Station.emoji?: string`; missing -> U+1F4CD.
- Rendering: `attachOverlay` adds one `text.lm-emoji` sibling per station (same reason as `lm-arrow`), placed at
  `(cx, cy - 30)` on every `place()`. Presentation attributes only (`x`, `y`, `text-anchor`, `dominant-baseline`,
  `aria-hidden`): CSP allows no `style` attributes. The glyph is set via `textContent`, never markup.
- `detachOverlay` removes the `lm-emoji` nodes, as it does `lm-arrow`.

## Why this over the others

(A) is the only option that is deterministic and fits before the freeze: (B) misfires on names, (C) needs a data
pipeline change through build, candidates and backup. (C) stays the upgrade path: it would fill `Station.emoji`,
so the renderer does not change.

## Consequences

- `static/route_store.js` `Station` typedef gains `emoji?: string`.
- Overlay tests assert one `lm-emoji` per station at `cy - 30`, U+1F4CD when the field is missing, and none left
  after `detachOverlay`.
- Not decided: carrying `emoji` in backup v2 (`STATION_KEYS` omits it, so an imported station shows U+1F4CD); who
  sets the field before (C) lands.
