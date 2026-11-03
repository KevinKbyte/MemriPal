# 0044: Route review reorders by drag and removes through an Edit-revealed trash

Status: Accepted
Date: 2026-11-02
Source: MEM-081 (`.claude/spec-cache/memripal/references/spec-4.md`). Kev (2026-11-02): "rather than up/down/drop,
cant we have a drag feature and trash icon that gets only turned on in a ui/ux friendly way". Design preview:
`docs/design/review/preview.html`.

## Context

The Load-demo route review (`#route-review`) gave every row three buttons: Up, Down and Drop. Reordering a 6-stop
route took many taps, and a destructive Drop sat next to the reorder buttons on every row. Constraints:

- 375 px phones are the primary target; the list sits in a scrolling page, so vertical gestures already mean scroll.
- CSP `default-src 'self'` (`src/memripal/security_headers.py`): no inline style attributes, so drag feedback is by
  class and live DOM reorder, not transforms.
- Every delete needs a confirmation step and an Undo (global UI-delete rule).
- Keyboard and screen-reader users must be able to reorder and remove.

## Options considered

- (A) Explicit Edit toggle reveals the trash; a drag handle (grip) is always visible.
  Pros: discoverable (a labelled button); trash hidden by default, so the default view has no destructive control;
  works with keyboard and screen readers (grip takes arrow keys, trash is a button); no gesture conflicts.
  Cons: one extra tap to enter edit mode before removing.
- (B) Swipe a row sideways to reveal the trash.
  Pros: familiar from mail apps; no extra button.
  Cons: undiscoverable; a sideways swipe competes with vertical drag and page scroll at 375 px; no keyboard path.
- (C) Long-press a row to enter edit mode.
  Pros: no visible control in the default view.
  Cons: undiscoverable; conflicts with OS text selection and context menus; slow (hold delay) and inaccessible.

## Decision

(A). Rows show `N.`, a grip (`data-action="drag"`, `touch-action: none`), and the label. Pointer events drive the drag
(they cover touch): pointerdown on the grip captures the pointer, pointermove moves the row live in the DOM to the slot
counted from the other rows' midpoints, pointerup commits through the model's `moveTo(from, to)`, and pointercancel or
Escape reverts. The grip also takes ArrowUp/ArrowDown/Home/End, keeps focus on the moved row, and a polite live region
announces the new position. `#route-edit` (aria-pressed, Edit/Done) reveals a trash per row; the first tap arms an
inline "Remove this place?" Remove/Keep confirm; removal shows a snackbar with Undo. Leaving edit mode cancels a pending
confirm. The review code moves out of `static/encode.js` into `static/route_review.js`; `encode.js` re-exports
`createRouteReview`.

## Why this over the others

(A) is the only option with a keyboard and screen-reader path and no gesture conflict at 375 px, and it keeps the
default view free of destructive controls. (B) and (C) hide removal behind gestures users must already know, and both
fight the page's vertical scroll and drag. The extra tap to enter edit mode is the intended friction before a delete.

## Consequences

- `move(i, delta)` stays for compatibility; the UI calls `moveTo`.
- e2e steps drive reorder by keyboard on the grip instead of Up/Down clicks.
- Order still persists through `store.saveRoute(order)` in `runEncode`.
