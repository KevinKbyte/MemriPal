# 0077: Spark reasoning headroom is a send-time token cap (MEM-014, MEM-015)

Status: Accepted
Date: 2026-11-04

## Context

- Live `POST /loci` (also `/split`, `/associate`) returned 502 "upstream" in meta mode.
- Root cause: Spark (muse-spark) is a reasoning model; its hidden reasoning tokens count against
  `max_completion_tokens`. Live: 1341 reasoning tokens on the 1024-token phrase call, so `finish_reason` was
  "length" and content null, which raised `BackendReplyInvalid` and a 502.
- The app also swallowed the cause: no server log.

## Options considered

- (A) Raise each request's `max_completion_tokens` in `gen_params`.
  Pros: simple; visible per call site.
  Cons: changes every `ModelRequest` cache key, invalidating committed fixtures and live-cache replays.
- (B) Add `REASONING_HEADROOM_TOKENS` (8192) at send time in `MetaBackend.call` for every `spark_json` call, Meta
  client and chat-provider fallback alike (chosen).
  Pros: cache keys and fixtures unchanged; one place; same pattern as the send-time image-edit timeout.
  Cons: the sent cap differs from the recorded request's cap (documented in code).
- (C) Disable or lower reasoning effort.
  Pros: no extra tokens per call; fixtures and cache keys untouched.
  Cons: no documented Spark parameter; risks answer quality.

## Decision

Option (B). Also: on any `BackendCallFailed` the app logs route, exception class and message at WARNING
(`memripal.app`), and `MetaBackend` logs status plus a key-masked body excerpt (first `LOG_BODY_CHARS=500` chars).
`MetaBackend._logged` masks every configured key (Meta's plus each `chat` / `chat_fallback` provider client's
`_api_key`) before the `LOG_BODY_CHARS` cut, and never logs a provider chat call's body at all (a provider failure is
reported by class name only, MEM-106). The client response stays the bare error code (502 "upstream", or main's
spend-cap 503/429 mapping via `_call_failed`).

## Why this over the others

(B) fixes the root cause in one send-time place without touching any `ModelRequest`: cache keys, committed fixtures and live-cache replays stay valid, which (A) would break for every call site. (C) has no documented Spark parameter and trades answer quality for budget. The logging half is the minimum to diagnose the next upstream failure server-side while keeping the client body a bare code and never writing a key or a provider body to the log.

## Consequences

- Costs up to 8192 extra tokens per Spark call, only when the model actually uses them.
- Fixtures and cache keys untouched.
- Failures are now diagnosable from server logs without leaking any configured API key.
