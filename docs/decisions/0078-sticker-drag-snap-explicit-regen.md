# 0078: Stickers drag and snap; regeneration is an explicit button

Status: Accepted
Date: 2026-11-04
Source: MEM-131 (`.claude/spec-cache/memripal/references/spec-6.md`).

## Context

Kev ask 2026-11-04: "i didnt know it would regenerate imediately when i was clickin on it since iw anted to drag it
around on the picture, it should snap to the parts that are segmented and would associate in that hitbox of that
segmented object". MEM-117 re-rolled a tour sticker on tap; MEM-045 photo stickers could not move. Both surfaces must
work on touch, mouse and keyboard, and every sticker change should be reversible.

## Options considered

- (A) Keep tap-to-regenerate; long-press starts a drag.
  Pros: smallest change; regen stays one tap away.
  Cons: the accidental regen Kev hit remains; long-press timing is undiscoverable and fights the browser's touch
  context menu; keyboard users get no drag equivalent.
- (B) Tap selects, drag moves (snap to the nearest segmented box), an explicit "New sticker" button regenerates
  (chosen).
  Pros: no accidental regen; a 6 px slop separates tap from drag with no timing, so touch works without long-press;
  arrow keys mirror drag; every move and re-roll pushes one undo entry.
  Cons: regen costs a second tap (select, then New sticker); one more button and an Undo control per surface.
- (C) A separate drag handle on each sticker.
  Pros: tap and drag never conflict.
  Cons: handles clutter small stickers on a 320x200 figure and the photo; tiny touch targets; the sticker face itself
  still is not draggable, which is what Kev tried.

## Decision

(B): `static/sticker_drag.js` arms on pointerdown and drags past `DRAG_SLOP_PX` (6); a drop snaps via `nearestBox`
to the smallest containing box, else the nearest edge. The tour swaps sticker and item between spots; the photo board
moves or swaps the placement. Tap only selects; `#tour-roll` "New sticker" re-rolls the selection or all; Undo
reverses the latest move or re-roll.

## Why this over the others

(B) removes the accidental regen at its cause and makes the sticker face itself the drag target, as Kev expected.
(A) keeps the surprise and adds hidden timing; (C) adds clutter and small targets without making the face draggable.

## Consequences

- Regen is one extra tap; the button label says what it does.
- Pointer events only, never `click`, so tap and drag share one code path across touch, mouse and pen.
- Snap reuses the segmented locus boxes, so a better segmentation directly improves drop targeting.
