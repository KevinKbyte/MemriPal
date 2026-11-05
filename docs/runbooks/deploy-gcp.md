# Runbook: deploy to GCP Cloud Run

Kev runs every step by hand; only Kev's run of `scripts/create_secrets.sh` decrypts a key, and Claude never sees one.
Plan refs: `docs/plans/2026-10-26-memripal.md` D1, D11, S7. Run from the repo root.

Judged deploy (ADR [0056](../decisions/0056-judges-only-access-gate-alb-cloud-armor.md), MEM-103..105): live mode,
judges sign in once with a shared access key (cookie), traffic enters only through a global HTTPS load balancer with
Cloud Armor. Order: 1, 2, 2a, 3, 4 (`MODE=meta`), 5 (edge, then redeploy with `EDGE_HOST`), 6 (verify), 7 (key to
judges). Steps 8-9 are rotation and the kill switch. PowerShell form of an env-prefixed command (`MODE=meta sh ...`):
`$env:MODE='meta'; sh scripts/deploy_cloud_run.sh`, then `Remove-Item Env:MODE`.

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
call budget resets on every restart; the Meta spend cap (MEM-094, default $135) survives restarts only through the
Firestore counter (MEM-136, step 2a). Also:

- Meta spend alert: in the Meta developer console, set a spend alert on the account that owns `meta-api-key` (Meta's
  limit only notifies; it does not stop calls).
- Kill switch: step 9.

## 2a. Meta spend counter (Firestore, once)

A `MODE=meta` deploy keeps the spend estimate in Firestore doc `memripal/meta-spend` (ADR
[0081](../decisions/0081-central-meta-spend-counter-firestore.md), MEM-136). Until the doc is seeded, and whenever
Firestore is unreachable, every Meta call is refused (chat uses the backup provider, the rest serves saved results).

1. Enable the API: `gcloud services enable firestore.googleapis.com`
2. Create the default Native-mode database in the Cloud Run region (regional `us-central1`, same as `REGION`; the
   `nam5` multi-region also works but adds nothing here). The location is permanent:

```bash
gcloud firestore databases create --location=us-central1
```

3. Seed with the current Meta spend from the Meta dashboard, using Kev's own ADC (the script sets
   `spent_usd = max(existing, N)`, never lowers it; `--doc`, `--project` optional):

```bash
gcloud auth application-default login
```

```bash
python scripts/seed_meta_spend.py --usd <current spend>
```

4. Deploy (step 4): the script sets `MEMRIPAL_META_SPEND_STORE=firestore` and grants the runtime service account
   `roles/datastore.user`.
5. Verify: console > Firestore > Data shows `memripal/meta-spend` with `spent_usd`; after a live call it has grown.

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

1. Create the three secrets from the repo root: `sh scripts/create_secrets.sh` (in Kev's PowerShell `sh` is Git's
   sh.exe; plain `bash` there is WSL and cannot open C:/ paths, so use `"C:/Program Files/Git/bin/bash.exe"` if needed;
   Cloud Shell: `bash scripts/create_secrets.sh`). `memripal-access-key` and `memripal-record-key` are generated only
   if missing, never rotated; the access key prints once on creation (copy it for step 7), the record key never.
   `meta-api-key` comes from `~/.secrets/meta-api-key.dpapi` (override `MEMRIPAL_META_KEY_FILE`, decrypted via
   `powershell -NoProfile`) or `META_API_KEY` if set, else a hidden prompt on a terminal (no terminal -> non-zero
   exit); an existing one gets a new version, never printed. Values carry no trailing newline. Project: `GCP_PROJECT`,
   default gcloud config project; the script adds the gcloud SDK bin dir to PATH under Git Bash on Windows.
   SUPERSEDED: the typed `gcloud secrets create <name> --data-file=-` flow and the run_live.ps1 wrapper; `memripal-passcode` is no longer needed.
2. Push the other DPAPI-held API keys (never typed). In PowerShell from the repo root:

   ```powershell
   ./scripts/push_secret_gcp.ps1 baseten-api-key
   ```

   The script decrypts `~/.secrets/<name>.dpapi` and pipes the key byte-exact (no trailing newline) to
   `gcloud secrets versions add` (secret exists) or `gcloud secrets create` (it doesn't), then prints `pushed <name>`.
   The app does not strip these keys, so a typed value's trailing newline would break auth (MEM-111). Names allowed:
   `meta-api-key`, `baseten-api-key`, `fireworks-api-key` (step 1 already covers `meta-api-key`).
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

Open-weights Spark: push secret `baseten-api-key` (step 3.2 script) and a `MODE=meta` deploy also sets
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
in, so the cost cap is the Firestore Meta spend cap (step 2a) plus `MEMRIPAL_CALL_BUDGET` (300 live calls, whole-service with
`--max-instances=1`); rotate the key after judging (section 8).

## 8. Rotation

Rotating the access key signs every judge out at once (old cookies stop validating), so do it deliberately, then
update the key in the Project Description.

1. Access key: `gcloud secrets versions add memripal-access-key --data-file=-` (manual; the script never rotates it).
   Meta key: rerun `sh scripts/create_secrets.sh` (adds a version).
2. Redeploy with the same env as step 5.2 so new instances read `:latest`.

The same two steps rotate any other secret; for a DPAPI-held key, re-encrypt the local file and rerun its step 3.2
script instead of step 1.

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

## 9a. Pause / resume

Take the app offline between demos without a redeploy (MEM-147, ADR 0089). `status` is read-only and prints
`ingress: <value>` and `rule: present|absent`; a missing or unknown command exits 2 with usage. Env: `REGION`
(default `us-central1`), `SERVICE` (default `memripal`).

```bash
sh scripts/gcp_app.sh stop
sh scripts/gcp_app.sh start
sh scripts/gcp_app.sh status
```

`stop` runs (the delete only if the rule exists; the sslip.io host goes down):

```bash
gcloud run services update memripal --region us-central1 --ingress=internal
gcloud compute forwarding-rules delete memripal-https-rule --global --quiet
```

`start` first checks `gcloud compute addresses describe memripal-edge-ip --global` and
`gcloud compute target-https-proxies describe memripal-https-proxy`; if either is missing it exits 1 naming
`scripts/deploy_edge_gcp.sh` (step 5). Otherwise it runs (the create only if the rule is absent; ~1 min to serve):

```bash
gcloud compute forwarding-rules create memripal-https-rule --global --load-balancing-scheme=EXTERNAL_MANAGED --address=memripal-edge-ip --target-https-proxy=memripal-https-proxy --ports=443
gcloud run services update memripal --region us-central1 --ingress=internal-and-cloud-load-balancing
```

Kept across a pause: the reserved IP `memripal-edge-ip` (so the sslip.io host and the managed cert `memripal-cert`
stay valid), HTTPS proxy, URL map, backend service + serverless NEG, Cloud Armor policy, and the service's env vars
and secrets. While paused only the IP and the Armor policy bill.

## 10. Cost check

Do not delete the service: the deployed URL is a submission input. Scaled to zero it has no idle cost. Check spend in
the console under Billing > Reports (filter: Cloud Run, Secret Manager, Cloud Build, Networking, Cloud Armor); budget
alerts from step 2 email the billing admins. The edge (step 5) bills while it exists, idle or not: about $12-13 for
two weeks (ADR 0056 option (f)).
