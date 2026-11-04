# Runbook: deploy to GCP Cloud Run

Kev runs every step by hand; Claude never reads, decrypts, or prints a key. Plan refs: `docs/plans/2026-10-26-memripal.md`
D1, D11, S7. Run from the repo root.

Judged deploy (ADR [0056](../decisions/0056-judges-only-access-gate-alb-cloud-armor.md), MEM-103..105): live mode,
judges sign in once with a shared access key (cookie), traffic enters only through a global HTTPS load balancer with
Cloud Armor. Order: 1, 2, 3, 4 (`MODE=meta`), 5 (edge, then redeploy with `EDGE_HOST`), 6 (verify), 7 (key to
judges). Steps 8-9 are rotation and the kill switch.

## Why Cloud Run

Decided in plan S7/D10. Cloud Run scales to zero, so an idle demo costs ~0. The Cloud Run free tier (2M requests/month)
plus the GCP free-trial credit ($299, expires 90 days after signup) covers a hackathon demo.
GKE adds cluster management; a VM needs patching and bills while idle.

## 1. One-time project setup

0. Prerequisite: the gcloud CLI. On Windows install it with winget, then open a new terminal so `gcloud` is on PATH;
   `sh` comes from Git for Windows (Git Bash). Elsewhere: <https://cloud.google.com/sdk/docs/install>.

```powershell
winget install --id Google.CloudSDK -e
```

   PowerShell does not accept the bash `VAR=value command` prefix used below. Each such command also has a PowerShell
   form: set `$env:VAR`, run, then remove it, since `$env:` lasts for the whole PowerShell session.

1. `gcloud auth login`
2. `gcloud config set project <project>`
3. Enable the APIs (`compute` is for the load balancer and Cloud Armor, step 5; `billingbudgets` is for the budget
   command in step 2, which fails until it is enabled):

```bash
gcloud services enable run.googleapis.com secretmanager.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com compute.googleapis.com billingbudgets.googleapis.com
```

## 2. Budget alert guard

The public URL can trigger paid model calls in live mode, so set a budget before the first deploy (console: Billing >
Budgets & alerts, or):

```bash
gcloud billing budgets create --billing-account=<billing-account-id> --display-name=memripal-cap --budget-amount=50USD --filter-projects=projects/<project-id> --threshold-rule=percent=0.5 --threshold-rule=percent=0.9 --threshold-rule=percent=1.0
```

`--filter-projects` scopes the budget to this project; without it the budget counts spend across the whole billing
account.

A budget alerts; it does not stop spend. Spend caps are D1: fixture default, passcode, `--max-instances=1`.
SUPERSEDED for the judged deploy (ADR 0056): it runs live and the access key replaces the passcode. The in-process
call budget resets on every restart and the persistent cap (MEM-094) has not landed, so also:

- Meta spend alert: in the Meta developer console, set a spend alert (and a hard cap if one is offered) on the
  account that owns `meta-api-key`. It is the only cap outside the process.
- Kill switch: step 9.

## 3. Secrets

Custody: locally the key lives DPAPI-encrypted at `~/.secrets/meta-api-key.dpapi` (D11; bound to Kev's Windows user,
unusable on GCP). On GCP it lives in Secret Manager. The app reads env vars only:

| Env var | Secret | Needed when |
|---|---|---|
| `META_API_KEY` | `meta-api-key` | live mode (`src/memripal/backend.py`); mapped only when `MODE=meta` |
| `MEMRIPAL_ACCESS_KEY` | `memripal-access-key` | always; the judges' shared key for `/access` (MEM-103) |
| `MEMRIPAL_RECORD_KEY` | `memripal-record-key` | always; signs association records ([ADR 0027](../decisions/0027-signed-association-records.md)) |
| `BASETEN_API_KEY`, `FIREWORKS_API_KEY`, `MODAL_SEG_TOKEN`, `MEMRIPAL_MAPILLARY_TOKEN` | named in `scripts/deploy_cloud_run.sh` | optional; mapped only if the secret exists |
| `MEMRIPAL_PASSCODE` | `memripal-passcode` | SUPERSEDED (ADR 0056): no longer mapped; the access cookie satisfies the passcode check ([ADR 0025](../decisions/0025-passcode-gate-and-host-allowlist.md)) |

