# 0076: Flashcards derived at read time from MemorizeItems; only a per-card note/review overlay is stored; two ratings

Status: Accepted
Relates: [0048](0048-memorize-breakdown-and-route-recommendation.md) (MemorizeItem, keyword placement),
[0049](0049-recall-schedule-and-push-reminders.md) (recall schedule), [0031](0031-route-station-store.md) (route KV).
Date: 2026-11-03
Source: Kev, 2026-11-03 (MEM-125): "Shouldnt the recall tab be similar to anki, with flashcards, and the flashcards
are what the user wants to learn - these cards being auto generated, and user can add specific notes to each card if
they want to if they want to edit it, but really the cards are meant to be supplemental review for the memory palace
routes' material that the user wants to attach to the loci. So after user ansewrs a card for example, itll show the
answer, and also the tag to which route it's part of".

## Context

A MemorizeItem ([0048](0048-memorize-breakdown-and-route-recommendation.md), KV `list:<id>`) carries keywords;
keyword i is placed on the i-th station of its route. That pairing (locus -> material) is already the card: front =
station name, back = keyword label, tag = route name. Constraints:

- Keywords and stations change: an item is regenerated, a station renamed, a route re-captured.
- The user's per-card note and review state must survive those changes.
- The backup validates MemorizeItems with an exact-key allowlist (`static/backup_routes.js` `itemIn`, `ITEM_KEYS`).
- The review schedule is ADR 0049's fixed countdown-doubling rule with a +1d re-review on a failed recall, not an
  adaptive SRS.

## Options considered

Storage:

- (a) Derive cards at read time from MemorizeItems + routes; persist only a per-card user overlay `{note, review}`
  under KV `card:<id>`, keyed by the stable id `item.id:station.id` (chosen).
  Pros: one source of truth for card content; cards follow keyword and station edits with no sync step; the same
  item + station keeps its note and review across regeneration; no change to the backup-validated item shape.
  Cons: the route KV holds a new value type; an overlay whose item or station disappears is orphaned.
- (b) Persist a generated deck (full card records).
  Pros: cards load without re-deriving; a card could be edited freely.
  Cons: card content duplicated from the items; goes stale when keywords or stations change; needs a sync step to
  detect and repair drift.
- (c) Store notes and review state inside the MemorizeItem.
  Pros: no new KV type; travels with the item.
  Cons: changes the backup-validated item shape (ADR 0048 exact-key allowlist in `itemIn`), so old and new backups
  diverge; per-keyword state nested in an item couples card edits to item rewrites.

Ratings:

- (a) Two ratings, Again / Got it (chosen).
  Pros: matches the schedule: good advances to the next fixed review, again adds the +1d re-review from ADR 0049.
  Cons: no Hard / Easy nuance.
- (b) Four Anki ratings (Again / Hard / Good / Easy).
  Pros: familiar to Anki users.
  Cons: implies per-card adaptivity the fixed schedule does not have; Hard and Easy would map to the same outcome as
  Good.

## Decision

Storage (a): `deriveCards(routes, items)` builds cards on every read; `createFlashcardStore` persists only
`{ type: "card", id, note, review }` under `card:<id>`; `mergeUserEdits` joins them by id. Ratings (a): `RATINGS` =
`["again", "good"]`, graded through `recallSchedule`.

## Why this over the others

Storage: (a) is the only option where card content cannot go stale and the item shape stays untouched; (b) adds a
sync step to keep a copy honest, and (c) breaks the backup allowlist. Ratings: ADR 0049's schedule is fixed, not
SM-2 adaptive; four ratings would promise adaptivity it does not deliver.

## Consequences

- A note or review whose item or station disappears is orphaned in KV: kept, and it reattaches if the same item +
  station returns.
- The route KV now holds type `"card"` values; `static/route_store.js` lists only type `"route"`, so routes are
  unaffected.
- Phase A shipped the deck module and card view; phase B mounts them in the Recall tab through
  `static/flashcard_mount.js` (MEM-125). Carrying notes/review state in the backup and offering a new date past
  the deadline stay PLANNED.
