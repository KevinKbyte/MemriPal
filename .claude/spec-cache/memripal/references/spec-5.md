# MemriPal spec (continuation)

Continuation of [spec-4.md](spec-4.md), which is over its 500-line cap.

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

## MEM-095 Pal's first-run tour

Kev ask 2026-11-01: first-run tutorial, skippable, persisted; item-20 story (history intro, Royal Shopping List demo,
nested mnemonics, whole cart in one locus). Approved 2026-11-03 from preview `docs/design/tutorial/` (079b762).
Root problem: a first-time visitor (a judge) lands on the map shell with no idea what a memory palace is or where to
start; Pal explains the method and points at the four places that matter, once, and gets out of the way.
Actors: `static/tour.js` (new: `TOUR_KEY`, `STEPS`, `wireTour(doc, store)`), `static/index.html` (#tour dialog,
#tour-toast), `static/tour.css` (ported from `docs/design/tutorial/tutorial.css`), `static/app.js` bootstrap.
NFR: no new dependency; no innerHTML (all step text and figures via textContent/createElement); ASCII-only source
(non-ASCII glyphs as `\u`/`String.fromCodePoint` escapes); no network.
- Seam: `wireTour(doc, store)`, `store = { getItem, setItem }`; app.js passes lazy localStorage wrappers like
  `wireUpload`'s place store (`static/app.js:385-387`). Called from the bootstrap beside `initTabbar`, not via
  wireApp, so wireApp tests are untouched.
- `TOUR_KEY` = `"memripal.tour.done"`. On wire: `store.getItem(TOUR_KEY)` null/undefined -> tour opens at step 1;
  any stored value -> stays hidden. `getItem` throwing -> tour stays hidden (storage disabled must not nag every load).
- `STEPS`: the 10 steps of `docs/design/tutorial/preview.js` STEPS, same order, titles, bodies, `after` closers, `fig`
  rows (spot, icon, item, done, faded, sub) and button labels. Steps 1, 7-10 spotlight `target` (null welcome;
  `.tab[href="#routes"]`, `.drawer-handle`, `.tab[href="#recall"]`, `.tab[href="#settings"]`); steps 2-6 are
  `story` cards with the #tour-fig locus list. Missing target element -> centred card, no cut-out.
- Count "N of 10" and one dot per step, built from `STEPS.length`. Back hidden on step 1. Next advances; on step 10
  ("Let's go") the tour closes with no toast.
- Close paths: Skip button and Escape close and show #tour-toast ("Tour skipped. Replay it any time in Settings.",
  role=status, auto-hides after 4 s); finishing closes silently. Every close calls `store.setItem(TOUR_KEY, "1")`;
  `setItem` throwing still closes.
- Dialog: role=dialog, aria-modal=true, aria-labelledby=tour-title; Next takes focus on each step; Tab/Shift+Tab cycle
  only the card's visible buttons while open. Spotlight re-places on resize.
- Accept: empty store -> #tour visible, step 1 title "Hi! I'm King Memri."; stored "1" -> hidden; getItem throws ->
  hidden; Next x9 reaches step 10 with 10 dots; step 5 fig shows the cart with 5 sub rows; Next on step 10 -> hidden,
  toast hidden, store has "1"; Skip -> hidden, toast shown, store has "1"; Escape same as Skip; setItem throws ->
  still hidden; a step body containing `<b>` renders as text; real-browser screenshot of step 1 and step 5.

Tests: static/tour.test.mjs

## MEM-097 Replay Pal's tour from Settings

Amends MEM-095. Actors: `static/index.html` (#tab-settings gains a "Pal's tour" panel with button #tour-replay),
`static/tour.js`.
- #tour-replay click: switch to the routes tab (`showTab("routes")`, `static/tabbar.js`), hide any toast, open the
  tour at step 1, regardless of `TOUR_KEY`. Closing it again behaves as MEM-095 (stores "1").
- Accept: stored "1", click #tour-replay -> #tour visible at step 1, #tab-routes shown, #tab-settings hidden;
  Skip after replay -> hidden again.

Tests: static/tour.test.mjs
