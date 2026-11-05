# 0089: Pause the GCP app by locking ingress and deleting only the forwarding rule

Status: Accepted
Relates: MEM-147, ADR 0056 (edge cost).
Date: 2026-11-04

## Context

The edge (ADR 0056, `scripts/deploy_edge_gcp.sh`) bills while it exists, idle or not, and the only off switch was
a redeploy or tearing the edge down. Kev wants one command to take the app offline between demos and one to bring it
back, without redeploying or touching env/secrets.

## Options considered

- (a) Ingress only: set Cloud Run ingress to `internal`, leave the edge as is.
  Pros: one call; start is instant.
  Cons: the sslip.io host still reaches the load balancer (requests fail at the backend instead of going dark); the
  forwarding rule keeps billing hourly.
- (b) Ingress `internal` + delete the global forwarding rule `memripal-https-rule`; keep everything else (chosen).
  Pros: stops the forwarding-rule billing; keeps the reserved IP `memripal-edge-ip`, so the sslip.io host and the
  Google-managed cert survive; start recreates one rule in ~1 min.
  Cons: the reserved IP and Cloud Armor policy still bill while paused; start depends on the IP and proxy still
  existing (refuses and points at `scripts/deploy_edge_gcp.sh` otherwise).
- (c) Delete the whole edge (IP, cert, proxy, URL map, backend, NEG, Armor, rule).
  Pros: cheapest while paused.
  Cons: start needs a full edge redeploy and a new IP, so a new sslip.io host and a cert reprovision (up to ~60 min,
  sslip.io rate-limit risk); the demo URL changes.

## Decision

(b).

## Why this over the others

(a) leaves the hourly forwarding-rule charge running and the host half-alive. (c) saves a little more but turns every
resume into an up-to-an-hour cert wait and a new URL. (b) removes the hourly rule charge while keeping the one thing
that is slow to rebuild: the IP the cert is bound to.

## Consequences

- `scripts/gcp_app.sh stop|start|status`; idempotent; never deploys, reads secrets, or changes env vars.
- Paused cost: reserved IP + Cloud Armor policy only.
- If the IP or proxy is ever deleted, `start` exits 1 and the operator reruns `scripts/deploy_edge_gcp.sh`.