1. Generate the access key and the record key (one run each; >= 128 bits). Copy the access key for step 7:

```bash
python -c "import secrets;print(secrets.token_urlsafe(24))"
```

2. Create each secret (`memripal-access-key`, `memripal-record-key`, `meta-api-key`), typing the value at the prompt
   (never on the command line or in shell history):
   `gcloud secrets create <name> --replication-policy=automatic --data-file=-`
   End input on a blank line with Ctrl-D (bash/Cloud Shell) or Ctrl-Z then Enter (PowerShell/cmd). The trailing
   newline is stored with the value; the app strips it. SUPERSEDED: `memripal-passcode` is no longer needed.
3. Rotate: step 8.
4. Read access: the deploy script grants the runtime service account `roles/secretmanager.secretAccessor` on every
   secret it maps (MEM-104). SUPERSEDED manual grant, only to repair a failed one (default runtime SA:
   `<project-number>-compute@developer.gserviceaccount.com`):
   `gcloud secrets add-iam-policy-binding <name> --member=serviceAccount:<runtime-sa> --role=roles/secretmanager.secretAccessor`

Never commit a key; the pre-commit hook scans for key patterns.

## 4. Deploy

Judged deploy, first pass (ingress still open; step 5 closes it):

```bash
MODE=meta sh scripts/deploy_cloud_run.sh
```

PowerShell:

```powershell
$env:MODE = "meta"; sh scripts/deploy_cloud_run.sh; Remove-Item Env:MODE
```

Optional env: `MODE` (`fixture` default, or `meta`; anything else is refused), `EDGE_HOST` (step 5), `GCP_PROJECT`
(default: gcloud config project), `REGION` (default `us-central1`), `SERVICE` (default `memripal`), `EXTRA_HOSTS`
(comma list, e.g. a custom domain). It runs `gcloud run deploy --source .` (builds the repo `Dockerfile`) with
`--allow-unauthenticated --max-instances=1` (the access gate and Cloud Armor do auth) and prints the service URL.

| Env var | Value | Why |
|---|---|---|
| `MEMRIPAL_MODE` | `MODE` (`fixture` default) | public default is zero spend; `meta` for the judged deploy |
| `MEMRIPAL_TRUSTED_PROXY_HOPS` | `2` when `EDGE_HOST` is set, else unset (1) | rate limits key on the real client, not the load balancer (MEM-105) |
| `MEMRIPAL_CALL_BUDGET` | `300` | per-instance live call cap; with `--max-instances=1` it is the whole-service cap (D1) |
| `MEMRIPAL_MAX_BODY_BYTES` | `21233664` | app-wide body cap = the largest route cap (`POST /split`) |
| `MEMRIPAL_ALLOWED_HOSTS` | `<service>-<project-number>.<region>.run.app` plus `EXTRA_HOSTS` plus `EDGE_HOST` | host guard; the script derives Cloud Run's deterministic URL before the first deploy |

Secrets come from step 3 via `--set-secrets` (table above); the always-mapped ones and, for `MODE=meta`,
`meta-api-key` must exist before deploying. `--set-env-vars` and `--set-secrets` replace all existing values on each
deploy; the script always passes the full list. SUPERSEDED: "going live = edit the script's `--set-env-vars`" is now
`MODE=meta`; `MEMRIPAL_PASSCODE` is no longer mapped.

