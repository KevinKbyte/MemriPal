#!/bin/sh
# MEM-147: pause/resume the GCP app (ADR 0089).
# stop:   lock Cloud Run ingress to internal, then delete the public HTTPS forwarding rule if present.
# start:  recreate the forwarding rule if absent (edge IP + HTTPS proxy must already exist, built by
#         scripts/deploy_edge_gcp.sh), then reopen ingress to the load balancer.
# status: read-only; prints the ingress value and whether the rule exists.
# Never deploys, reads secrets, or changes env vars.
#
# Usage: sh scripts/gcp_app.sh stop|start|status
# Env: REGION (default us-central1), SERVICE (default memripal).
set -eu

REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-memripal}"
IP_NAME="${SERVICE}-edge-ip"
PROXY="${SERVICE}-https-proxy"
FWD_RULE="${SERVICE}-https-rule"

usage() {
  echo "usage: sh scripts/gcp_app.sh stop|start|status" >&2
  exit 2
}

# exists <gcloud describe args...>: true when the resource is already there.
exists() {
  gcloud "$@" >/dev/null 2>&1
}

set_ingress() {
  gcloud run services update "$SERVICE" --region "$REGION" --ingress="$1"
}

[ $# -eq 1 ] || usage

case "$1" in
  stop)
    set_ingress internal
    if exists compute forwarding-rules describe "$FWD_RULE" --global; then
      gcloud compute forwarding-rules delete "$FWD_RULE" --global --quiet
    fi
    ;;
  start)
    if ! exists compute addresses describe "$IP_NAME" --global ||
       ! exists compute target-https-proxies describe "$PROXY"; then
      echo "edge IP $IP_NAME or HTTPS proxy $PROXY missing; run scripts/deploy_edge_gcp.sh first" >&2
      exit 1
    fi
    if ! exists compute forwarding-rules describe "$FWD_RULE" --global; then
      gcloud compute forwarding-rules create "$FWD_RULE" --global \
        --load-balancing-scheme=EXTERNAL_MANAGED --address="$IP_NAME" \
        --target-https-proxy="$PROXY" --ports=443
    fi
    set_ingress internal-and-cloud-load-balancing
    ;;
  status)
    ingress="$(gcloud run services describe "$SERVICE" --region "$REGION" \
      --format='value(metadata.annotations."run.googleapis.com/ingress")')"
    echo "ingress: $ingress"
    if exists compute forwarding-rules describe "$FWD_RULE" --global; then
      echo "rule: present"
    else
      echo "rule: absent"
    fi
    ;;
  *)
    usage
    ;;
esac
