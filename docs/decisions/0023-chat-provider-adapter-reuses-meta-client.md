# 0023: Chat provider adapter reuses MetaClient; answers keyed by provider model

Status: Accepted
Date: 2026-10-27
Source: plan D12 (MEM-026); RED tests `tests/test_chat_provider.py`, `tests/test_chat_provider_wiring.py`,
`tests/test_run_live.py`.

## Context

[0006](0006-provider-toggles.md) (D12) fixed the toggle `MEMRIPAL_CHAT_PROVIDER=meta|baseten|fireworks|local`
but no adapter existed. Credits are now granted for Baseten ($100, Kev 2026-10-26) and Fireworks ($100, Kev
2026-10-27); the Fireworks serverless preview ends 2026-10-29, so the adapter had to land before then to be used at
all. All three hosts speak the OpenAI chat-completions shape that `MetaClient` already sends. Provider answers must
not overwrite or replay as Meta Spark entries in the cache ([0002](0002-backend-modes-and-replay-cache.md),
[0013](0013-derived-request-key.md)), the problem [0018](0018-modal-segment-cache-key-and-failures.md) solved
for Modal SAM.

## Options considered

- (a) Reuse `MetaClient` per provider (base_url + key; `None` key = no Authorization header, `local` only), built
  in `select_backend("meta")` as a `ChatProvider(name, client, model)`; cache key
  `replace(req, model=<provider> + "/" + <provider model>)`.
  Pros: one HTTP path (retries, Retry-After, key redaction) for every chat host; no new dependency;
  misconfiguration fails at startup; keys never collide with Meta entries or across local models.
  Cons: `MetaClient` gains a keyless mode; providers inherit any Meta-specific payload fields.
- (b) The `openai` client library for non-Meta providers.
  Pros: maintained, widely tested against these hosts.
  Cons: new dependency; a second retry/error/redaction path to map onto `BackendCallFailed` and to keep key-safe.
- (c) A separate `httpx` client for providers.
  Pros: decoupled from Meta specifics.
  Cons: duplicates `MetaClient`'s retry and redaction logic for no behavioral gain.
- (d) Cache key `<provider>/<req.model>` (the Meta Spark id), copying 0018 literally.
  Pros: same shape as the Modal key.
  Cons: two `local` runs with different `MEMRIPAL_LOCAL_CHAT_MODEL` share one entry, so one model's answer replays
  as another's. Rejected.

## Decision

(a). Exact-match env value, default `meta`, validated only in the meta branch; fixture mode never reads it
(0018 precedent). Only Spark chat (`spark_json`) moves; segmentation stays on Meta and `META_API_KEY` is always
required. A keyed provider without its key raises `MissingApiKey`; `local` without `MEMRIPAL_LOCAL_CHAT_MODEL` raises
`ValueError`. `scripts/run_live.ps1` decrypts `$HOME/.secrets/<provider>-api-key.dpapi` for baseten/fireworks.

## Why this over the others

Only (a) adds the providers without a second HTTP stack to keep key-safe (unlike b, c), and only the provider-model
key keeps distinct local models apart (unlike d).

## Consequences

- Provider answers live under `<provider>/<provider model>` keys (e.g. `local/llama3.2`), beside Meta entries.
- The payload is Meta's own (`max_completion_tokens`, strict `json_schema`). Live compatibility of that shape with
  Baseten, Fireworks and local servers is UNVERIFIED (open). Plain chat connectivity was verified 2026-10-27: all
  three HTTP 200, Baseten and Fireworks replied "pong"; Meta returned 200 with empty content within 200 tokens.
- After 2026-10-29 the Fireworks serverless model may stop serving; `meta` stays the default path.
