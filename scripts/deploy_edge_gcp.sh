#!/bin/sh
# Build the judges-only edge in front of Cloud Run (MEM-105; ADR 0055; docs/runbooks/deploy-gcp.md):
# global static IP -> HTTPS forwarding rule :443 -> target proxy (managed cert for <ip>.sslip.io)
# -> URL map -> backend service (Cloud Armor policy) -> serverless NEG -> the Cloud Run service.
# Idempotent: every resource is described first and created only when missing. Never reads secrets.
# Afterwards redeploy with EDGE_HOST=<printed host> sh scripts/deploy_cloud_run.sh to lock ingress.
#
# Usage: sh scripts/deploy_edge_gcp.sh
# Env: GCP_PROJECT (default: gcloud config project), REGION (default us-central1),
#      SERVICE (default memripal), RATE_LIMIT_COUNT (default 120), RATE_LIMIT_INTERVAL_SEC
#      (default 60), BAN_DURATION_SEC (default 600).
set -eu

PROJECT="${GCP_PROJECT:-$(gcloud config get-value project)}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-memripal}"
RATE_LIMIT_COUNT="${RATE_LIMIT_COUNT:-120}"
RATE_LIMIT_INTERVAL_SEC="${RATE_LIMIT_INTERVAL_SEC:-60}"
BAN_DURATION_SEC="${BAN_DURATION_SEC:-600}"

IP_NAME="${SERVICE}-edge-ip"
NEG="${SERVICE}-neg"
BACKEND="${SERVICE}-backend"
POLICY="${SERVICE}-armor"
URL_MAP="${SERVICE}-url-map"
CERT="${SERVICE}-cert"
PROXY="${SERVICE}-https-proxy"
FWD_RULE="${SERVICE}-https-rule"

# exists <gcloud describe args...>: true when the resource is already there.
exists() {
  gcloud "$@" --project "$PROJECT" >/dev/null 2>&1
}

if ! exists run services describe "$SERVICE" --region "$REGION"; then
  echo "Cloud Run service $SERVICE not found in $REGION; run scripts/deploy_cloud_run.sh first" >&2
  exit 1
fi

exists compute addresses describe "$IP_NAME" --global ||
  gcloud compute addresses create "$IP_NAME" --global --ip-version=IPV4 --project "$PROJECT"
IP="$(gcloud compute addresses describe "$IP_NAME" --global --format='value(address)' --project "$PROJECT")"
HOST="$(printf '%s' "$IP" | tr '.' '-').sslip.io"

exists compute network-endpoint-groups describe "$NEG" --region "$REGION" ||
  gcloud compute network-endpoint-groups create "$NEG" \
    --region "$REGION" \
    --network-endpoint-type=serverless \
    --cloud-run-service="$SERVICE" \
    --project "$PROJECT"

# Lower priority numbers are evaluated first and the first match wins, so the WAF deny rules sit
# ahead of the rate-based ban (whose conform action is allow). Sensitivity 1 keeps false positives
# on free-text notes low.
exists compute security-policies describe "$POLICY" ||
  gcloud compute security-policies create "$POLICY" \
    --description="MemriPal edge: WAF sqli/xss + per-IP rate-based ban" \
    --project "$PROJECT"
exists compute security-policies rules describe 1000 --security-policy="$POLICY" ||
  gcloud compute security-policies rules create 1000 \
    --security-policy="$POLICY" \
    --expression="evaluatePreconfiguredWaf('sqli-v33-stable', {'sensitivity': 1})" \
    --action=deny-403 \
    --project "$PROJECT"
exists compute security-policies rules describe 1001 --security-policy="$POLICY" ||
  gcloud compute security-policies rules create 1001 \
    --security-policy="$POLICY" \
    --expression="evaluatePreconfiguredWaf('xss-v33-stable', {'sensitivity': 1})" \
    --action=deny-403 \
    --project "$PROJECT"
exists compute security-policies rules describe 2000 --security-policy="$POLICY" ||
  gcloud compute security-policies rules create 2000 \
    --security-policy="$POLICY" \
    --src-ip-ranges='*' \
    --action=rate-based-ban \
    --rate-limit-threshold-count="$RATE_LIMIT_COUNT" \
    --rate-limit-threshold-interval-sec="$RATE_LIMIT_INTERVAL_SEC" \
    --ban-duration-sec="$BAN_DURATION_SEC" \
    --conform-action=allow \
    --exceed-action=deny-429 \
    --enforce-on-key=IP \
    --project "$PROJECT"

exists compute backend-services describe "$BACKEND" --global ||
  gcloud compute backend-services create "$BACKEND" \
    --global \
    --load-balancing-scheme=EXTERNAL_MANAGED \
    --project "$PROJECT"
# Checked separately from creation so a run interrupted between create and add-backend heals.
if [ -z "$(gcloud compute backend-services describe "$BACKEND" --global --format='value(backends)' --project "$PROJECT")" ]; then
  gcloud compute backend-services add-backend "$BACKEND" \
    --global \
    --network-endpoint-group="$NEG" \
    --network-endpoint-group-region="$REGION" \
    --project "$PROJECT"
fi
# Setting the same policy again is a no-op, so this runs every time.
gcloud compute backend-services update "$BACKEND" --global --security-policy="$POLICY" --project "$PROJECT"

exists compute url-maps describe "$URL_MAP" --global ||
  gcloud compute url-maps create "$URL_MAP" --global --default-service="$BACKEND" --project "$PROJECT"

exists compute ssl-certificates describe "$CERT" --global ||
  gcloud compute ssl-certificates create "$CERT" --global --domains="$HOST" --project "$PROJECT"

exists compute target-https-proxies describe "$PROXY" --global ||
  gcloud compute target-https-proxies create "$PROXY" \
    --global \
    --url-map="$URL_MAP" \
    --ssl-certificates="$CERT" \
    --project "$PROJECT"

exists compute forwarding-rules describe "$FWD_RULE" --global ||
  gcloud compute forwarding-rules create "$FWD_RULE" \
    --global \
    --load-balancing-scheme=EXTERNAL_MANAGED \
    --address="$IP_NAME" \
    --target-https-proxy="$PROXY" \
    --ports=443 \
    --project "$PROJECT"

echo "Edge host: $HOST (https://$HOST)"
echo "Cert status (ACTIVE can take 15-60 min): gcloud compute ssl-certificates describe $CERT --global --project $PROJECT --format='value(managed.status)'"
echo "Next: MODE=meta EDGE_HOST=$HOST sh scripts/deploy_cloud_run.sh"