Open-weights Spark: create secret `baseten-api-key` (step 3 command) and a `MODE=meta` deploy also sets
`MEMRIPAL_CHAT_PROVIDER=baseten`, so Spark chat runs on Baseten with automatic Meta fallback (ADR 0058, MEM-106). No
secret, or `MODE=fixture` -> Spark stays on Meta. Check which model answered:

```bash
gcloud run services logs read <service> --region <region> --limit 200 --log-filter='textPayload:"spark chat"'
```

`spark chat served by baseten` = open-weights; `spark chat: baseten failed (<class>), falling back to meta` then
`spark chat served by meta` = fallback (the provider is skipped for 120 s after each failure).

## 5. Edge: load balancer + Cloud Armor

1. Create the edge (idempotent: each resource is described first and created only if missing, so re-running is safe
   and heals a half-finished run). It exits 1 if the Cloud Run service does not exist yet (step 4 first):

```bash
sh scripts/deploy_edge_gcp.sh
```

   It reserves a global static IP, derives host `<ip-with-dashes>.sslip.io`, and creates the serverless NEG, backend
   service with the Cloud Armor policy, URL map, Google-managed cert, HTTPS proxy and `:443` forwarding rule. It
   prints the host and the cert status command. Env read (all optional):

| Env var | Default | Meaning |
|---|---|---|
| `GCP_PROJECT` | gcloud config project | project to build in |
| `REGION` | `us-central1` | region of the Cloud Run service and the serverless NEG |
| `SERVICE` | `memripal` | Cloud Run service; also the prefix of every resource name (`<service>-edge-ip`, `-neg`, `-backend`, `-armor`, `-url-map`, `-cert`, `-https-proxy`, `-https-rule`) |
| `RATE_LIMIT_COUNT` | `120` | requests per interval per client IP before the ban rule trips |
| `RATE_LIMIT_INTERVAL_SEC` | `60` | the rate-limit window |
| `BAN_DURATION_SEC` | `600` | how long a tripped IP is banned (429s) |

   Cloud Armor policy `<service>-armor`: lower priority number is evaluated first, first match wins.

| Priority | Rule | Action |
|---|---|---|
| 1000 | preconfigured WAF `sqli-v33-stable`, sensitivity 1 | deny-403 |
| 1001 | preconfigured WAF `xss-v33-stable`, sensitivity 1 | deny-403 |
| 2000 | all IPs, per-IP rate limit (`RATE_LIMIT_*`) | under limit allow; over limit rate-based-ban, deny-429 |
| default | (implicit) | allow |

   Order matters: the WAF denies sit ahead of rule 2000 because its conform action is `allow`, which would end
   evaluation before any later rule ran. Sensitivity 1 keeps false positives on free-text notes low. The rate-limit env
   is applied only when rule 2000 is first created; changing it later means deleting that rule, then re-running.
   The managed cert is named `<service>-cert` (`memripal-cert` by default). Re-runs reuse it and never recreate it;
   it takes time to become `ACTIVE` (step 3 below).
2. Redeploy behind the edge (one deploy sets LB-only ingress, adds the host to the host guard, sets proxy hops 2):

```bash
MODE=meta EDGE_HOST=<host> sh scripts/deploy_cloud_run.sh
```

   PowerShell:

```powershell
$env:MODE = "meta"; $env:EDGE_HOST = "<host>"; sh scripts/deploy_cloud_run.sh; Remove-Item Env:MODE, Env:EDGE_HOST
```

3. Cert wait: run the printed cert status command until it reads `ACTIVE` (typically 15-60 min after the IP resolves).
   `FAILED_NOT_VISIBLE` or `FAILED_RATE_LIMITED` (sslip.io is a heavily shared domain), or still `PROVISIONING` after
   60 min -> fallback: a self-signed cert on the same proxy (judges click through one browser warning). Names come
   from `gcloud compute target-https-proxies list`:

```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=<host>" -keyout edge.key -out edge.crt
```

```bash
gcloud compute ssl-certificates create memripal-selfsigned --certificate=edge.crt --private-key=edge.key --global
```

