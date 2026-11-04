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

## MEM-106 Spark chat falls back to Meta; breaker, logging, provider bounds

Amends MEM-026 (spec-2.md, ADR 0023): a provider failure on Spark chat no longer fails the call.
Decided-by: ADR-0058
Root problem: with `MEMRIPAL_CHAT_PROVIDER` set (judged deploy: `baseten`, `meta-models/muse-spark-open-1026`), a
provider error, timeout or schema-invalid reply failed the judge's request, and a dead provider cost a full timeout
on every call.
Actors: judges (any Spark route); `src/memripal/backend.py` (`MetaBackend.call`, `_call_once`, `CHAT_SKIP_S`),
`src/memripal/chat_provider.py` (`PROVIDER_TIMEOUT`, `PROVIDER_RETRIES`), `src/memripal/app.py`
(`_ensure_log_handler`, `_BudgetedBackend`), `scripts/deploy_cloud_run.sh`.
NFR: no key, exception message or response body in any log line or error; no new dependency; ASCII only.
- `spark_json` only: `MetaBackend.call` wraps one whole `_call_once(req, chat)`; any `BackendCallFailed` (incl.
  `BackendTimeout`, `BackendReplyInvalid`) -> one retry on Meta (Meta client, model, key), answer cached under the
  Meta request key. Provider answer -> no Meta call. Meta also fails -> `BackendCallFailed` as before. Segment and
  image_edit never fall back or touch the provider.
- Breaker: a provider failure sets skip-until = now + `CHAT_SKIP_S` (120 s); inside it Spark goes straight to Meta;
  after it the provider is tried again.
- Logs (logger `memripal`): INFO `spark chat served by <provider>` or `spark chat served by meta` per successful
  call; WARNING `spark chat: <provider> failed (<exception class>), falling back to meta` (class name only).
  `create_app` adds one INFO `StreamHandler` to `memripal` only if it has no handler (idempotent across calls).
- Provider clients: `httpx.Timeout(30.0, connect=5.0)`, `max_retries=0`. Retune read timeout to
  max(15, 2 x warm p95) after a live run.
- Budget: one unit per `backend.call`, fallback included.
- Deploy: `scripts/deploy_cloud_run.sh` sets `MEMRIPAL_CHAT_PROVIDER=baseten` only when `MODE=meta` and secret
  `baseten-api-key` exists.
- Accept: provider 5xx / timeout / schema-invalid -> Meta answer under the Meta key; provider ok -> no Meta call;
  Meta fails too -> raises; second call within 120 s skips the provider, after it retries; WARNING names provider and
  class only; segment failure raises without the provider; fallback costs one budget unit; one handler across two
  `create_app` calls; deploy env set only for `MODE=meta` + secret present.

Tests: tests/test_chat_fallback.py, tests/test_chat_provider_wiring.py, tests/test_deploy_scripts.py

## MEM-107 Fallback header: X-Memripal-Chat-Fallback

Decided-by: ADR-0058
Root problem: the client cannot tell a Meta-served fallback answer from an open-weights one, and the backend has no
handle on the HTTP response.
Actors: `src/memripal/chat_fallback.py` (`HEADER`, `note_chat_fallback`, `ChatFallbackHeader`),
`src/memripal/backend.py`, `src/memripal/cors.py`, `src/memripal/app.py`.
NFR: pure ASGI; no route or response-body change; no state leaks across requests.
- `ChatFallbackHeader` gives each HTTP request a fresh list in a `ContextVar`; non-`http` scopes pass through.
  `note_chat_fallback(provider)` appends to it, a no-op outside a request (default `None`).
- `MetaBackend.call` notes the provider only after Meta answered the fallback; on `http.response.start` the
  middleware sets `X-Memripal-Chat-Fallback: <first noted provider>`. No note -> no header.
- `cors.add_cors` lists the header in `expose_headers` (cross-origin Capacitor shell).
- Accept: noted request carries the header; first provider wins; the next un-noted request has none; note outside a
  request is a no-op; live `POST /station`: provider served -> no header, fallback -> header, then cleared after the
  window; Meta also fails -> 502 without the header; `expose_headers` holds the header.

Tests: tests/test_chat_fallback.py

## MEM-108 Client fallback toast

Decided-by: ADR-0058
Root problem: judges should see that the open-weights path degraded, without the notice blocking the app or
rendering server-supplied text.
Actors: judges (browser); `static/chat_fallback.js`, `static/app.js`, `static/index.html`, `static/style.css`.
NFR: non-blocking; header value never rendered; no inline style; ASCII only.
- `withChatFallbackNotice(fetchFn, onFallback)` wraps the app's fetch, returns the same Response, and calls
  `onFallback` only for an allowlisted header value (own-property check): `baseten` -> "Baseten", `fireworks` ->
  "Fireworks", `local` -> "the local server".
