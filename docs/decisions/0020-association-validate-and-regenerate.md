# 0020: Associations: deterministic validator, bounded regeneration, `invalid` terminal state

Status: Accepted
Date: 2026-10-27
Source: `docs/plans/2026-10-26-memripal.md` S3, D3, D16; MEM-021 (`tests/test_associate.py`,
`tests/test_associate_regen.py`, `tests/test_associate_api.py`).

## Context

S3 asks Spark for one association record per (item, locus): 8 KAVE COGS channels plus scene, walk, re-encode and
D16 question/answer fields. A record is only useful if it names the item and the locus, or the walk and the scene
lose the link. Spark replies are untrusted and sometimes blank a channel, drop the item or name the wrong locus. The
plan also flags D3: an association keyed without the locus label replays a record naming the old locus after the
user reorders items.

## Options considered

- (a) Deterministic 4-rule validator (8 channels non-empty; item verbatim in >= 1 channel; locus short label in
  >= 1 channel; echoed item/locus match), after `textnorm.normalize` (shared with POST /split,
  [0019](0019-split-endpoint-contract.md)); up to 2 regenerations,
  each carrying the previous failure reason in `gen_params["prompt_args"]`; then terminal `invalid`, returned as a
  200 so the UI offers edit/regenerate. Item and locus label ride in prompt args, so both are in the cache key.
  Pros: same reply always gets the same verdict, unit-testable per rule; reason-carrying re-prompts converge
  faster than blind retries; cost and latency bounded at 3 calls per item; a failed item never blocks the palace.
  Cons: rules check presence, not quality: a bland record that names item and locus passes; normalization must
  match how the model phrases labels.
- (b) LLM self-check: a second model call grades each record.
  Pros: can judge vividness and coherence, not just presence.
  Cons: nondeterministic verdicts (same record passes then fails); doubles calls per item; the grader is itself an
  untrusted reply needing validation.
- (c) Unbounded regeneration until valid.
  Pros: every item eventually valid when the model can comply.
  Cons: unbounded cost and latency; a persistently failing item hangs the run and burns the spend guard
  ([0004](0004-public-deploy-spend-guard.md)).
- (d) Single attempt, no regeneration.
  Pros: one call per item, simplest.
  Cons: every transient model slip surfaces to the user as an invalid record; lower demo quality (plan target 10/10
  valid).

## Decision

(a). `BackendCallFailed` and `FixtureMissing` are not regenerated: they propagate after one call (retry stays
pre-send only, inside `MetaClient`). Length caps live in the validator because backend `_schema_valid` refuses
`maxLength`.

## Why this over the others

Only (a) is deterministic (unlike b) and bounded (unlike c) while still recovering from a single bad reply
(unlike d); the `invalid` state hands the residual quality gap to the user instead of to more model calls.

## Consequences

- Contract pinned in MEM-021: at most 3 calls per item; `invalid` is a 200 with `status`, `attempts` and `record`.
- The UI must render `invalid` items with edit/regenerate; resume regenerates only missing or invalid items.
- Reordering items across loci yields new keys, so replay never returns a record naming the wrong locus; recorded
  fixtures are per (item, locus label) pair.
- A presence-passing but weak association is accepted; quality beyond the 4 rules is the user's edit.
- Known inconsistency (as in [0019](0019-split-endpoint-contract.md)): S3b POST /associate takes `image` as a
  `data:image/jpeg;base64,` data URL, while S3a POST /split takes `photo` as plain base64 (a `data:` prefix -> 400
  `bad_base64`). Deliberate for now; reconcile both endpoints and the client to one encoding later.
