# 0032: Backup v2 carries routes and lists by field allowlist, never coordinates, with 640 px thumbnails and its own 8 MiB cap

Status: Accepted
Amends: [0028](0028-palace-backup-export-import.md) options (a) scope and (b) images, and its byte cap.
Date: 2026-10-31
Source: MEM-054 (`.claude/spec-cache/memripal/references/spec-3.md`); map-to-palace plan
(`docs/plans/2026-10-31-map-to-palace.md`) D6, D11 and slice B9; adversary findings COR-F1, COR-F2, COR-F4, COR-F5,
SEC-F1.

## Context

0028 backs up one palace (`{v, palace_id, route, associations, rehearsals}`), no images, capped by `MAX_IMPORT_BYTES`
(1 MiB, the recall-relay chunk cap). Map-to-palace replaces that palace with walked routes (ADR 0031): 3-8 stations,
each a server-pixelated photo plus name, box, profile and taps, stored on the phone with coordinates at 4 dp and
optionally a Mapillary baseline image. A route is useless without its photos, so "no images" no longer holds; a
backup that kept coords, timestamps or baseline ids would map where the user walks (COR-F1, SEC-F1). 24 photos at
capture size exceed 1 MiB (COR-F2). Pending stations hold unpixelated photo bytes (COR-F4).

## Options considered

Chosen option first in each item.

- (a) What leaves the phone. An explicit per-field allowlist: route `{id, name, kind, created_at, stations, lists}`,
  station `{id, n, name, status, box, profile, taps, photo}`; saved routes and named stations only.
  Pros: a new store field is excluded until someone adds it on purpose; coords, timestamps, baseline data and
  pending bytes cannot leak.
  Cons: every new exportable field needs an allowlist edit. Alternatives: strip a denylist (a forgotten field
  leaks); fuzz coords to a zone centre (still exports home at the first/last station, COR-F1); a keep-locations
  option (same leak, opt-in).
- (b) Photos. Re-encode each stored pixelated photo to a 640 px long side, quality 0.7, EXIF-free JPEG; box scaled.
  Pros: 3 routes x 8 stations fit the cap; re-encode drops metadata.
  Cons: restored photos are lower resolution.
  Alternatives: full-size photos (over any sane cap); no photos (routes unusable after restore).
- (c) Byte cap. New `MAX_BACKUP_BYTES` = 8 MiB for export and import, checked before parse.
  Pros: sized to the thumbnail budget; `MAX_IMPORT_BYTES` keeps its 1 MiB recall-relay meaning.
  Cons: two caps to keep apart. Alternative: raise `MAX_IMPORT_BYTES` (loosens the relay cap it is tied to).
- (d) v1 files. Refused: "Older backup format, not supported", nothing written.
  Pros: no photo-less routes downstream; one import path.
  Cons: a 0028 backup cannot be restored. Alternative: migrate v1 (yields photo-less, unusable routes, COR-F5).
- (e) Id collisions (D11). A route whose id is already stored is skipped; status "n added, m already present"
  (", k skipped" when k > 0).
  Pros: keeps 0028's never-destroy rule; re-import is a no-op.
  Cons: a backup cannot refresh a stored route.
  Alternative: overwrite or duplicate.

## Decision

The chosen option in each of (a)-(e), specified as MEM-054. The file is `{v: 2, routes[], lists[], associations,
rehearsals}`; 0028's exact-keys whole-file validation, additive merge, client-only import and CSP stand. Imported
photos must be `data:image/jpeg` URLs that decode, with boxes inside the thumbnail.

## Why this over the others

Only an allowlist makes "backups never carry coordinates" hold for fields not yet invented. Thumbnails plus a
dedicated cap are the smallest change that lets a full set of routes round-trip without widening the relay limit.

## Consequences

- Station names and photos can still reveal where the user walks; the UI note says so: "Backups never include map
  coordinates or street photos. Station names and photos can still show where you walk."
- Coordinates and baselines are lost on restore; a restored route has no map positions until re-captured.
- 0028 backups can no longer be imported.
- Top-level `lists[]` is pinned only as an array until slice B7 defines list contents.
