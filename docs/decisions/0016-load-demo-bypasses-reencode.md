# 0016: Load demo uploads the demo photo's raw bytes, bypassing the client re-encode

Status: Accepted (amends [0009](0009-image-intake-and-photo-privacy.md))
Date: 2026-10-26
Source: `docs/plans/2026-10-26-memripal.md` GOAL (b) "Load demo" and S5 "Load demo runs the fixture palace";
MEM-017 fixture-mode failure "Upload failed: fixture_missing".

## Context

Per [0009](0009-image-intake-and-photo-privacy.md), `static/app.js` `upload()` always canvas-re-encodes the photo.
Browser JPEG encoders differ, so the re-encoded demo photo produced a different processed sha than the one the replay
fixtures are keyed by ([0011](0011-s2-loci-request-shape.md)), and fixture mode failed with `fixture_missing`.

## Options considered

- Skip the re-encode when the upload carries no EXIF.
  Pros: also covers a user re-uploading the demo file.
  Cons: client-side EXIF parsing; weakens the always-re-encode privacy invariant of 0009; still fails if the server's
  Pillow output drifts.
- Fuzzy fixture match (perceptual hash or nearest key) in FixtureBackend.
  Pros: tolerant of any encoder.
  Cons: nondeterministic replay; a near-miss photo could replay the wrong fixture; changes the cache-key contract.
- "Load demo" button: GET the server's committed demo photo, POST those exact bytes, no re-encode.
  Pros: deterministic byte-identical sha; minimal code; already named in the plan (GOAL (b), S5); the demo photo is
  committed, EXIF-free and server-controlled, so skipping the re-encode exposes nothing.
  Cons: a user picking the demo file through the file input still re-encodes and misses the replay.

## Decision

`button#load-demo` calls `demoUpload(fetchFn)`: GET `/demo/photo.jpg` (fixed path, serves `fixtures/demo/photo.jpg`
as image/jpeg behind TrustedHostMiddleware), then POST those bytes to `/loci` unchanged. User-picked photos keep the
0009 re-encode; the server still re-validates every upload.

## Why this over the others

Only option that is both deterministic and leaves 0009's re-encode untouched for user photos; it ships a control the
plan already required.

## Consequences

- Demo processed sha pinned to a literal in `tests/test_fixtures_manifest.py::TestDemoProcessedShaPin`; a Pillow or
  demo-photo change fails there instead of as `fixture_missing` at demo time.
- New public route `/demo/photo.jpg`: fixed path, no user-supplied component; traversal tested in
  `tests/test_app.py::TestDemoPhotoRoute`.
- Photo pick and Load demo share one `latestOnly()` gate so overlapping uploads never render a stale result (MEM-017).
