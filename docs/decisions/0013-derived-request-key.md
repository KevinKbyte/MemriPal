# 0013: Derived `RequestKey` beside the MEM-003 `CacheKey`

Status: Accepted
Date: 2026-10-26
Source: `docs/plans/2026-10-27-s2-loci.md` S2.3a; [0011](0011-s2-loci-request-shape.md) (A-prime);
`tests/test_backend.py` (MEM-003), `tests/test_backend_request.py` (MEM-014).

## Context

A-prime ([0011](0011-s2-loci-request-shape.md)) derives the cache key from a frozen `ModelRequest`, and the key must
also fold in model id, a gen-params digest, prompt template id, schema and `PROMPT_VERSION`. MEM-003 fixes
`CacheKey` to exactly {method, photo_sha, subject, attempt, prompt_version}, its tests build it directly, and the
committed synthetic fixtures are keyed by it. The MEM-003 positional shims carry only a photo sha, no image bytes.

## Options considered

- Separate frozen `RequestKey` returned by `ModelRequest.cache_key()`; `CacheKey` unchanged.
  Pros: both test files hold as written; committed fixtures keep replaying via the shims; same digest rule
  (sha256 of sorted compact JSON) so `ResponseCache` takes either key by duck type.
  Cons: two key types; shims cannot build a `ModelRequest` (no image bytes), so they replay by the legacy key.
- Widen `CacheKey` with the new fields (defaulted).
  Pros: one key type.
  Cons: breaks the MEM-003 exact-field test and changes every legacy digest, so committed fixtures go
  `FixtureMissing`.
- Subclass `CacheKey` with the extra fields.
  Pros: one isinstance family.
  Cons: inherited defaults force defaults on every new field, so a key could silently omit model or gen params.

## Decision

Separate `RequestKey` (method, photo_sha, subject, attempt, model, prompt_template_id, gen_params_digest,
schema_digest, prompt_version, templates_digest). `photo_sha = sha256(image_jpeg)` is always computed; both key types
reject any photo_sha that is not 64 lowercase hex chars. `PROMPT_VERSION` is read at call time; `templates_digest`
hashes `PHRASE_PROMPT`, `PHRASE_SCHEMA` and a rendered `_reask_prompt`, imported lazily from `probe.py` to avoid the
backend -> probe -> meta_client -> backend import cycle.

## Why this over the others

Only option that keeps MEM-003 and MEM-014 tests green without touching committed fixtures, and it has no defaults,
so every input that shapes the answer is in the key.

## Consequences

- `ResponseCache.put` and MetaBackend write-through are atomic (temp file in the target dir, then `os.replace`); only
  successful, complete, schema-valid responses are written.
- Fixtures recorded via `ModelRequest` live under `RequestKey` digests; S2.6 regenerates the demo fixtures that way.
- Positional shims stay on the legacy `CacheKey` until callers move to `call(ModelRequest)`.
- The schema check is a strict subset (type, properties, required, additionalProperties, items); any other keyword
  fails closed.
