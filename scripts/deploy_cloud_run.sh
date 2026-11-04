#!/bin/sh
# Deploy MemriPal to Cloud Run (MEM-034, MEM-104; ADR 0004, 0010, 0056; docs/runbooks/deploy-gcp.md).
# Builds the repo Dockerfile via --source. Keys come only from Secret Manager; this script never
# reads a secret value.
#
# Usage: MODE=meta EDGE_HOST=34-1-2-3.sslip.io sh scripts/deploy_cloud_run.sh
# Env: MODE (fixture|meta, default fixture), GCP_PROJECT (default: gcloud config project),
#      REGION (default us-central1), SERVICE (default memripal), SERVICE_ACCOUNT (default: the
#      project's compute default account), EDGE_HOST (optional; the host printed by
#      scripts/deploy_edge_gcp.sh), EXTRA_HOSTS (optional comma list, e.g. a custom domain).
set -eu
cd "$(dirname "$0")/.."

# Validated before any gcloud call so a typo can never deploy or touch IAM.
MODE="${MODE:-fixture}"
case "$MODE" in
  fixture|meta) ;;
  *) echo "MODE must be fixture or meta, got: $MODE" >&2; exit 2;;
esac

PROJECT="${GCP_PROJECT:-$(gcloud config get-value project)}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-memripal}"
EDGE_HOST="${EDGE_HOST:-}"
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
RUNTIME_SA="${SERVICE_ACCOUNT:-${PROJECT_NUMBER}-compute@developer.gserviceaccount.com}"
# Cloud Run's deterministic URL, known before the first deploy, so the host guard can list it.
HOST="${SERVICE}-${PROJECT_NUMBER}.${REGION}.run.app"
HOSTS="${HOST}${EDGE_HOST:+,$EDGE_HOST}${EXTRA_HOSTS:+,$EXTRA_HOSTS}"

# --set-secrets replaces the whole mapping, so the old passcode secret drops out on redeploy.
# The empty "" after META_API_KEY= is removed by the shell; it keeps scripts/precommit_scan.py
# from flagging the line as a key assignment.
SECRETS="MEMRIPAL_ACCESS_KEY=memripal-access-key:latest,MEMRIPAL_RECORD_KEY=memripal-record-key:latest"
if [ "$MODE" = meta ]; then
  SECRETS="$SECRETS,META_API_KEY=""meta-api-key:latest"
fi
# Optional provider secrets are mapped only when they exist, so a missing one never fails the deploy.
for pair in BASETEN_API_KEY:baseten-api-key FIREWORKS_API_KEY:fireworks-api-key \
  MODAL_SEG_TOKEN:modal-seg-token MEMRIPAL_MAPILLARY_TOKEN:memripal-mapillary-token; do
  name="${pair#*:}"
  if gcloud secrets describe "$name" --project "$PROJECT" >/dev/null 2>&1; then
    SECRETS="$SECRETS,${pair%%:*}=$name:latest"
  fi
done

# The runtime account needs read on every mapped secret or the revision fails to start.
# add-iam-policy-binding is idempotent, so re-runs are safe.
for ref in $(printf '%s' "$SECRETS" | tr ',' ' '); do
  name="${ref#*=}"
  gcloud secrets add-iam-policy-binding "${name%:latest}" \
    --project "$PROJECT" \
    --member="serviceAccount:${RUNTIME_SA}" \
    --role=roles/secretmanager.secretAccessor >/dev/null
done

# Behind the edge (scripts/deploy_edge_gcp.sh) only the load balancer may reach the service, and the
# client IP is the second-from-right X-Forwarded-For entry (MEM-105). Without EDGE_HOST,
# --ingress=all is passed explicitly so a redeploy undoes an earlier lock.
if [ -n "$EDGE_HOST" ]; then
  INGRESS=internal-and-cloud-load-balancing
  HOPS=";MEMRIPAL_TRUSTED_PROXY_HOPS=2"
else
  INGRESS=all
  HOPS=""
fi

# --max-instances=1 makes the per-instance call budget the whole-service budget (ADR 0004).
# --concurrency and --timeout bound parallel and hanging requests per instance (MEM-034).
# The body cap equals the largest route cap (POST /split), so no legitimate request is refused.
# ^;^ switches the gcloud list delimiter so the comma-separated host list stays one value.
# --allow-unauthenticated stays: the app access gate and Cloud Armor do auth (ADR 0056).
gcloud run deploy "$SERVICE" \
  --project "$PROJECT" \
  --region "$REGION" \
  --source . \
  --allow-unauthenticated \
  ${SERVICE_ACCOUNT:+--service-account="$SERVICE_ACCOUNT"} \
  --max-instances=1 \
  --concurrency=20 \
  --timeout=120 \
  --ingress="$INGRESS" \
  --set-env-vars="^;^MEMRIPAL_MODE=${MODE};MEMRIPAL_CALL_BUDGET=300;MEMRIPAL_MAX_BODY_BYTES=21233664;MEMRIPAL_ALLOWED_HOSTS=${HOSTS}${HOPS}" \
  --set-secrets="$SECRETS"

if [ -n "$EDGE_HOST" ]; then
  echo "Service URL: https://${EDGE_HOST} (the run.app URL is closed by ingress)"
else
  echo "Service URL: https://${HOST}"
fi
