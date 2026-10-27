# 0018: Modal segment cache key is provider-distinct; Modal failures raise

Status: Accepted
Date: 2026-10-27
Source: adversarial eval (Opus, premise inventory) of the MEM-016 seg_provider wiring.

## Context

`ModalSegClient` (MEM-016) existed but was not wired into `MetaBackend`. Today a Modal non-2xx returns ""
(`seg_provider.py:85-86`), which MetaBackend would cache as a zero-box answer; an `httpx` transport error is not a
`BackendCallFailed`, so it escapes `loci._segment` as a 500. Modal and Meta segment requests for the same photo and
phrase would share one cache key, so a meta-mode run with modal segmentation could overwrite committed
`fixtures/replay` Meta entries (key rule: [0002](0002-backend-modes-and-replay-cache.md),
[0013](0013-derived-request-key.md)).

## Options considered

- (a) Eager client build in `select_backend` with a lazy import (`seg_provider` -> `meta_client` -> `backend`
  cycle); `MetaBackend(..., seg_client=None|ModalSegClient)`; fixture mode ignores MEMRIPAL_SEG_PROVIDER; Modal key
  = `dataclasses.replace(req, model="modal/" + req.model).cache_key()`; failures raise
  `BackendCallFailed("segment call failed") from None`, nothing cached.
  Pros: misconfiguration fails at startup; Modal entries never collide with Meta entries; no RequestKey change, so
  every existing key and fixture stays valid; failures degrade through the existing `loci.py:197`
  `BackendCallFailed -> []` path.
  Cons: model string carries a provider prefix instead of a dedicated field.
- (b) New `RequestKey` provider field.
  Pros: provider is explicit in the key schema.
  Cons: changes every key, invalidating all committed replay fixtures.
- (c) Keep returning "" on Modal failure.
  Pros: no new error path.
  Cons: poisons the cache: a transient failure is stored and replayed as zero boxes.

## Decision

(a). Fixture mode ignores the env var, following the precedent that `select_backend` reads META_API_KEY only in the
meta branch (`backend.py` `select_backend`). Malformed 2xx JSON still maps to "" (MEM-016).

## Why this over the others

Only (a) both keeps every existing key valid (unlike b) and keeps transient failures out of the cache (unlike c).

## Consequences

- Wiring contract pinned in MEM-016: one `select_seg_provider` call, in `select_backend("meta")`.
- Modal answers live under `modal/<model>` keys, beside (never over) Meta entries.
- A Modal outage yields zero boxes for that phrase per request, never a 500 and never a cached empty answer.
