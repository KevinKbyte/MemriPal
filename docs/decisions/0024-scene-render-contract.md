# 0024: Scene render contract: whole-photo edit re-encoded to JPEG, record-keyed, every failure tier 3

Status: Accepted
Date: 2026-10-28
Source: plan S4 (MEM-027, MEM-028); tests `tests/test_scenes.py`, `tests/test_scenes_live.py`,
`tests/test_scenes_api.py`; GREEN commit `af741a9`.

## Context

[0007](0007-scene-render-tiers.md) fixed the tiers (whole-photo edit, crop card, canvas), a 30 s timeout and 3
concurrent edits, but not the S4 contract. Muse Image replies are untrusted (plan S4 Q1 hardening). Scenes must
record and replay per association record through the request-keyed cache
([0002](0002-backend-modes-and-replay-cache.md), [0013](0013-derived-request-key.md)); live write-through lands in
gitignored `refs/private/live-cache` ([0017](0017-live-cache-in-refs-private.md)).

## Options considered

Chosen option first in each item.

- (a) Tier-1 bytes. Decode, RGB, LANCZOS-resize to the input photo's dims, always re-encode JPEG at
  `imaging.JPEG_QUALITY` (90).
  Pros: no model-supplied metadata or container survives; one output type (`data:image/jpeg`); dims match the overlay.
  Cons: one more lossy generation. Alternative: pass validated reply bytes through. Cons: model metadata reaches the
  client; data URL type varies by reply format.
- (b) Box. Validated by POST /scenes (`bad_box`), not sent to the model, not in the cache key.
  Pros: 0007 tier 1 is a whole-photo edit and the client zooms; one entry per (photo, record) whatever the box.
  Cons: the box is input-checked but unused server-side. Alternative: key by box. Cons: splits entries with no change
  to the edit (a crop edit is 0007's separate tier 2).
- (c) Key and template. The whole record rides in `gen_params[PROMPT_ARGS]`, so it is in the key (D3); `SCENE_PROMPT`
  stays out of `backend._templates_digest`.
  Pros: distinct records never share a replay entry; adding the template to the digest would re-key every request and
  orphan every recorded fixture now (precedent: `associate.ASSOCIATION_PLACE`).
  Cons: a change to a field the prompt ignores (e.g. `question`) also re-keys; a `SCENE_PROMPT` edit does not.
  Alternatives: item + locus only (two records for one pair replay each other's scene); template in the digest.
- (d) Timeout. `backend.IMAGE_EDIT_TIMEOUT_S` = 30 passed as `MetaClient.image_edit(timeout=)`, outside gen_params.
  Pros: never shapes the answer, so tuning it keeps every key.
  Cons: one more per-call knob in MetaBackend. Alternatives: in gen_params (re-keys on tuning); a client-wide
  timeout (changes chat and segment calls too).
- (e) Failure surface. Every failure is a tier-3 `Scene` with a fixed code: `fixture_missing`, `upstream`, `timeout`,
  `internal`, or a reply check `not_bytes`, `empty`, `too_large`, `bad_magic`, `decode_error`, `pixel_bomb`. Warning
  logs carry only the code or the exception type name.
  Pros: POST /scenes answers 200 on any model trouble and the client draws the canvas; no model text in reason or log.
  Cons: logs lack exception detail for debugging. Alternative: /associate's 404/502/500 mapping, where a missing
  scene would fail the walk instead of degrading.
- (f) Live cache. MetaBackend accepts any non-empty reply bytes and writes them through; `scenes._fit` is the only
  image check, on live and replayed bytes alike.
  Pros: the backend stays format-agnostic; one validator.
  Cons: a non-image reply can land in the live cache. Alternative: validate in MetaBackend before caching, which
  duplicates `_fit` or couples backend to scenes.
- (g) Concurrency. Module-level `threading.BoundedSemaphore(MAX_CONCURRENT_SCENES)`, wait unbounded.
  Pros: the cap holds server-wide across threadpool threads.
  Cons: a waiting request holds a threadpool thread. Alternative: acquire with a timeout -> tier 3, where queued
  scenes fail under load instead of waiting.
- (h) Reply checks. `scenes.py` imports imaging's private `_check_bytes`, `_open_header`, `_DECODE_ERRORS`.
  Pros: replies get the upload caps unchanged (`MAX_UPLOAD_BYTES`, `MAX_SIDE`, `MAX_PIXELS`, sniffed-format-only
  open, caps before decode).
  Cons: private-name coupling. Alternatives: make them public (imaging API churn) or copy them (two drifting copies).

## Decision

The chosen option in each of (a)-(h).

## Why this over the others

Each choice keeps recorded keys stable, leaks no model text, and sends every model failure down 0007's canvas path,
where the alternatives re-key fixtures (b, c, d), let model bytes or text reach the client (a, e), or duplicate the
image checks (f, h).

## Consequences

- A `SCENE_PROMPT` edit must bump `backend.PROMPT_VERSION`, which re-keys every request, so all fixtures regenerate.
- Code `timeout` is a raw `TimeoutError` only; an httpx read timeout surfaces as BackendCallFailed -> `upstream`.
- Non-image bytes can sit in the live cache (stored with the `.webp` ext); replay re-validates them via `scenes._fit`
  -> tier 3. Promoting live entries to fixtures must not assume they are images.
- Three slow edits (up to 30 s each live) stall further scenes, each waiting on a held threadpool thread; fixture
  replays pass through the same semaphore.
- An imaging refactor must keep `_check_bytes`, `_open_header` and `_DECODE_ERRORS`, or update `scenes.py`.
