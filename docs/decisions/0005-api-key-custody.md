# 0005: API key custody: DPAPI file locally, Secret Manager on GCP

Status: Accepted
Date: 2026-10-26
Source: `docs/plans/2026-10-26-memripal.md` D11, S1; `docs/runbooks/deploy-gcp.md` section 3.

## Context

Meta API key in hand 2026-10-26. Claude sessions work in the repo; the key must never reach the repo, logs, or a
Claude session.

## Options considered

Alternatives not formally evaluated. Retrospective note (not a decision-time comparison): the obvious alternatives
were a `.env` file (README: never), a plain environment variable set in the user profile, or an OS keyring.

- Chosen: DPAPI-encrypted `~/.secrets/meta-api-key.dpapi`, decrypted by Kev-run `scripts/run_live.ps1` into the child
  process env only; Secret Manager via `--set-secrets` on Cloud Run.
  Pros: key never in a file in plaintext, `.env`, or log; Claude sessions run `fixture` mode and never touch it.
  Cons: DPAPI is bound to Kev's Windows user, unusable on GCP, so deploy needs a second mechanism.

## Decision

DPAPI file locally; Secret Manager on GCP. The `meta` client reads the key from its process env only (missing ->
typed error, no file fallback).

## Why this over the others

No comparison was recorded; D11 states the chosen custody directly.

## Consequences

- Only Kev runs live mode and the probe.
- Rotation: `gcloud secrets versions add` then redeploy.
- Pre-commit hook scans staged files for key patterns.
