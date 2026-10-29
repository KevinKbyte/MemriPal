# 0029: Generated hard rooms are committed test fixtures only, never demo content

Status: Accepted
Date: 2026-10-29
Source: MEM-043 (`.claude/spec-cache/memripal/references/spec-3.md`); S2j handoff Facts (MEM-043 design, Meta API
check); Kev: images that "look more like real photos with less clean renders";
https://dev.meta.ai/docs/api-reference/images/create-image.

## Context

E2E runs on one demo photo (`fixtures/demo/photo.jpg`), so loci, segment and intake paths are never driven by hard
rooms (cluttered, dim, odd aspect, rotated). README.md sells "Photograph a familiar space": a generated room shown as
the product would misstate it. Muse Image text-to-image (POST `/images/generations`, `muse-image-1.0`, $0.01 per
image, 150 RPM per team) returns `data[0].b64_json` and takes no seed (unknown fields -> 400), so one prompt never
gives the same bytes twice. Replay fixtures are keyed by the processed photo sha (0011), and Load demo posts raw bytes
because a browser re-encode changes that sha (0016). Live responses land in gitignored `refs/private/live-cache`
(0017); the promote step `backend.py` names was never built.

## Options considered

Chosen option first in each item.

- (a) Use. Test fixtures only: excluded from the deploy image, no README, `static/` or submission reference.
  Pros: the product claim stays a photo of the user's own space; no generated image ships.
  Cons: the public demo keeps one room. Alternative: generated rooms as demo or README art (misrepresents the
  product).
- (b) Source. Muse Image text-to-image, 3-5 rooms.
  Pros: realistic hard cases for about $1; same vendor and key custody as the app (0005).
  Cons: paid, Kev-run only; not reproducible. Alternative: more Pillow-drawn synthetic rooms (clean, unrealistic) or
  stock photos (license and EXIF handling per file).
- (c) Reproducibility. Commit the returned bytes; an existing room file is never regenerated.
  Pros: fixtures and their replay entries stay stable without a seed.
  Cons: binary files in git; a deleted room file regenerates different bytes and orphans its replay entries.
  Alternative: regenerate per run (new sha each time, no replay possible, paid every run).
- (d) Realism. A shared prompt suffix for a casual smartphone snapshot: tilt, wide-angle distortion, mixed light,
  blown windows, grain, clutter.
  Pros: closer to what users upload than a clean render (Kev's ask).
  Cons: still synthetic; one real room photo stays the realism check. Alternative: default prompts (clean renders).
- (e) Intake variants. Derived offline by a deterministic Pillow post-process (EXIF orientation, fake GPS, HEIC,
  oversize, heavy JPEG, odd aspect), never committed.
  Pros: no extra paid calls; EXIF-bearing variants never meet `precommit_scan.py`.
  Cons: tests rebuild them each run. Alternative: commit variants (blocked by the EXIF scan) or generate each one
  (paid, no control over the defect).
- (f) Replay. One Kev live record per room, then `scripts/promote_live_cache.py` copies only that room's entries
  into `fixtures/replay` with MANIFEST rows.
  Pros: E2E on rooms runs offline in fixture mode; other private live-run entries never get committed.
  Cons: a manual paid step per room. Alternative: live E2E per run (paid, flaky) or commit the whole live cache
  (leaks private photos' entries).
- (g) Delivery. `/demo/photo.jpg?room=<id>` serves the raw file; the id is pattern-checked before any path is built.
  Pros: the sha matches the replay entries (0016); no traversal.
  Cons: one more route parameter. Alternative: upload via the file picker (browser re-encode breaks replay).

## Decision

The chosen option in each of (a)-(g), specified as MEM-043 clauses T1, G1-G3, V1, M1, P1, D1, D2, X1, K1. Every
room and promoted file carries a `fixtures/MANIFEST.md` row citing this ADR as a test fixture.

## Why this over the others

Only generated images give realistic hard rooms at about $1 without per-file licensing, and committing their bytes is
the only way to replay them without a seed. Scoping them to tests keeps README's promise intact.

## Consequences

- Scope gate: work starts after the core demo is green and is dropped past about half a day.
- Kev confirms the output-ownership clause in Meta's API terms before the first room commit.
- The Cloud Run image has no room file: `?room=` there returns 404 `room_missing`.
- No `size` is sent (valid values unverified), so odd aspect comes from the variant crop, not generation.
- `make_synthetic_fixtures.py` must keep MANIFEST rows and files it does not own.
- Generated rooms test intake and E2E paths only; they say nothing about realism on real photos.