- Toast `#chat-fallback` (`role=status`, `.notice.toast`, fixed top-centered, outside `details#drawer`) reads
  "Open-weights Spark on <label> is unavailable; continuing on Meta's hosted model".
- `#chat-fallback-dismiss` hides it for the rest of the page session.
- Accept: unknown / non-string / `toString` values -> no toast; Response passed through; missing headers object
  tolerated, rejections propagate; dismiss keeps it hidden; markup and CSS present; app.js wires it.

Tests: static/chat_fallback.test.mjs

## MEM-110 Photo multisensory taps on the seeded Kendall demo route

Amends MEM-077 (`static/demo_route.js` seed).
Decided-by: ADR-0060
Root problem: the seeded Kendall demo stations had no multisensory taps or profile, so Load demo showed empty sensory
cards; Kev supplied 6 walk photos (walk order, one per `DEMO_ROUTE` station; photo 6 is a nearby proxy for the Meta
office, where security barred photos) to author them from.
Actors: Kev (author of the photos and tap choices); `static/demo_route.js`, `static/route_store.js` (`seedRoute`),
`static/station_card.js` (`TAP_GROUPS`).
NFR: seeded, not an import file (default picked; an import path stays possible later); the photos are not committed
(the station card shows no photo; strangers appear in them).
Source: Kev, "I took pictures of the route, can you add multisensory info for them too".
- Each of the 6 stations in `DEMO_ROUTE` carries `taps` `{ sound, smell, feel, mood }` (no `turn`:
  `static/route_view.js` renders `taps.turn` into the S5 list, MEM-077), values drawn from `TAP_GROUPS`, and
  `profile` `{ visual, spatial, conceptual }`, printable ASCII, <= 200 chars each. Hand-authored from the photos.
- `seedRoute` persists both `taps` and `profile` as copies, so Load demo shows them with no import step.
- Accept: every `DEMO_ROUTE` station has all 4 tap keys with values in `TAP_GROUPS` and all 3 profile keys, ASCII and
  <= 200 chars; after `seedRoute`, the stored stations carry equal `taps`/`profile` that are not the same objects as
  the `DEMO_ROUTE` ones.

Tests: static/demo_route_taps.test.mjs

## MEM-120 Landmark fun facts + editable multisensory connections (phase A, pure module)

Builds on MEM-110 (seeded `taps`/`profile` on `DEMO_ROUTE`) and MEM-087 (station `{ name, profile, taps }` shape).
Root problem: a landmark gives the user nothing to hook new knowledge onto beyond its name; Kev wants short, cited
historical facts per landmark and multisensory connections the user can generate, then change to their liking.
Actors: the user (reads facts, generates and edits connections); `static/landmark_facts.js`; the storage adapter
(`idb_adapter.js` shape: `get`/`put`, as `static/route_store.js` uses it).
NFR: pure module, no UI mount (the landmark detail dialog that shows the bullets is phase B, MEM-108 on Kev's branch);
no network or model call; facts are seeded and hand-checked: every URL was fetched and supports its fact.
Source: Kev, "the landmarks should have fun facts/concise and easy to understand historical info with citations, so
shouldnt be to much but just enough to make it connectable to whatever info user wants to learn. And when a place is
linked, user can generate a the multisensory connections which they can update/change to their liking"; follow-up:
"facts/historical info bullets (3 points max) in the landmark tab".
- `factsFor(stationId, table?)` returns at most 3 facts `{ text, title, url }` for a station (seeded `LANDMARK_FACTS`
  keyed by `DEMO_ROUTE` station id, 1-3 per station), as copies; an unknown id returns `[]`. Every fact has non-empty
  plain-language `text`, a non-empty source `title` and an `https:` `url`.
- `createConnectionStore(adapter, { generate? })`: `generate(station)` builds `{ taps, profile }` (taps keys sound,
  smell, feel, mood with `TAP_GROUPS` values; profile keys visual, spatial, conceptual), persists it under
  `connections:<stationId>` via `adapter.put`, and returns it. The default generator derives taps from the station's
  seeded taps and profile from its seeded profile plus its first fact (conceptual), with no model call; an injected
  generator replaces it. `edit(stationId, patch)` merges a partial `{ taps?, profile? }`; `replace(stationId, conn)`
  overwrites; `get(stationId)` reads back (null when none). Tap values outside `TAP_GROUPS` and empty or >200-char
  profile lines are refused with an error before any write.
- Accept: every seeded station yields 1-3 facts and a 4th fact in the table is never returned; unknown station -> [];
  every fact has a title and an https URL; generate/edit/replace round-trip through a fake adapter; a new store over
  the same adapter returns the edited connections.

Tests: static/landmark_facts.test.mjs
