# 0011: S2 loci request shape: one sync `POST /loci` over a `ModelRequest`-keyed backend

Status: Accepted (Kev approved after a 5-agent adversarial eval)
Date: 2026-10-26
Source: `docs/plans/2026-10-27-s2-loci-c1.md` on branch `s2-loci` (not yet merged; records A/B/C, A-prime below is
the post-eval refinement of A); `docs/plans/2026-10-26-memripal.md` D3, D5, D12, "Ledger" (S2 open model proxy).

## Context

Root problem: the backend seam was a replay interface keyed by cache identity, with no channel for image
bytes/prompt/schema, so `MetaBackend` could not call Meta. D5 keeps the server stateless; the Ledger forbids an
open model proxy.

## Options considered

- A: one sync `POST /loci`; `ModelBackend` widened with keyword request fields.
  Pros: smallest surface.
  Cons: spinner only; double-edits `backend.py` (with the pending cache-key fix).
- B: client-orchestrated `POST /phrases` + per-phrase `POST /segment` + `POST /select`.
  Pros: live per-phrase progress.
  Cons: open SAM proxy unless HMAC phrase tokens are added; photo re-uploaded 25-50x; 3 endpoints to harden;
  ~0.5 day more.
- C: separate `PhraseSource`/`Segmenter` ports outside `ModelBackend`.
  Pros: matches the D12 provider axes; no collision with the cache fix.
  Cons: second cache layer risk; more classes.
- A-prime: one sync `POST /loci`; the Protocol takes a frozen `ModelRequest`; `CacheKey` derived from it
  (`photo_sha = sha256(image_jpeg)`, never caller-supplied; model id, gen-params digest and PROMPT_VERSION included);
  pending cache-key fix folded into the same slice; ~90 s deadline; `on_progress` hook; `validate_processed()` never
  re-encodes.
  Pros: one replay layer; no open proxy; keys cannot drift from what was sent; one edit of `backend.py`.
  Cons: no progress bar until measured; S2.3 ~0.5 day larger.

## Decision

A-prime. NDJSON streaming is added via `on_progress` only if measured latency > 10 s. Meta mode is loopback-only
until the passcode lands (S7).

## Why this over the others

One replay layer (vs C), no open proxy (vs B), keys derived from the request itself so they cannot drift (vs A),
and a single edit of `backend.py`. Evidence for "never re-encode": re-encoding `fixtures/demo/photo.jpg` at q90
changed the sha on each of 4 rounds, so any re-encode in validation would break replay keys.

## Consequences

- Residual: no progress bar until latency is measured; latency unmeasured.
- Residual: S2.3 ~0.5 day larger.
- The ~90 s deadline sits inside Cloud Run's request timeout ([0010](0010-cloud-run-hosting.md)).
- Supersedes the identity-only seam in [0002](0002-backend-modes-and-replay-cache.md).
