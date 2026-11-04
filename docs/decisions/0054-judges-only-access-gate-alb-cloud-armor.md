# 0054: Judges-only access: app key gate (signed cookie) behind a global HTTPS ALB + Cloud Armor, live mode

Status: Accepted
Amends: [0004](0004-public-deploy-spend-guard.md) (the judged deploy runs live; the gate, not fixture mode, keeps
strangers off paid routes), [0025](0025-passcode-gate-and-host-allowlist.md) (a valid access cookie satisfies the
passcode check; the deploy stops mapping `MEMRIPAL_PASSCODE`; fail-open keys on `K_SERVICE`, not the Host header),
[0028](0028-palace-backup-export-import.md) (CSP `form-action 'none'` -> `'self'`). Relates:
[0010](0010-cloud-run-hosting.md) (hosting), [0027](0027-signed-association-records.md) (`MEMRIPAL_RECORD_KEY`),
[0032](0032-capacitor-android-shell.md) (shell out of scope), MEM-100 / MEM-101 / MEM-102, runbook
[deploy-gcp](../runbooks/deploy-gcp.md).
Date: 2026-11-03
Source: Kev, 2026-11-03: deploy mode = Meta LIVE; edge = global external HTTPS ALB + Cloud Armor Standard as a
checked-in gcloud script (no console clicks); the app access-key gate ships too (Armor cannot do password auth).
Decided after an adversarial pass; its two vetoes and its Host-header, hop-count, static-allowlist, newline and shell findings are adopted below;
its "no LB" verdict is not.

## Context

Judges must reach the live (paid Meta) app for two weeks; nobody else should. Constraints:

- The service is public `--allow-unauthenticated` on `*.run.app` with `--max-instances=1`, `--concurrency=20`
  (`scripts/deploy_cloud_run.sh`). A flood of even cheap 401s competes with judges for that one instance.
- The live spend guard is `MEMRIPAL_CALL_BUDGET=300` held in process memory (0004): every cold start or OOM restart
  resets it, so it is not a spend cap. The persistent cap (MEM-094) has not landed.
- The passcode (0025) is an `X-Memripal-Passcode` header typed into the UI per session; when unset it fails open for
  loopback Host values, which a client controls behind an LB default route.
- CSP `form-action 'none'` is set by the outermost middleware, so a no-JS login form cannot submit.
- python-multipart is not installed, so FastAPI `Form()` would crash app startup.
- Judge identities (emails) are unknown; the key is delivered once in the private judges-notes field.

## Options considered

- (a) Identity-Aware Proxy.
  Pros: Google-run auth, per-user identity and revocation; no app code.
  Cons: every judge needs a Google account granted by email ahead of time, and judge identities are unknown; one
  shared key cannot be handed out.
- (b) HTTP Basic auth in the app.
  Pros: no login page, no cookie code.
  Cons: native browser prompt is poor on mobile and has no logout; the credential rides every request; the web
  manifest is fetched without credentials and fails.
- (c) Key in the URL (`?key=`).
  Pros: one link, zero typing.
  Cons: the key leaks through history, Referer, shared screenshots and request logs.
- (d) Cloud Armor rule matching a secret header.
  Pros: rejected at the edge, no app code.
  Cons: a browser cannot add a custom header to a navigation, so it only gates API clients; Armor cannot do password
  auth.
