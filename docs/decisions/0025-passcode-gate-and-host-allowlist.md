# 0025: Passcode gate fails closed off loopback; deploy host via env allowlist; budget counts backend calls

Status: Accepted
Date: 2026-10-28
Source: plan S7 (D1, MEM-034); tests `tests/test_deploy_guards.py`, `tests/test_recall_audio.py`; GREEN commit
`a8b0086`. Realizes [0004](0004-public-deploy-spend-guard.md) on [0010](0010-cloud-run-hosting.md).

## Context

0004 fixed fixture default + passcode + per-instance budget, but not what happens with no passcode configured,
which routes are gated, or how the public host passes the MEM-015 DNS-rebinding guard.

## Options considered

Chosen option first in each item.

- (a) Unset passcode in live mode. Loopback host passes, any other host 401 `passcode_required`.
  Pros: `run_live.ps1` local use needs no passcode; a deploy missing the secret spends nothing.
  Cons: loopback is judged by the Host header. Alternatives: always require it (breaks local live use); open when
  unset (a missing secret opens paid calls publicly).
- (b) Gate scope. Per-route check on model routes only, before the body is read; fixture mode never gated.
  Pros: /healthz, / and /demo/* stay public for the fixture demo; unauthenticated callers get no validation hints.
  Cons: each new model route must add the check. Alternative: global middleware (gates the public demo pages).
- (c) Host allowlist. `MEMRIPAL_ALLOWED_HOSTS` appended to the loopback list; the deploy script computes the
  deterministic `<service>-<project number>.<region>.run.app` host.
  Pros: DNS-rebinding guard kept on the public URL; no host in code.
  Cons: a custom domain needs `EXTRA_HOSTS`. Alternatives: `*` on Cloud Run (drops the guard); hardcoded host.
- (d) Budget counting point. Wrapper around live `backend.call`, lock-guarded; 429 `budget_exhausted`.
  Pros: counts every model call incl. /loci SAM fan-out; fixture replays and 401s never charged.
  Cons: ASR via `asr_client` is not a backend call, so it is not counted. Alternative: per-request count (one
  /loci request is many calls).

## Decision

The chosen option in each of (a)-(d); passcode compared with `hmac.compare_digest`, stripped of the Secret Manager
trailing newline, blank = unset.

## Why this over the others

Each choice fails closed on the public host while keeping local live use and the public fixture demo open, where
the alternatives either open paid calls (a, c) or gate the demo (b).

## Consequences

- /scenes and /recall/audio must carry the same gate; s6-green's `_passcode_ok` (loopback incl. `::1`) must be
  reconciled with this gate at merge.
- /recall/audio ASR is outside the budget, contrary to 0004 Q1, until counted separately.
- The deploy script pins fixture mode; live use needs a redeploy with `MEMRIPAL_MODE=meta`.
