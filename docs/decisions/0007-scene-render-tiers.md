# 0007: Scene rendering in three measured tiers (whole-photo edit, crop card, canvas)

Status: Accepted (tier lock pending S1 drift measurement)
Date: 2026-10-26
Source: `docs/plans/2026-10-26-memripal.md` D2, A4, R2, "Rejected alternatives" (feathered SAM-mask composite),
"Ledger" (compositing A4 vs P2, Finisher override).

## Context

Muse Image `/v1/images/edits` rejects `mask` (400 `unsupported_parameter`); docs say an edit keeps the rest intact.
Each locus needs a mnemonic scene.

## Options considered

- Tier 1 whole-photo edit, overlay zoomed to the bbox.
  Pros: zero compositing code; docs say edits keep the rest intact.
  Cons: drift outside the bbox unmeasured until S1 (bar: mean abs pixel diff outside 1.5x bbox < 12/255).
- Tier 2 crop edit (bbox + margin, min 512 px side) shown as a separate scene card.
  Pros: works if tier 1 drifts.
  Cons: not placed on the photo.
- Crop edit + feathered SAM-mask composite (v1 plan, Ledger P2).
  Pros: scene placed on the photo.
  Cons: an object mask clips imagery around the object; seam/style mismatch; unmeasured seam risk.
- Tier 3 canvas overlay (outline, numbered pin, label).
  Pros: always works offline.
  Cons: no generated imagery.

## Decision

Tier 1 primary, tier 2 if A4 drift fails, tier 3 on any failure (fixture miss, content-policy 400, timeout). Tier is
chosen at S1 by measurement, never at runtime by taste. Composite dropped.

## Why this over the others

`mask` was never usable, so the composite's mask was never load-bearing; tier 1 removes compositing code and the
unmeasured seam risk.

## Consequences

- R2 accepted: bar is >= 7/10 tier-1 scenes; the rest fall to tier 3.
- 30 s timeout, 3 concurrent; edit latency undocumented.
