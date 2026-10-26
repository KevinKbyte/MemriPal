# 0010: Host on GCP Cloud Run

Status: Accepted
Date: 2026-10-26
Source: `docs/plans/2026-10-26-memripal.md` D10 (AMENDED), S7; `docs/runbooks/deploy-gcp.md`.

## Context

The deployed URL is a submission input ("code and live product", hackathon.md:199), so S7 is not cuttable. Budget:
GCP trial credit $299 (Kev confirmed), expiring 90 days after signup. The app is one FastAPI container serving API
and static frontend; traffic is a handful of judges.

## Options considered

Retrospective comparison: at decision time the plan named Cloud Run without a recorded comparison; the alternatives
below were assessed afterwards.

- Cloud Run.
  Pros: scales to zero (idle demo costs ~0); free tier (2M requests/month); `--max-instances=1` makes the
  per-instance call budget the whole-service budget ([0004](0004-public-deploy-spend-guard.md)); Secret Manager via
  `--set-secrets`; deploys the repo Dockerfile with `--source .`.
  Cons: cold start on first request; request timeout (default 300 s) bounds a synchronous `/loci`.
- App Engine (standard).
  Pros: managed, can scale to zero.
  Cons: runtime/`app.yaml` conventions instead of the plain container; flexible environment does not scale to zero.
- Compute Engine VM.
  Pros: full control, no request timeout.
  Cons: needs patching; bills while idle; no per-instance cap tied to scaling.
- GKE.
  Pros: full orchestration.
  Cons: cluster management; overkill for one container.
- Cloud Functions.
  Pros: scale to zero, per-invocation billing.
  Cons: function-per-entrypoint shape fits a FastAPI app plus static frontend poorly.

## Decision

Cloud Run, `--max-instances=1`, fixture mode default, keys from Secret Manager, $50 budget alert (alerts only; does
not stop spend).

## Why this over the others

Scale-to-zero plus the free tier keep a mostly idle demo inside the $299 credit, and max-instances=1 enforces the
spend model without extra infra; the alternatives either bill while idle or add management overhead.

## Consequences

- Residual: cold start on the first judge visit.
- Residual (unverified hypothesis): a synchronous `/loci` must finish inside the request timeout (300 s default), so
  it needs its own deadline ([0011](0011-s2-loci-request-shape.md) sets ~90 s).
- The service is never deleted before judging; credit expiry 90 days after signup bounds post-hackathon hosting.
