# 0065: Merged stickers are layered emoji glyphs composed client-side in inline SVG

Status: Accepted
Date: 2026-11-04
Source: MEM-117 (`.claude/spec-cache/memripal/references/spec-5.md`), amends MEM-095 (Pal's tour).

## Context

Kev ask 2026-11-04: each locus of the tour's step-3 dog house gets one memorable picture made by merging base emoji
for the item's keywords; roll all or one. The house figure itself already exists (MEM-095 `houseFig` in
`static/tour.js`: boxes, labels, pins, route); stickers attach to it as an extra layer. Scope: no image generation,
upload or server storage.

## Options considered

- (a) Layered SVG emoji text (chosen).
  Pros: offline, zero cost, instant roll, deterministic tests with an injected `rng`, works in fixture mode; slots
  into MEM-095's existing inline SVG.
  Cons: look is bounded by the platform emoji font.
- (b) Canvas raster composite.
  Pros: pixel-level control of the merged image.
  Cons: not selectable or accessible; needs `toDataURL` to persist; harder to test without a DOM; a second surface
  beside the house SVG.
- (c) Image generation conditioned on emoji.
  Pros: richest, most unique images.
  Cons: latency per roll, cost, needs network and fixtures. Kept as a later upgrade.
- (d) Hand-drawn canned sticker art.
  Pros: best polish per sticker.
  Cons: no roll, does not generalise to arbitrary items.

## Decision

(a): `static/stickers.js` picks up to 3 emoji per item from `BASE_STICKERS` by keyword; `static/tour.js` `houseFig`
draws them as overlapping `text` nodes in a `g.tour-sticker` per box, after MEM-095's pins.

## Why this over the others

Only (a) is offline, free, instant and testable without a DOM or network, and reuses the existing house SVG. (b)
loses accessibility, (c) adds latency, cost and network, (d) has nothing to roll.

## Consequences

- House geometry, pins and the non-crossing route stay owned by MEM-095; this ADR adds only the sticker layer.
- Stickers live in memory only while the tour is open; persistence and search UI are out of scope (R1, R2).
