# Runbook: deploy to GCP Cloud Run

Kev runs every step by hand; Claude never reads, decrypts, or prints a key. Plan refs: `docs/plans/2026-10-26-memripal.md`
D1, D11, S7. Run from the repo root.

## Why Cloud Run

Decided in plan S7/D10. Cloud Run scales to zero, so an idle demo costs ~0. The Cloud Run free tier (2M requests/month)
plus the GCP free-trial credit ($299, expires 90 days after signup) covers a hackathon demo.
GKE adds cluster management; a VM needs patching and bills while idle.

## 1. One-time project setup

1. `gcloud auth login`
2. `gcloud config set project <project>`
3. `gcloud services enable run.googleapis.com secretmanager.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com`

## 2. Budget alert guard

The public URL can trigger paid model calls in live mode, so set a budget before the first deploy (console: Billing >
Budgets & alerts, or):

```bash
gcloud billing budgets create --billing-account=<billing-account-id> --display-name=memripal-cap --budget-amount=50USD --threshold-rule=percent=0.5 --threshold-rule=percent=0.9 --threshold-rule=percent=1.0
```

A budget alerts; it does not stop spend. Spend caps are D1: fixture default, passcode, `--max-instances=1`.

## 3. Secrets

Custody: locally the key lives DPAPI-encrypted at `~/.secrets/meta-api-key.dpapi` (D11; bound to Kev's Windows user,
unusable on GCP). On GCP it lives in Secret Manager. The app reads env vars only:

| Env var | Secret | Needed when |
|---|---|---|
| `META_API_KEY` | `meta-api-key` | live mode (`src/memripal/backend.py`) |
| `MEMRIPAL_PASSCODE` | `memripal-passcode` | live mode on the public URL; sent as the `X-Memripal-Passcode` header ([ADR 0025](../decisions/0025-passcode-gate-and-host-allowlist.md)) |

1. Create each secret, typing the value at the prompt (never on the command line or in shell history):
   `gcloud secrets create <name> --replication-policy=automatic --data-file=-`
   End input on a blank line with Ctrl-D (bash/Cloud Shell) or Ctrl-Z then Enter (PowerShell/cmd). The trailing
   newline is stored with the value; the app strips it from `MEMRIPAL_PASSCODE`.
2. Rotate: `gcloud secrets versions add <name> --data-file=-` (same input rule), then redeploy (step 4) so new
   instances read `:latest`.
3. Grant the runtime service account read access, per secret (default runtime SA:
   `<project-number>-compute@developer.gserviceaccount.com`):
   `gcloud secrets add-iam-policy-binding <name> --member=serviceAccount:<runtime-sa> --role=roles/secretmanager.secretAccessor`

Never commit a key; the pre-commit hook scans for key patterns.

## 4. Deploy

```bash
sh scripts/deploy_cloud_run.sh
```

Optional env: `GCP_PROJECT` (default: gcloud config project), `REGION` (default `us-central1`), `SERVICE` (default
`memripal`), `EXTRA_HOSTS` (comma list, e.g. a custom domain). It runs `gcloud run deploy --source .` (builds the repo
`Dockerfile`) with `--allow-unauthenticated --max-instances=1` and prints the service URL.

| Env var | Value | Why |
|---|---|---|
| `MEMRIPAL_MODE` | `fixture` | public default is zero spend |
| `MEMRIPAL_CALL_BUDGET` | `300` | per-instance live call cap; with `--max-instances=1` it is the whole-service cap (D1) |
| `MEMRIPAL_MAX_BODY_BYTES` | `21233664` | app-wide body cap = the largest route cap (`POST /split`) |
| `MEMRIPAL_ALLOWED_HOSTS` | `<service>-<project-number>.<region>.run.app` plus `EXTRA_HOSTS` | host guard; the script derives Cloud Run's deterministic URL before the first deploy |

Secrets come from step 3 via `--set-secrets` (`MEMRIPAL_PASSCODE`, `META_API_KEY`); both must exist before deploying.
Going live = redeploy with `MEMRIPAL_MODE=meta` (edit the script's `--set-env-vars`); `--set-env-vars` and
`--set-secrets` replace all existing values on each deploy, so always pass the full list.

## 5. Verify

1. Open the service URL printed by the deploy.
2. Banner reads "live needs passcode / try Load demo" (D13).
3. "Load demo" runs the full loop in fixture mode.
4. After a live redeploy, a model request without the passcode returns 401 `passcode_required`.

## 6. Cost check

Do not delete the service: the deployed URL is a submission input. Scaled to zero it has no idle cost. Check spend in
the console under Billing > Reports (filter: Cloud Run, Secret Manager, Cloud Build); budget alerts from step 2 email
the billing admins.
