# 0071: Generated stickers are cropped from the item's scene

Status: Accepted
Date: 2026-11-04
Source: MEM-052 (`.claude/spec-cache/memripal/references/spec-6.md`).

## Context

Kev ask 2026-11-04: when a palace is memorized, generate a sticker from each memorized item, stick it on that item's
locus of the landmark photo, and auto-save it to the sticker pool (ADR 0068) so it is searchable by the item text.
`runScenes` already produces one scene image per item during encode; the backend is stateless (ADR 0003) and the
public demo replays fixtures.

## Options considered

- (A) Crop the tier-1 scene `runScenes` already produced to the locus box on the client (chosen).
  Pros: no extra API call, cost or latency; works with fixture replay recordings; no server change.
  Cons: the sticker includes some surrounding photo; depends on a scene existing.
- (B) A new server sticker-generation call per item (new prompt and endpoint).
  Pros: clean cut-out sticker art.
  Cons: an extra Muse Image call per item; new endpoint and fixture recordings; fails offline; not doable before the
  deadline.
- (C) Store the whole scene image as the sticker.
  Pros: simplest.
  Cons: unreadable at 56px; large pool entries.

## Decision

(A): `static/sticker_gen.js` crops the item's tier-1 scene to a 128x128 JPEG around the locus box centre, adds it to
the pool as kind `generated` and places it on the locus. When no crop is possible (offline, tier 3, failure) it falls
back to the first emoji matching the item text, and skips when nothing matches.

## Why this over the others

Reuses the existing generation path at zero added cost and degrades to the MEM-045 emoji seeds. (B) adds cost, a new
endpoint and offline failure; (C) yields unreadable, oversized entries.

## Consequences

- Sticker quality is bounded by the scene crop; a cut-out generation endpoint (B) would need a new ADR.
- Re-running the demo reuses a generated entry with the same desc, so the pool does not grow.
