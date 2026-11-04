# MemriPal spec (continuation)

Continuation of [spec-4.md](spec-4.md), which is over its 500-line cap.

## MEM-102 Paper Crown theme

`static/theme-painterly.css`, `static/fonts/`, `docs/design/paper-crown/`.
Decided-by: ADR-0059
Root problem: the painterly theme read as generic; the demo needs a distinct storybook look (direction A "Paper Crown"
plus direction C's lantern stations) without breaking MEM-044's CSP, contrast and layout guarantees.
Actors: browser (renders the theme); `static/theme-painterly.css` (last stylesheet, MEM-044 P1).
NFR: CSP-clean (`font-src 'self'`); no remote fonts; all MEM-044 P-checks still hold except P3 as amended here.
- Fonts: Fraunces (display) and Nunito (body) self-hosted as `/static/fonts/fraunces.woff2` and
  `/static/fonts/nunito.woff2`, each with its OFL licence text (`OFL-fraunces.txt`, `OFL-nunito.txt`) beside it;
  `@font-face` only in the theme, `src` url under `/static/fonts/`, `font-display: swap`.
- Type: the theme sets `--display` (Fraunces first) and `--body` (Nunito first, not a serif); `.brand`, `h2`, `h3`,
  `.map-chip` use `var(--display)`; theme `font-family` values are `var(--display)` or `var(--body)` only.
- Tokens: adds `--on-lamp` and `--glow`, declared under all 3 MEM-044 A1 selectors and each read by a rule (0 dead).
- Gold (`--lamp`) only marks recalled state: `.live-board li.lit` background `var(--lamp)` with ink `var(--on-lamp)`
  and a `var(--glow)` box-shadow; `.route-node.lit` fills gold with a `var(--on-lamp)` stroke.
- Crown edge: `.topbar::after` draws the crown strip; said-vs-palace cards label rows with check / cross glyphs.
- Reset media block (`forced-colors: active`, `prefers-contrast: more`, `print`) drops the crown edge (`.topbar::after` background) and the
  lantern glow (`.live-board li.lit` box-shadow).
- Accept: 2 woff2 + 2 OFL files exist; every `@font-face` src under `/static/fonts/`; `--on-lamp`/`--glow` in all 3
  token blocks and read by a rule; `li.lit` background `var(--lamp)`; reset block clears both; all 17 contrast pairs
  AA in light and dark; theme/layout/style_v6 tests green.

Tests: static/theme_painterly.test.mjs, static/layout.test.mjs

## MEM-103 Judges-only access gate

Amends MEM-034 passcode gate (spec-2.md, ADR 0025): a valid access cookie
satisfies `_passcode_error`, checked before its passcode-unset branch.
Decided-by: ADR-0056
Root problem: the live (paid) deploy must admit only judges, who share one key delivered out of band; the passcode
header is per-session UI friction and fails open on a client-controlled loopback Host.
Actors: judges (browser); `src/memripal/app.py` (`AccessGate`, `_passcode_error`), `src/memripal/ratelimit.py`,
`src/memripal/security_headers.py`, `static/access.html`, `static/index.html`, `static/public_banner.js`.
NFR: no new dependency (no python-multipart); key never logged or read from the query string; ASCII only.
- Key: `MEMRIPAL_ACCESS_KEY`, `strip()`ped (Secret Manager values end in a newline). Pure ASGI; non-`http` scopes
  pass through. Order: inside SecurityHeaders and TrustedHost, outside ApiGuard and the body cap.
- Cookie `memripal_access` = hex HMAC-SHA256(key, "memripal-access-v1"), `hmac.compare_digest`.
- Exempt (exact paths, never prefix): GET `/healthz`; GET and POST `/access`; `/static/manifest.webmanifest`,
  `/static/icon.svg`, the manifest's icons, `/static/style.css`. `/static/map/**`, `/static/vendor/**` and all else
  gated.
- No/invalid cookie: GET with Accept containing `text/html` -> 303 Location `/access`; else 401
  `{"error":"access_required"}`. Gate and `/access` responses carry `Cache-Control: no-store`.
- GET `/access`: no-JS form, `method=post action=/access`, one password field `key`.
- POST `/access`: urlencoded body read in the gate via `urllib.parse.parse_qs`, <= 1024 bytes (413 past it). Own
  per-IP SlidingWindow lockout: `MEMRIPAL_ACCESS_MAX_FAILS` (default 20) per `MEMRIPAL_LOCKOUT_S` -> 429
  `too_many_attempts` + Retry-After; `/access` in `LIMITED_ROUTES`. Right key -> Set-Cookie `HttpOnly; Secure;
  SameSite=Lax; Path=/; Max-Age=1209600`, 303 Location `/`. Wrong key -> 401, form re-shown with an error, fail
  recorded.
- CSRF: a POST other than `/access` with `Sec-Fetch-Site` present and not `same-origin` -> 403
  `{"error":"cross_site"}`.
- Key unset: open only when `K_SERVICE` is unset; on Cloud Run every non-exempt path -> 503
  `{"error":"access_unconfigured"}`. Never decided on the Host header.
- CSP `form-action 'self'` (was `'none'`). `/healthz` adds `"gated": true|false`; when gated the UI hides the
  passcode box and rewords the "live needs passcode" banner; requests still work with an empty box.
- Accept: no cookie GET html -> 303 `/access`, fetch -> 401 JSON; key env with trailing `\n` + bare key -> cookie set;
  wrong key 401 and lockout 429 after the limit; `?key=` ignored; 1025-byte body 413; `/static/map/...` gated;
  `/accessX` gated; cross-site POST 403; `K_SERVICE` set + no key -> 503; live mode + cookie + no
  `MEMRIPAL_PASSCODE` -> allowed; `/access` CSP has `form-action 'self'`; real-browser login screenshot.

Tests: tests/test_access_gate.py

## MEM-104 Deploy script: live mode, secret mapping, edge-aware ingress

Amends MEM-034 (`scripts/deploy_cloud_run.sh`).
Decided-by: ADR-0056
Root problem: mode and secrets were hardcoded (fixture, passcode), the runtime service account was never granted
optional secrets, and the edge switch (ingress, host, proxy hops) must happen in one deploy or the app is briefly
open or mis-keyed.
Actors: Kev (runs it); `scripts/deploy_cloud_run.sh`, gcloud, Secret Manager.
NFR: POSIX sh; never reads a secret value; keeps the `META_API_KEY=""` precommit_scan trick.
- `MODE` = `fixture` (default) | `meta`, else exit nonzero; drives `MEMRIPAL_MODE` and the secret list.
- `--set-secrets` (replace-all): always `MEMRIPAL_ACCESS_KEY=memripal-access-key:latest`,
  `MEMRIPAL_RECORD_KEY=memripal-record-key:latest`; `META_API_KEY` from `meta-api-key:latest` iff `MODE=meta`;
  `MEMRIPAL_PASSCODE` no longer mapped. `BASETEN_API_KEY`, `FIREWORKS_API_KEY`, `MODAL_SEG_TOKEN`,
  `MEMRIPAL_MAPILLARY_TOKEN` mapped iff `gcloud secrets describe` finds the secret.
- Each mapped secret: `gcloud secrets add-iam-policy-binding` `roles/secretmanager.secretAccessor` for the runtime
  service account, before the deploy.
- `EDGE_HOST` set: `--ingress internal-and-cloud-load-balancing`, `EDGE_HOST` added to `MEMRIPAL_ALLOWED_HOSTS`,
  `MEMRIPAL_TRUSTED_PROXY_HOPS=2`, all in the same deploy. Unset: ingress all, hops default.
- Kept: `--max-instances=1`, `--concurrency`, `--timeout`, `--allow-unauthenticated`.
- Accept: `MODE=bogus` exits nonzero before gcloud; `MODE=meta` maps `META_API_KEY`, fixture does not; no
  `MEMRIPAL_PASSCODE` in the secret list; an absent optional secret is unmapped; one accessor grant per mapped secret;
  `EDGE_HOST` adds ingress, host and hops to one deploy command.

Tests: tests/test_deploy_scripts.py, tests/test_deploy_artifacts.py

## MEM-105 Edge: global HTTPS ALB + Cloud Armor, trusted proxy hops

`scripts/deploy_edge_gcp.sh`.
Decided-by: ADR-0056
Root problem: with `--max-instances=1`, L7 floods reaching Cloud Run starve judges; abusive IPs must be dropped at
the edge, the `run.app` URL closed, and the app must still rate-limit the real client, not the LB.
Actors: Kev (runs it); `scripts/deploy_edge_gcp.sh`, `src/memripal/ratelimit.py` (`client_ip`), gcloud
(compute, Cloud Armor, certificate).
NFR: POSIX sh, idempotent (describe-or-create per resource); never reads secrets; same `GCP_PROJECT` / `REGION` /
`SERVICE` env as `scripts/deploy_cloud_run.sh`.
- `client_ip` with trust_xff: `MEMRIPAL_TRUSTED_PROXY_HOPS` (int >= 1, default 1; invalid or < 1 -> 1) picks
  `entries[-hops]` if `len(entries) >= hops` else `entries[0]`.
- Resources: global static IP; host `<ip, dots -> dashes>.sslip.io`; serverless NEG -> the Cloud Run service; backend
  service with the Armor policy; URL map; Google-managed cert for the host; target HTTPS proxy; global forwarding
  rule `:443`.
- Armor Standard policy: rate-based ban keyed on IP (e.g. 120 req / 60 s -> ban 600 s, env-tunable); preconfigured
  WAF sqli + xss at sensitivity 1; default allow.
- Output: the host and the cert status command.
- Accept: hops unset -> rightmost entry; hops 2 with 3 entries -> second from right; hops 3 with 1 entry ->
  `entries[0]`; hops "0"/"x" -> 1; a second script run creates nothing; runbook check: wrong key 5x from network A
  does not lock out network B.

Tests: tests/test_proxy_hops.py, tests/test_deploy_scripts.py
