# 0009: Image intake: client canvas re-encode plus server re-validation

Status: Accepted (amended by [0016](0016-load-demo-bypasses-reencode.md): Load demo posts the demo photo's raw bytes;
amended by [0022](0022-opt-in-place-context-server-lookup.md): opted-in GPS read client-side, never sent to Meta)
Date: 2026-10-26
Source: `docs/plans/2026-10-26-memripal.md` S2, D5, "Ledger" (C2 EXIF orientation, S3 decompression bomb, F-corr
HEIC, S4 fixture privacy/rights, S5 client-side privacy).

## Context

Users upload phone photos (EXIF orientation, GPS, HEIC) that are sent to Meta and may become committed fixtures.

## Options considered

Alternatives not formally evaluated. Retrospective note (not a decision-time comparison): the obvious alternatives
were server-only processing (server decodes HEIC and strips EXIF) or uploading the original file unchanged.

- Chosen: client re-encodes via canvas to JPEG (orientation applied, EXIF dropped, HEIC where the browser decodes
  it); server re-validates: 15 MB cap, magic bytes, lazy open, reject w*h > 40M or side > 8000 before load,
  `ImageOps.exif_transpose`, strip EXIF, downscale long side 2048, decode errors -> 400.
  Pros: EXIF/GPS stripped before upload; pixel bombs rejected before decode; no server HEIC decoder.
  Cons: HEIC only where the browser decodes it.

## Decision

Client canvas re-encode plus server re-validation on every endpoint. Photo-sent-to-Meta notice before upload.
`fixtures/raw/**` gitignored; MANIFEST.md records source + license per fixture; pre-commit blocks EXIF in committed
images.

## Why this over the others

No comparison was recorded; the Ledger accepted each check as a fix for a named round-1 finding.

## Consequences

- Cache keys use the PROCESSED photo sha ([0011](0011-s2-loci-request-shape.md)).
- Tests: orientation-6 and 5 rejection cases (too big, bad magic, zero-byte, non-image, pixel bomb).