- (e) App gate alone on direct `run.app` ingress (the adversary's recommendation).
  Pros: cheapest; no cert-provisioning risk; the Host-header and XFF-hop bugs stay latent; Google's front end
  already absorbs L3/L4 floods.
  Cons: every L7 flood request reaches the single instance and takes CPU and concurrency from judges; no IP ban, no
  WAF; the public `run.app` URL stays the attack surface.
- (f) App gate plus a global external HTTPS ALB with Cloud Armor Standard, ingress closed to the LB (chosen).
  Pros: rate-based IP bans and WAF signatures drop abusive traffic before Cloud Run, keeping the one instance free
  for judges; `--ingress internal-and-cloud-load-balancing` refuses the `run.app` URL; the app gate still does the
  password auth Armor cannot; all edge resources come from one idempotent checked-in script.
  Cons: about $12-13 for two weeks (ALB forwarding rule ~$18.25/mo; Armor ~$5/policy/mo + ~$1/rule/mo + $0.75 per
  million requests evaluated), and Armor bills per flood request more than Cloud Run does, so it adds a meter rather
  than lowering flood cost; the Google-managed cert for an sslip.io host can stall; WAF signatures can false-positive
  on free-text notes; the XFF hop count and the loopback-Host fail-open become live bugs unless fixed in the same
  change.

## Decision

Option (f), live mode (`MODE=meta`).

- App gate (MEM-100): pure-ASGI `AccessGate`, key from `MEMRIPAL_ACCESS_KEY` (stripped). Cookie `memripal_access` =
  hex HMAC-SHA256(key, "memripal-access-v1"), constant-time compared, `HttpOnly; Secure; SameSite=Lax`, 14 days.
  No-JS form at `/access` parsed in the gate (no `Form()`), per-IP lockout of its own; the key is never read from
  the query string. Exact-path exemptions only (`/healthz`, `/access`, the manifest, icons and stylesheet that page
  needs). A Cloud Run instance (`K_SERVICE` set) without a key refuses everything (503); fail-open only off Cloud Run.
  A valid cookie satisfies the passcode check. Cross-site POSTs (`Sec-Fetch-Site` present and not `same-origin`) get
  403. CSP becomes `form-action 'self'`.
- Deploy (MEM-101): `MODE` drives `MEMRIPAL_MODE` and the secret list; `MEMRIPAL_PASSCODE` is no longer mapped;
  `secretAccessor` granted per mapped secret; with `EDGE_HOST` set, one deploy sets LB-only ingress, adds the host
  to `MEMRIPAL_ALLOWED_HOSTS` and sets `MEMRIPAL_TRUSTED_PROXY_HOPS=2`.
- Edge (MEM-102): static IP, `<ip-dashed>.sslip.io` host, serverless NEG, backend service with the Armor policy
  (rate-based IP ban, preconfigured sqli + xss WAF at sensitivity 1, default allow), URL map, managed cert, HTTPS
  proxy, `:443` forwarding rule. Rate-limit client IP = Nth-from-right XFF entry per `MEMRIPAL_TRUSTED_PROXY_HOPS`.

## Why this over the others

(a) cannot serve judges whose identities are unknown; (b) breaks on mobile and on the manifest; (c) leaks the key;
(d) cannot gate a browser. Between (e) and (f), the threat that matters during judging is availability: with
`--max-instances=1` a flood that never touches a paid route still starves judges, and only (f) drops it before the
instance. Kev took the adversary's cost point (Armor adds a meter) and paid it for edge bans plus a closed `run.app`
URL. The adversary's fail-closed `K_SERVICE` rule and numeric hop count are what make (f) safe; both ship in the same
change. The app gate stays in either case because no edge option does password auth.

## Consequences

- Residual: the call budget still resets per restart and MEM-094 is unlanded. Backstop: a spend alert in the Meta
  console; kill switch: redeploy with `MODE=fixture` (zero Meta spend).
- Residual: the sslip.io managed cert may stay `PROVISIONING` or fail (`FAILED_NOT_VISIBLE`,
  `FAILED_RATE_LIMITED`); fallback is a self-signed cert on the same proxy (judges click through a warning).
- Residual: WAF false positives on free-text notes surface as opaque 403s; sensitivity 1 keeps them rare, and the
  fix is to drop the offending rule, not the gate.
- Residual: a wrong hop count collapses every client into one rate-limit bucket; the runbook verifies it once
  (wrong key 5x from network A must not lock out network B).
- Out of scope: the Capacitor shell (0032). Its origin is cross-site, so the `SameSite=Lax` cookie is never sent and
  LB-only ingress makes its `run.app` API base unreachable; it fails visibly on the 401 JSON.
- Rotation: add a secret version and redeploy; the new key yields a new HMAC, so every old cookie dies at once.
- The UI hides the passcode box and rewords the "live needs passcode" banner when `/healthz` reports `"gated": true`.
