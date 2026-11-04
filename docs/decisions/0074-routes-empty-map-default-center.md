# 0074: Zero-route Routes map centers on Kendall Square, not Meta's Menlo Park HQ

Status: Accepted
Date: 2026-11-04
Source: MEM-114 (spec-6.md).

## Context

Kev asked for a default location on the empty Routes map, "maybe the main meta office or something". The orchestrator
brief named Meta HQ at 37.4848,-122.1484 (1 Hacker Way, Menlo Park). The only self-hosted tile extract is
`static/map/kendall.pmtiles` (ADR 0041; bbox -71.1083,42.3494,-71.0719,42.3764; 1.3 MB), and the map's `maxBounds`
clamp to it.

## Options considered

- (A) Center on Kendall Square 42.3664,-71.0832, inside the extract and the neighborhood the demo route walks
  (chosen).
  Pros: real tiles render with zero new assets; Load demo opens in the same frame.
  Cons: not literally Meta HQ.
- (B) Build a second Menlo Park extract with `scripts/build_map_extract.py` and teach `real_map.js` per-extract
  bbox / `maxBounds` / style sources.
  Pros: literal Meta HQ.
  Cons: a new asset and a multi-extract loader on demo day; Load demo then jumps across the country.
- (C) Center on Menlo Park with the current extract.
  Pros: no new asset; nominally near Meta HQ.
  Cons: blank map, and `maxBounds` clamps it back to Kendall anyway.

## Decision

(A). `mountAt(svg, center, zoom)` in `real_map.js` reuses the station mount's `place()` path (theme, resize observer,
`maxBounds`) rather than a second Map setup.

## Why this over the others

(A) renders real tiles today and keeps demo continuity. (B) stays possible if a Menlo route is added.

## Consequences

- A zero-route Routes tab shows the Kendall Square map plus the call-to-action card.
- A center outside `REAL_MAP_BBOX` resolves null; no Map is created.
