# 0061: Past the Meta spend cap, degrade to saved results and the backup chat provider, plus BYOK

Status: Accepted
Amends: [0059](0059-meta-spend-guard.md) (each sent attempt is charged; capped routes degrade instead of failing).
Relates: [0058](0058-spark-chat-meta-fallback.md) (header + ContextVar pattern), MEM-094, MEM-121, MEM-122.
Date: 2026-11-04
Source: Kev, 2026-11-04, timing "Build now"; scope "Both (Recommended)" = "when credit runs out the app keeps
working on saved results and the backup chat provider for everyone, and BYOK still lets people who have a Meta key
keep going live."

## Context

- 0059 stops Meta spend at a cap (default $135), but past it only Spark chat kept working (Baseten/Fireworks);
  /loci, /station, /recall/audio and the scene render failed.
- 0059 charged once per logical call: a request retried after a 500 (max_retries 2) billed up to 3x unseen, and the
  live scripts (`probe_live.py`, `gen_room_fixtures.py`) were uncounted.
- Judges may arrive after the credit is gone; the demo photo and every live run's answers are already saved
  (committed fixture replay, the untracked live cache).

## Options considered

- (A) BYOK only: past the cap, ask the visitor for their own Meta API key.
  Pros: a visitor with a key keeps full live behaviour on their own bill.
  Cons: most judges have no Meta key, so for them the app still fails; key handling to get right.
- (B) Degrade only: past the cap, replay the same request from saved results (live cache, then fixture replay),
  chat on the backup provider, otherwise the typed cap code; the page names the cap in a toast.
  Pros: everyone keeps a working demo; no secrets from visitors; small change on the 0059 seams.
  Cons: a new photo past the cap gets no live answer; saved answers only match the exact same request.
- (C) Both: degrade for everyone (B), and BYOK (A) offered only once the cap is hit (chosen; Kev).
  Pros: judges always see a working app; someone with a key can still go live.
  Cons: two paths to build and test; BYOK is stacked as a separate change (MEM-122).

## Decision

Option (C), built in two changes. This one (MEM-121) is the degrade half plus the 0059 gaps:

- `MetaClient._send(..., charge=kind)` charges before every attempt; a retry the cap refuses raises
  `MetaSpendCapReached` unsent. The ASR client and both live scripts use the env guard.
- `spend_degrade.with_saved_results(backend, roots)` wraps the live backend in `create_app`
  (roots: the live cache, then `fixtures/replay`); a capped call replays the same `RequestKey`, a miss re-raises.
- Routes keep the landed 503 `meta_spend_cap_reached`; /scenes returns tier 3 with that reason (never "upstream").
- Header `X-Memripal-Spend-Cap: saved | backup | capped` (ContextVar + ASGI middleware, as 0058) drives a toast in
  `static/byok.js`: "Free demo credit is used up (Meta spend cap reached): showing saved results." (and variants).

BYOK (MEM-122) follows on this branch: a per-request MetaBackend + MetaClient + its own guard, shown only
after this toast.

## Why this over the others

(A) alone leaves every judge without a key facing errors; (B) alone strands a visitor who has a key and wants live
answers. (C) keeps the demo working for everyone and still lets keyed visitors go live, and it reuses 0059's seams
(guard, typed refusal, chat fallback) and 0058's header pattern instead of a new mechanism.

## Consequences

- Past the cap, a request with no saved answer still gets the cap code: the toast says live steps are paused.
- A header, not a body field, carries the state, so route bodies and their tests stay unchanged.
- Each retry now counts toward the cap, so the estimate is closer to (and never below) what was sent.
- BYOK (MEM-122) landed as planned: the key rides only in header `X-Memripal-Meta-Key` on the 5 model routes; each
  such request gets its own `MetaBackend` + `MetaClient` (Meta's base URL only) + `MetaSpendGuard` under
  `<spend dir>/byok/<HMAC-SHA256(MEMRIPAL_RECORD_KEY, key)>`, cap `MEMRIPAL_BYOK_SPEND_CAP_USD` (default $5). The
  shared backend, guard and ASR client are never touched and no ContextVar holds the key.
- BYOK answers skip the saved-results replay, the backup chat provider, the MEM-034 call budget and the shared live
  cache (a visitor's paid answers and photos are not kept for others); the passcode and rate limiter still apply.
- The outcome reaches the page in header `X-Memripal-Byok` (`invalid`, `limit`, `rejected:<model>`), set by an ASGI
  middleware from the request's own session object in the ASGI scope (no ContextVar), which also closes the
  session's HTTP client.
- With `MEMRIPAL_RECORD_KEY` unset the HMAC secret is random per process (as for record signatures), so a key's $5
  state restarts with the server; deploys set the record key, so the limit holds across restarts there.
