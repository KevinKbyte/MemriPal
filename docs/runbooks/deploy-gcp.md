# Runbook: deploy to GCP Cloud Run

Kev runs every step by hand; Claude never reads, decrypts, or prints a key. Steps marked **[S7]** need the plan's S7
Deploy-lite code (Dockerfile, passcode, per-instance budget, body cap), which is not built yet: this runbook is the
target procedure (`docs/plans/2026-10-26-memripal.md` D1, D11, D12, S7). Run from the repo root.

## Why Cloud Run

Decided in plan S7/D10. Cloud Run scales to zero, so an idle demo costs ~0. The Cloud Run free tier (2M requests/month)
plus the GCP free-trial credit ($300, expires 90 days after signup; the plan records $299) covers a hackathon demo.
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
| `BASETEN_API_KEY` | `baseten-api-key` | only with `MEMRIPAL_CHAT_PROVIDER=baseten` (D12) |
| `<PASSCODE_ENV>` | `memripal-passcode` | **[S7]** live-mode passcode (D1) |

1. Create each secret, typing the value at the prompt (never on the command line or in shell history):
   `gcloud secrets create <name> --replication-policy=automatic --data-file=-`
   End input on a blank line with Ctrl-D (bash/Cloud Shell) or Ctrl-Z then Enter (PowerShell/cmd). The trailing
   newline is stored with the value; **[S7]** code must strip it.
2. Rotate: `gcloud secrets versions add <name> --data-file=-` (same input rule), then redeploy (step 4) so new
   instances read `:latest`.
3. Grant the runtime service account read access, per secret (default runtime SA:
   `<project-number>-compute@developer.gserviceaccount.com`):
   `gcloud secrets add-iam-policy-binding <name> --member=serviceAccount:<runtime-sa> --role=roles/secretmanager.secretAccessor`

Never commit a key; the pre-commit hook scans for key patterns.

## 4. Deploy [S7]

With a `Dockerfile` in the repo root, `--source .` builds it (no Dockerfile: buildpacks, not the plan's path). The
container must listen on Cloud Run's `$PORT`.

```bash
gcloud run deploy memripal --source . --region <region> --allow-unauthenticated --max-instances=1 --set-env-vars=MEMRIPAL_MODE=fixture --set-secrets="META_API_KEY"=meta-api-key:latest,BASETEN_API_KEY=baseten-api-key:latest,<PASSCODE_ENV>=memripal-passcode:latest
```

- The quotes around `"META_API_KEY"` are stripped by the shell; they keep `scripts/precommit_scan.py` from flagging
  this line as a key assignment.
- `--max-instances=1` caps concurrent containers, so the per-instance call budget (D1) is the whole-service budget.
- `MEMRIPAL_MODE=fixture` keeps the public default at zero spend; how a passcode request reaches live mode is S7 code.
- Every secret named in `--set-secrets` must exist (step 3); drop `BASETEN_API_KEY=...` if Baseten is unused.
- `--set-secrets` and `--set-env-vars` replace all existing values on each deploy: always pass the full list.

## 5. Verify

1. Open the service URL printed by the deploy.
2. Banner reads "live needs passcode / try Load demo" (D13).
3. "Load demo" runs the full loop in fixture mode.
4. A live-mode request without the passcode returns 401 **[S7]**.

## 6. Cost check

Do not delete the service: the deployed URL is a submission input. Scaled to zero it has no idle cost. Check spend in
the console under Billing > Reports (filter: Cloud Run, Secret Manager, Cloud Build); budget alerts from step 2 email
the billing admins.
