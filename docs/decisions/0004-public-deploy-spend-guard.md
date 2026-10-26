# 0004: Public deploy defaults to fixture mode; live mode behind a passcode and per-instance budget

Status: Accepted (rationale amended 2026-10-26: the deployed URL is a submission input)
Date: 2026-10-26
Source: `docs/plans/2026-10-26-memripal.md` D1, R3, "Rejected alternatives" (persisted budget), "Ledger" (C5/A3/F3/S1
in-memory cap resets, S1 unbounded spend, S2 open model proxy).

## Context

A public URL can trigger paid Meta calls. The guide asks for "code and live product" (hackathon.md:199), so the URL
is a Goal input.

## Options considered

- Fixture default + passcode header (`hmac.compare_digest`, shared only in submission notes) + server input caps +
  per-instance call budget with max-instances=1.
  Pros: zero spend by default; no extra infra.
  Cons: budget resets on restart (R3).
- Persisted daily budget in GCS/Firestore.
  Pros: survives restarts.
  Cons: extra infra; passcode + fixture default already bound spend.
- Per-IP limit.
  Pros: none recorded.
  Cons: judged wrong by round-1 adversaries (Ledger C5).

## Decision

Fixture default, passcode-gated live mode, server caps and `max_tokens` on every call, per-instance budget with
max-instances=1. Real photos always use Spark standard tier (contributor tier only on synthetic fixtures).
Q1: `/recall/audio` chunks count against the same budget.

## Why this over the others

With max-instances=1 the per-instance budget is the whole-service budget, and passcode + fixture default bound
spend without new storage.

## Consequences

- R3 accepted: restart resets the counter.
- Every endpoint builds prompts server-side, so no endpoint is an open model proxy.
