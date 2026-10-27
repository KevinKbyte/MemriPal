# 0017: Live-mode cache goes to gitignored `refs/private/live-cache` (over write-through into `fixtures/replay`)

Status: Accepted (supersedes the "write-through removed the need for a separate record mode" rationale in
[0002](0002-backend-modes-and-replay-cache.md))
Date: 2026-10-26
Source: Kev, 2026-10-26, pointing at the existing `refs/public` (committed) vs `refs/private` (gitignored) convention;
MEM-014.

## Context

MetaBackend only WRITES the response cache; only FixtureBackend reads it. Live write-through into the git-tracked
`fixtures/replay/` mixed Kev's private photo responses into committed fixtures. `tests/test_fixtures_manifest.py`
`_snapshot` rglobs ALL of `fixtures/`, gitignored files included, so any live cache must sit outside `fixtures/`.
Write-through never saved the photo bytes, and `process_upload` is not idempotent, so recorded responses could not
be replayed: their keys hash a processed photo nobody kept.

## Options considered

- (a) No saving in live mode.
  Pros: simplest; no private data on disk.
  Cons: every live run is lost; nothing to promote into demo fixtures later.
- (b) Gitignored private cache at `refs/private/live-cache/`: responses plus the processed photo as
  `photos/<sha256>.jpg`.
  Pros: matches the existing `refs/public` committed vs `refs/private` gitignored convention; outside `fixtures/`;
  saved photo makes responses replayable and promotable.
  Cons: needs a later promote step to turn a live run into committed fixtures.
- (c) Keep write-through into `fixtures/replay/`.
  Pros: no promote step; live runs become fixtures directly.
  Cons: private photo responses land in a tracked tree; breaks the fixtures manifest snapshot; no photo bytes, so
  not replayable anyway.

## Decision

(b). `app.LIVE_CACHE_DIR = refs/private/live-cache`. `select_backend(mode, fixtures_root, live_cache_root=None)`
raises `ValueError` if `live_cache_root` resolves inside `fixtures/`; `None` means no disk writes. MetaBackend saves
the processed photo content-addressed at `photos/<sha256>.jpg` beside the responses.

## Why this over the others

Keeps live runs (unlike a) without putting private data in a tracked tree (unlike c), and saving the photo is what
makes a recorded run replayable at all.

## Consequences

- Demo fixtures stay synthetic until a later promote step copies chosen photos and responses into
  `fixtures/promoted/`, re-keyed to `sha(process_upload(P))`.
- S7 public mode passes `live_cache_root=None`: no disk writes, per [0003](0003-stateless-backend-client-state.md)
  stateless backend.
- The `fixtures/` guard is a `ValueError` at backend selection, not a convention (MEM-014, `tests/test_live_cache.py`).
