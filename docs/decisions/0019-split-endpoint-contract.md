# 0019: POST /split: list used as-is, notes via one image-less Spark call, one regeneration

Status: Accepted
Date: 2026-10-27
Source: S3a RED tests (commit 9ed844b, MEM-020); plan S3 + D15 (`docs/plans/2026-10-26-memripal.md`).

## Context

S3 needs the user's input turned into <= 12 points, one per locus, before associations. Two inputs (D15): pasted
notes (primary, <= 20 KB) and a typed list (secondary, <= 4 KB). Each notes point needs a `source_quote` that is
an exact substring of the notes after normalization. Spark replies are untrusted. The backend is stateless
([0003](0003-stateless-backend-client-state.md)), so the processed photo from POST /loci comes back from the
client, and every model call counts against the spend guard ([0004](0004-public-deploy-spend-guard.md)).

## Options considered

- (a) One JSON `POST /split` {photo, mode, text, loci_count}; photo re-validated by `validate_processed`; caps
  checked before any model call; list mode splits lines with no model call; notes mode = one `spark_json` call with
  `gen_params["send_image"] = False` and the notes in `gen_params["prompt_args"]`; reply checked in code by a split
  validator using the shared `textnorm.normalize`; an invalid reply gets exactly one regeneration, then 422
  `split_invalid`.
  Pros: no server state; list mode costs zero model calls; the photo is never sent to Spark for a split; oversize
  input is refused before spend; the notes are part of the cache key, so different notes never replay each other;
  one normalizer means the split and the S3 association validator agree on what "substring" means.
  Cons: the photo is re-uploaded and re-validated on every request; a bad first reply costs a second Spark call.
- (b) Caps (<= 12 points, label <= 100 chars) in the request JSON schema.
  Pros: limits live next to the shape they constrain.
  Cons: `backend._schema_valid` supports only a subset without `maxItems`/`maxLength`; the substring and 64 KiB
  checks cannot be expressed in a schema anyway, so a code validator is needed regardless.
- (c) Up to two regenerations with the failure reason (the plan's S3 association policy).
  Pros: more chances of a valid split.
  Cons: up to 3 Spark calls per split against the per-instance budget; the Q1 default is one regeneration.

## Decision

(a).

## Why this over the others

Only (a) keeps every cap enforceable (unlike b, which the existing schema checker cannot express) while bounding a
notes split at 2 Spark calls (unlike c).

## Consequences

- Contract pinned in MEM-020. `textnorm.normalize` is the single normalizer; the S3 association validator must
  reuse it.
- Spark calls per split: list mode 0, notes mode 1, at most 2.
- Model replies never pass through unchecked: extra keys, wrong types, out-of-range counts, unmatched quotes or a
  reply over 64 KiB end in `split_invalid`.
- Known inconsistency: S3a POST /split takes `photo` as plain base64 (a `data:` prefix -> 400 `bad_base64`), while
  S3b POST /associate takes `image` as a `data:image/jpeg;base64,` data URL. Deliberate for now; reconcile both
  endpoints and the client to one encoding later.
