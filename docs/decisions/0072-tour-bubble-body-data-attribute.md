# 0072: Tour-to-bubble signal via a body data attribute

Status: Accepted
Relates: [0064](0064-memri-copilot-street-photo-scenes.md) (Pal chat bubble), MEM-055, MEM-099.
Date: 2026-11-04

## Context

- The Pal bubble (`static/pal_bubble.js`) must go inert while the tour (`static/tour.js`) is open, except on a step
  that targets the bubble.
- Both modules self-mount and are imported inert in node tests; neither knows about the other today.

## Options considered

- (A) `tour.js` sets `body[data-tour-target]` to the current step's target selector; the bubble reads it at event
  time and CSS keys `pointer-events` off it (chosen).
  Pros: no import coupling between modules; deterministic; inspectable in DevTools; CSS and JS share one signal;
  works with the existing fake DOMs.
  Cons: stringly-typed contract; `aria-disabled` sync needs a MutationObserver.
- (B) `tour.js` dispatches CustomEvents (`tour:step` / `tour:end`) the bubble listens to.
  Pros: explicit event API.
  Cons: a bubble mounting after the tour opened misses the event (needs replay state); CSS cannot key off it.
- (C) The bubble imports tour state, or the tour imports the bubble.
  Pros: typed.
  Cons: couples two self-mounting modules and their load order; breaks the inert-in-node imports.

## Decision

(A): `tour.js` sets body `data-tour-target` ("" for target-less steps), removes it when the tour ends; the bubble
guards its handlers on it and CSS sets `pointer-events: none` unless the value is `.pal-bubble`.

## Why this over the others

(A) is the only option that needs no shared import or replay state and lets CSS and JS read one signal. (B) loses
late mounts and cannot drive CSS; (C) couples load order and breaks node imports.

## Consequences

- The attribute name and the `.pal-bubble` selector are a stringly-typed contract; tests lock both
  (`static/tour_bubble_signal.test.mjs`, `static/pal_bubble_face_tour.test.mjs`).
- The bubble runs a MutationObserver on body to keep `aria-disabled` in sync.
