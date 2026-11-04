# 0054: The real map loader resizes the map from its own ResizeObserver

Status: Accepted
Relates: [0041](0041-real-map-whole-file-pmtiles.md) (real map loader), MEM-076 / MEM-096.
Date: 2026-11-03

## Context

The MapLibre map renders blank or undersized when its `.real-map` box starts at 0x0 (route view on a hidden tab, or
a zero viewport at load) and gains size later. MapLibre 5 skips its own observer's first callback, so nothing calls
`map.resize()` once the box is laid out and the canvas keeps its stub size.

## Options considered

- (A) `static/real_map.js` observes `map.getContainer()` with `win.ResizeObserver` and calls `map.resize()` on a
  non-zero box; disconnects on the map's `remove` (chosen).
  Pros: covers every 0x0 path (hidden tab, zero-viewport load, any later layout change) in the one module that owns
  the map; touches no S6 hot file; a 0x0 callback never resizes.
  Cons: a second observer beside MapLibre's own; one extra resize when both fire.
- (B) A tab-show hook in `static/tabbar.js` calls `map.resize()` when the Routes tab opens.
  Pros: no observer.
  Cons: `tabbar.js` is an S6 hot file; misses the zero-viewport load; couples the tab bar to the map.
- (C) Rely on MapLibre's `trackResize`.
  Pros: no code.
  Cons: proven broken: a box going 0x0 -> 500x400 kept a 400 px canvas until `map.resize()` was called.

## Decision

Option (A). Without `win.ResizeObserver` the map mounts as before, unobserved.

## Why this over the others

(A) is the only option that fixes the zero-viewport load as well as the hidden tab, and it stays inside the map
loader, off the S6 hot files. (B) needs one hook per show path and still misses the load. (C) was measured not to
resize a 0x0-born canvas.

## Consequences

- `static/real_map_resize.test.mjs` pins the observer, the 0x0 no-op, the single resize, and disconnect on remount.
- Any future host-box sizing change needs no extra resize wiring.
