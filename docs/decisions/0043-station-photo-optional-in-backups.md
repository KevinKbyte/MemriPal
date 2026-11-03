# 0043: Station photo is optional in backup v2; a photo-less station exports with the `photo` key omitted

Status: Accepted
Partially supersedes: [0033](0033-backup-v2-routes-no-coordinates.md) option (d) rationale "no photo-less routes
downstream".
Date: 2026-11-02
Source: MEM-054 (`.claude/spec-cache/memripal/references/spec-3.md`); Kev, 2026-11-02: "photos arent mandatory - it is
better for users to do so, to capture them all, to maximize memory + retention, but having it mandatory else it
crashes isnt UX friendly".

## Context

Backup export threw "undecodable photo" once the seeded Kendall demo route ([0042](0042-kendall-demo-route-seeding.md))
was stored: `route_store.seedRoute` gives each station a `photo_ref` with nothing stored under it, and
`static/backup_routes.js` `stationOut` re-encodes `routes.getPhoto(st.photo_ref)` unconditionally. MEM-054 also
requires `photo` on every station, so any photo-less station makes the whole backup fail, demo or not.

## Options considered

- (A) Exclude the demo route from export by its fixed id.
  Pros: smallest change; format untouched.
  Cons: edits to the demo route are never backed up; ties the export path to one id; any other photo-less station
  still crashes export.
- (B) Skip any route with a photo-less station.
  Pros: format untouched; covers demo and real routes alike.
  Cons: silently drops a real route that lost one photo from the only recovery file the user has.
- (C) Export a placeholder JPEG per photo-less demo station.
  Pros: format untouched; demo round-trips.
  Cons: ships a real JPEG in code that no UI shows; a re-import of the demo route collides with its fixed id
  (skipped, D11), so the placeholder buys nothing; real photo-less stations still crash.
- (D) Photo optional in the format (chosen).
  Pros: no route is dropped or crashes export; demo and real photo-less stations round-trip; no placeholder data.
  Cons: reverses 0033 (d)'s "no photo-less routes downstream"; restored photo-less stations show no image.

## Decision

(D). Photos are encouraged, never required. A station with no stored photo exports with the `photo` key omitted;
import accepts a station without `photo`. A present `photo` must still be a `data:image/jpeg;base64,` URL that decodes
via `loadImage`. Unknown station keys are still refused; the allowlist is unchanged.

## Why this over the others

Only (D) both keeps every route in the backup and stops export failing on any photo-less station. (A) and (C) fix the
demo alone; (B) trades a crash for silent data loss in the recovery file. Capture flow still asks for a photo per
station, so the omission is the exception.

## Consequences

- 0033 (d) still refuses v1 files; only its "no photo-less routes downstream" pro no longer holds.
- A photo-less station has no thumbnail for its box to sit inside, so its box exports as null.
- Restored photo-less stations render without an image until re-captured.
