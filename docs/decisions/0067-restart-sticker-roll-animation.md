# 0067: Restart a sticker's roll animation by remove, flush, re-add

Status: Accepted
Date: 2026-11-04
Source: MEM-109 (`.claude/spec-cache/memripal/references/spec-5.md`).

## Context

A CSS animation does not restart when its class is added to an element that already has it. MEM-117's sticker re-roll
on a mid-roll tap repainted the emoji but left the spin running or finished, so the tap looked ignored.

## Options considered

- (A) Remove `is-rolling`, force a style flush by reading `getBoundingClientRect()`, re-add it (chosen).
  Pros: one class and one keyframe stay as MEM-117 specified; the reduced-motion CSS rule is unchanged; observable in
  the node fake DOM (class ops plus a layout read); 2 lines.
  Cons: a forced synchronous style recalc per tap (one small SVG group, negligible).
- (B) Alternate two classes with two identically defined keyframes (`is-rolling` / `is-rolling-alt`); a changed
  animation-name restarts the animation.
  Pros: no forced reflow.
  Cons: duplicated keyframes and reduced-motion rule; every test and CSS selector must know both names; state to
  track which one is on.
- (C) Web Animations API `element.animate()` from JS.
  Pros: explicit restart via cancel/play; no reflow trick.
  Cons: moves the animation out of CSS, so prefers-reduced-motion needs a JS `matchMedia` check; the node fake DOM has
  no `animate`; the existing MEM-117 CSS and tests change.

## Decision

(A). On a click or Enter/Space on a sticker carrying `is-rolling`, `tour.js` removes the class, reads
`getBoundingClientRect()`, and re-adds it.

## Why this over the others

(A) keeps MEM-117's CSS and tests as they are and costs two lines. (B) doubles the CSS surface to avoid a negligible
reflow. (C) relocates the animation and its reduced-motion handling into JS and breaks the fake DOM.

## Consequences

- A future roll effect on another element reuses the same remove/flush/add idiom.
- The layout read must stay between remove and add; dropping it as an apparent no-op silently breaks the restart.