```bash
gcloud compute target-https-proxies update <proxy> --ssl-certificates=memripal-selfsigned --global
```

   Delete `edge.key` from disk after the upload; never commit it.

## 6. Verify

Run against `https://<host>` once the cert is live.

1. No cookie: opening `https://<host>/` in a browser lands on `/access`. A non-HTML request gets 401
   `{"error":"access_required"}`; `/healthz` stays open and reports `"gated": true`:

```bash
curl -s https://<host>/
```

```bash
curl -s https://<host>/healthz
```
2. Wrong key at `/access` -> 401 and the form re-shown with an error; past `MEMRIPAL_ACCESS_MAX_FAILS` (default 20)
   wrong keys from one IP -> 429 `too_many_attempts` for `MEMRIPAL_LOCKOUT_S`. The in-process passcode lockout
   (`MEMRIPAL_PASSCODE_MAX_FAILS`) is not a control here: it runs only off Cloud Run (`K_SERVICE` unset, local live
   runs) and the deploy no longer maps `MEMRIPAL_PASSCODE`. On Cloud Run the controls are the access gate (its own
   per-IP `/access` lockout) and Cloud Armor.
3. Right key -> redirected to the app; no passcode box; "Load demo" and a live model route work.
4. The `run.app` URL is refused: expect HTTP 404 (Cloud Run ingress denial, not the app):

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://<service>-<project-number>.<region>.run.app/healthz
```

5. Proxy hops (MEM-105): from network A (e.g. a phone hotspot) send 21 wrong keys until A gets 429; then from
   network B sign in with the right key. B must succeed. If B is locked out too, every client shares one bucket;
   fix the hop count, then re-check:

```bash
gcloud run services update <service> --region <region> --update-env-vars MEMRIPAL_TRUSTED_PROXY_HOPS=<n>
```

SUPERSEDED (pre-ADR 0056, fixture deploy without the edge): open the `run.app` URL; banner reads "live needs passcode
/ try Load demo" (D13); "Load demo" runs the full loop in fixture mode; a live model request without the passcode
returns 401 `passcode_required`.

## 7. Judges key delivery

Put `https://<host>/` and the access key (step 3.1) in the submission's Project Description text (the form has no
private notes field). Never in the README, the video, or a commit. Anyone who can read the Project Description can get
in, so the cost cap is the Meta console spend limit plus `MEMRIPAL_CALL_BUDGET` (300 live calls, whole-service with
`--max-instances=1`); rotate the key after judging (section 8).

## 8. Rotation

Rotating the access key signs every judge out at once (old cookies stop validating), so do it deliberately, then
update the key in the Project Description.

1. `gcloud secrets versions add memripal-access-key --data-file=-` (same input rule as step 3).
2. Redeploy with the same env as step 5.2 so new instances read `:latest`.

The same two steps rotate any other secret.

## 9. Kill switch

Stop all Meta spend (the app keeps serving fixture data):

```bash
MODE=fixture EDGE_HOST=<host> sh scripts/deploy_cloud_run.sh
```

PowerShell:

```powershell
$env:MODE = "fixture"; $env:EDGE_HOST = "<host>"; sh scripts/deploy_cloud_run.sh; Remove-Item Env:MODE, Env:EDGE_HOST
```

Faster, without a rebuild (until the next deploy):

```bash
gcloud run services update <service> --region <region> --update-env-vars MEMRIPAL_MODE=fixture
```

## 10. Cost check

Do not delete the service: the deployed URL is a submission input. Scaled to zero it has no idle cost. Check spend in
the console under Billing > Reports (filter: Cloud Run, Secret Manager, Cloud Build, Networking, Cloud Armor); budget
alerts from step 2 email the billing admins. The edge (step 5) bills while it exists, idle or not: about $12-13 for
two weeks (ADR 0056 option (f)).
