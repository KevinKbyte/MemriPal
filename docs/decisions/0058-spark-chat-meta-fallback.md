# 0058: Spark chat falls back to Meta's hosted model, signalled by a response header

Status: Accepted
Relates: [0023](0023-chat-provider-adapter-reuses-meta-client.md) (provider adapter; a provider failure no longer
fails the call), [0056](0056-judges-only-access-gate-alb-cloud-armor.md) (judged live deploy), MEM-026,
MEM-106 / MEM-107 / MEM-108, runbook [deploy-gcp](../runbooks/deploy-gcp.md).
Date: 2026-11-03

## Context

- The judged deploy should serve Spark chat from the open-weights model (`MEMRIPAL_CHAT_PROVIDER=baseten`, model
  `meta-models/muse-spark-open-1026`; also `fireworks` / `local`). Before this change a provider error, timeout or
  schema-invalid reply failed the judge's request outright.
- `MetaClient.chat_json` returns a `CallResult` and never raises; `MetaBackend._call_once` turns a failed or invalid
  result into `BackendCallFailed` (`BackendTimeout`, `BackendReplyInvalid`).
- Judges should see that the open-weights path degraded, not just a slower answer. The Capacitor shell calls the API
  cross-origin, so any signal must survive CORS.
- The per-instance call budget (`_BudgetedBackend`, MEM-034) wraps `backend.call`.

## Options considered

(a) Fallback signal

- (a1) Per-request `ContextVar` plus a pure-ASGI middleware setting `X-Memripal-Chat-Fallback: <provider>` (chosen).
  Pros: no route or response-schema change; one place covers every Spark route; the backend stays unaware of HTTP.
  Cons: needs `expose_headers` for the cross-origin shell; a context var is implicit state.
- (a2) A `chat_fallback` field in each JSON body.
  Pros: explicit, visible in any client without header access.
  Cons: every Spark route and its response model changes; the backend result would have to carry the flag up
  through each caller.

(b) Where the fallback lives

- (b1) Inside `MetaBackend.call`, wrapping one whole `_call_once(req, chat)` (chosen).
  Pros: one try/except around the full upstream call, parse and schema check, so error, timeout and invalid reply
  all fall back alike; the Meta answer caches under the Meta key; the budget sees one call.
  Cons: `MetaBackend` grows routing logic.
- (b2) A wrapper backend class around provider and Meta backends.
  Pros: separation of concerns.
  Cons: `chat_json` never raises, so the wrapper must re-derive failure from results or duplicate `_call_once`'s
  parse/validate; cache keys and budget counting would split across two backends.

(c) Dead-provider cost

- (c1) A 120 s breaker (`CHAT_SKIP_S`): after a provider failure, Spark calls go straight to Meta, then retry the
  provider (chosen).
  Pros: one timeout per dead window instead of one per request; recovers on its own.
  Cons: a single transient failure parks the provider for 120 s.
- (c2) No breaker.
  Pros: simplest; every call tries the open-weights model.
  Cons: a dead provider adds the full timeout to every judge request.

(d) Provider client bounds

- (d1) `httpx.Timeout(30, connect=5)`, `max_retries=0` (chosen).
  Pros: an unreachable host fails in 5 s; a slow cold model still gets 30 s to answer; no hidden retry multiplies the
  wait before the fallback.
  Cons: a reply slower than 30 s is discarded and paid again on Meta.
- (d2) A flat 20 s timeout.
  Pros: tighter worst case.
  Cons: a dead host still costs 20 s; a cold-start reply between 20 and 30 s is lost.

## Decision

(a1) + (b1) + (c1) + (d1). Details: MEM-106 (backend), MEM-107 (header, CORS), MEM-108 (client toast).

## Why this over the others

(a2) touches every Spark route for a display-only flag. (b2) cannot see failures without duplicating `_call_once`,
since `chat_json` never raises. (c2) makes a dead provider cost a timeout per request during judging. (d2) is stricter
where it hurts (slow cold replies) and looser where it does not help (dead hosts).

## Consequences

- Covers `local` and `fireworks` too: a local misconfig (wrong URL or model) is silently served by Meta. The WARNING
  `spark chat: <provider> failed (<exception class>), falling back to meta` shows it; the message never carries the
  exception text (it may echo a key).
- The header is set only after Meta succeeds; when Meta also fails the request errors as before, without the header.
- Budget: one unit per call, fallback included.
- Timeouts are provisional: after a live run, retune read timeout to max(15, 2 x warm p95).
