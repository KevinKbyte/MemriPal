# 0031: Route + station store on the phone via the injected KV adapter; pending-before-upload; coords at 4 dp

Status: Accepted
Date: 2026-10-31
Source: MEM-048 (`.claude/spec-cache/memripal/references/spec-3.md`); map-to-palace plan
(`docs/plans/2026-10-31-map-to-palace.md`) D4, D10 and slice B3.

## Context

Map-to-palace replaces the one-room photo with a walked route: 3-8 stations captured in walk order, each a photo the
server pixelates and names (POST /station, B4). A route must survive reloads mid-walk, a bad phone network and quota
errors, and its locations must not leave the phone (D6: backups never carry coordinates). The app already persists
rehearsals through an injected KV adapter (`static/idb_adapter.js`, ADR 0021) that tests replace with an in-memory
fake. A station photo is sent to Meta's models before it is named, so a capture made offline has no server copy.

## Options considered

Chosen option first.

- (a) `static/route_store.js` over the injected KV adapter: routes keyed by uuid, `{id, name, kind daily|occasional,
  status draft|saved, created_at, stations[{id, n, name, photo_ref, status pending|named, box?, profile?, taps?,
  coords?}], lists[{id, name, status active|retired}]}`; the re-encoded photo is written as a pending station BEFORE
  upload; coords rounded to 4 dp at write.
  Pros: reuses the ADR 0021 seam, so store tests run on a fake KV with no browser; a capture is never lost to a
  network error, 5xx, 502 blur_failed or 429 (it stays pending for a manual Retry); a reload keeps the draft walk;
  4 dp (about 11 m) caps location precision before anything is stored.
  Cons: pending stations hold the re-encoded but NOT yet pixelated photo locally until named; a second store module
  beside the rehearsal store.
- (b) Server-side route storage (new endpoints + database).
  Pros: one copy across devices.
  Cons: coordinates and unpixelated photos leave the phone; needs accounts and auth the app does not have; offline
  capture still needs a local queue.
- (c) Upload first, store only the named result.
  Pros: no unpixelated bytes at rest; simpler station states.
  Cons: any network error, 5xx or 429 loses the capture and the walker must go back to the spot; no resumable draft.
- (d) localStorage JSON blob.
  Pros: synchronous and simple.
  Cons: its ~5 MB cap is too small for 8 photos per route; a second persistence path the KV fakes do not cover.

## Decision

Option (a). Station count: the store accepts 0-8 stations (a 9th is refused; drafts below 3 and drops are allowed);
`#finish-save` enforces 3-8 named stations. Order is capture order (`n`); Up/Down at S4 reorders. D10: one in-flight
request per station, manual Retry only (no online-event auto-retry); network error / 5xx incl. 502 blur_failed / 429
-> pending, any other 4xx -> error with Drop. A KV write failure (e.g. quota) keeps the in-memory station and reports
on `#upload-status`. No `captured_at` field.

## Why this over the others

Only (a) keeps every capture on a bad network while keeping locations and unpixelated bytes on the phone, and it
reuses a tested persistence seam. (b) moves exactly the data D6 keeps local; (c) loses captures; (d) cannot hold a
route's photos.

## Consequences

- Pending bytes are EXIF-free (re-encoded) but unpixelated; they are never exported or rendered outside the capture
  strip, and are replaced by the server's pixelated JPEG once named (export rules: B9).
- Coordinates carry at most 4 decimals in the store; a property test pins this.
- `static/route_store.js` and `static/route_capture.js` own the route shape; app wiring and POST /station land in later
  slices (B4/B5).
