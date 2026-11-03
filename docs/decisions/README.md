# Architecture decisions

One file per architectural decision: `NNNN-slug.md` with Context, Options considered (Pros/Cons), Decision, Why this
over the others, Consequences. Rule: `CLAUDE.md`. Full history: `docs/plans/2026-10-26-memripal.md`.

Why this log exists, Kev (2026-10-26): "can we make sure we record all architectural decisions, pros/cons of the
choices and why we chose one over the other in the hackathon documentation" ... "such as why we chose cloud run over
the others that you asked about".

## ADRs

- [0001](0001-python-fastapi-stack.md) Python 3.13 + FastAPI, vanilla ES-module frontend (over full TS).
- [0002](0002-backend-modes-and-replay-cache.md) `meta|fixture` modes, logical-key write-through replay cache.
- [0003](0003-stateless-backend-client-state.md) Stateless backend; palace state in IndexedDB (over server DB + accounts).
- [0004](0004-public-deploy-spend-guard.md) Fixture default + passcode + per-instance budget (over a persisted counter).
- [0005](0005-api-key-custody.md) Key custody: DPAPI locally, Secret Manager on GCP. No recorded alternatives.
- [0006](0006-provider-toggles.md) Meta default; other providers behind env flags (over self-hosted SAM).
- [0007](0007-scene-render-tiers.md) Scene tiers: whole-photo edit, crop card, canvas (over a mask composite).
- [0008](0008-spoken-recall-deterministic-matcher.md) Spoken recall via Muse Voice Transcribe; deterministic matcher.
- [0009](0009-image-intake-and-photo-privacy.md) Client re-encode + server re-validation. No recorded alternatives.
- [0010](0010-cloud-run-hosting.md) GCP Cloud Run hosting (retrospective comparison vs App Engine, VM, GKE, Functions).
- [0011](0011-s2-loci-request-shape.md) S2: one sync `POST /loci` over a `ModelRequest`-keyed backend (A-prime).
- [0012](0012-vr-imagery-mapillary.md) VR imagery from Mapillary (over Google Earth / Street View).
- [0013](0013-derived-request-key.md) Derived `RequestKey` from `ModelRequest` beside the unchanged MEM-003 `CacheKey`.
- [0014](0014-loci-prompt-args-and-progress.md) Re-ask exclude list in `gen_params["prompt_args"]` (over a new
  field); `find_loci` progress, deadline and re-ask failure semantics.
- [0015](0015-local-whisper-stt-toggle.md) Muse STT default; loopback local Whisper behind `MEMRIPAL_STT_PROVIDER` (over
  OpenWhispr).
- [0016](0016-load-demo-bypasses-reencode.md) Load demo posts the demo photo's raw bytes, no client re-encode (over
  EXIF-free skip or fuzzy fixture match).
- [0017](0017-live-cache-in-refs-private.md) Live-mode cache in gitignored `refs/private/live-cache` (over
  write-through into `fixtures/replay`).
- [0018](0018-modal-segment-cache-key-and-failures.md) Modal segment key `modal/<model>`; Modal failures raise
  `BackendCallFailed`, uncached (over a new RequestKey field or returning "").
- [0019](0019-split-endpoint-contract.md) `POST /split`: list used as-is, notes via one image-less Spark call, one
  regeneration then `split_invalid` (over schema-enforced caps or two regenerations).
- [0020](0020-association-validate-and-regenerate.md) Associations: deterministic 4-rule validator, <= 2
  reason-carrying regenerations, then `invalid` for UI edit (over LLM self-check, unbounded retries or one
  attempt); locus label in the key (D3).
- [0021](0021-client-palace-store-injected-kv.md) Palace store: IndexedDB behind an injected KV adapter, keyed by
  item + locus label (over direct IndexedDB, localStorage, or server storage).
- [0022](0022-opt-in-place-context-server-lookup.md) Opt-in place context: client reads original-file GPS, stateless
  server Wikipedia lookup, user-confirmed place in /associate (over browser-direct lookup or EXIF-only); amends 0009.
- [0023](0023-chat-provider-adapter-reuses-meta-client.md) `MEMRIPAL_CHAT_PROVIDER` reuses `MetaClient` per host;
  answers keyed `<provider>/<provider model>` (over the `openai` library, a separate HTTP client, or
  `<provider>/<req.model>`).
- [0024](0024-scene-render-contract.md) Scenes: one whole-photo edit re-encoded to JPEG, keyed by the whole record (box,
  timeout and template unkeyed), every failure tier 3 (over pass-through bytes, box keys, or /associate's statuses).
- [0025](0025-passcode-gate-and-host-allowlist.md) Passcode gate: unset -> loopback open, public 401; per-route
  before body; deploy host via `MEMRIPAL_ALLOWED_HOSTS`; budget counts live `backend.call` (over always-required,
  global middleware, `*` hosts, or per-request counting).
- [0026](0026-client-side-recall-matcher.md) Recall matcher client-side (Levenshtein 0.8 or 60% coverage window),
  server relays one WAV clip to ASR (over a server matcher, embeddings, WebSocket relay, or Web Speech).
- [0027](0027-signed-association-records.md) /scenes renders only records /associate HMAC-signed; key from
  `MEMRIPAL_RECORD_KEY`, else random per instance; forged sig 403 (over a session store, a required key, or 400).
- [0028](0028-palace-backup-export-import.md) Palace backup: one JSON file, validated additive client import, app-wide
  CSP; supersedes 0003's import/export rejection (over per-palace files, images, overwrite, or a server endpoint).
- [0029](0029-generated-test-rooms-fixture-provenance.md) Muse Image hard rooms as committed test fixtures only,
  replayed via promoted live records (over demo art, synthetic or stock rooms, regeneration, or committed variants).
- [0030](0030-adopt-v6-css-markup-only.md) v6 look adopted as CSS + markup retargeted to live ids, v6 JS
  reference-only (over full v6 JS adoption or linking v6 `styles.css` verbatim).
- [0032](0032-capacitor-android-shell.md) Capacitor 8 Android shell bundling `static/` into `www/`, API base via
  `MEMRIPAL_API_BASE`, native meta CSP; CORS wiring pending (over a PWA or a remote `server.url`).
- [0034](0034-merge-branch-rebump-retry.md) `merge_branch.sh` ff race: drop tail bump, rebase, re-bump 4 release
  files to main + 1, re-check, retry, cap 3 rounds (over a mandatory merge queue or changelog fragments).
- [0035](0035-merge-branch-visual-verify-gate.md) `merge_branch.sh` visual-verify gate on the ff + override paths,
  default lookup `refuse_reason`, fails closed (over relying on `request_merge.py`'s preenqueue gates only).

## Minor decisions (no ADR)

Plan IDs refer to `docs/plans/2026-10-26-memripal.md`.

- Spark structured output: `json_schema` with `strict:true`, schema restated in the prompt, 1 retry on parse failure (A3).
- Route order: row-aware left-to-right by bbox centroid; arrow-button reorder over drag (D6, Ledger).
- Each of S2-S4 ships a minimal UI panel so every day is demoable (D7).
- Secret scan is a regex pre-commit hook, not gitleaks (D8).
- Round-2 plan adversaries skipped: round 1 converged (D9).
- Cut line: only S9 is cuttable; Q1 cut order S9, D16, D18 history view, D4 live lighting (D10).
- Phone capture via `capture=environment`; no service worker (stale-deploy risk); native Android deferred (D13;
  superseded in part by 0032).
- Loci spacing (< ~5% of diagonal collapse) and same-type duplicates disambiguated by position (D14).
- Notes mode: <= 12 key points, each an exact substring of the notes (D15).
- Higher-order why/apply question written at encode time, self-assessed, never live-graded (D16).
- Full-auto flag skips route review (D19).
- Per-scene requests with the photo re-sent, over streaming scene generation in one request (Rejected alternatives).
- [0031](0031-route-station-store.md) Route + station store on the phone via the injected KV adapter, pending station
  written before upload, coords at 4 dp (over server storage, upload-first, or localStorage).
- [0033](0033-backup-v2-routes-no-coordinates.md) Backup v2: routes + lists by field allowlist, never coordinates,
  640 px thumbnails, own 8 MiB cap, v1 refused; amends 0028 (over denylist, coord fuzz, full photos, or v1 migration).
- [0036](0036-design-gate.md) Design gate re-shoots `docs/design/**` at the branch tip itself; changed shots need
  Kev's recorded approval (over trusting committed PNGs or a reviewer-only check); amended 2026-11-01: shooters
  emulate reduced motion and launch Chrome with `--disable-gpu` so shots are deterministic (over disabling CSS
  animations, longer settle, diff tolerance, fresh page per shot, or extra raster-thread flags).
- [0037](0037-lint-in-pytest.md) Lint gate inside pytest: one `ruff-lint` session item runs `ruff check` on the
  whole repo, so the queue drain's pytest verify catches lint (over per-module items, a drain-side check, or a
  `merge_branch.sh`-only fix).
- [0038](0038-route-first-flow.md) Route-first flow: map-first shell (one route drawn, landmark filter, route
  drawer, 1000+ scale; amended 2026-11-01 over the card-list spine); capture anytime as an unfiled candidate; no
  typed geocoding; 3-8 on every add path; map source = stylized SVG now, MapLibre + self-hosted PMTiles staged
  behind conditions (over Google/Mapbox SDK or Leaflet raster via proxy).
- [0039](0039-route-design-file-split.md) Route design files split under the 500-line cap; preview pages carry an
  explicit screen map and the design gate follows `<link>` hrefs in link order (over a redirect/stub page or runtime
  CSS fetch/concat).
- [0040](0040-retire-room-photo-flow.md) Room-photo flow retired in two steps: upload handler and room copy now, Load
  demo -> demo route and `/loci` deleted (no 410) at B10 (over full retirement now, a stand-in demo route now, or also
  deleting unwired route-first modules).
- [0041](0041-real-map-whole-file-pmtiles.md) Real map: bundled Kendall Square PMTiles extract fetched whole into
  pmtiles `FileSource`, validated, sketch fallback; maplibre-gl 5.24 CSP build; own Python extract script; amends 0038
  condition 2 (over HTTP Range, a z/x/y tile dir, MapLibre 6, or the Go `pmtiles extract` CLI).
- [0042](0042-kendall-demo-route-seeding.md) Kendall demo route: frozen `static/demo_route.js` module, seeded by the
  existing Load demo click via new `route_store.seedRoute` (keeps coords) (over a backup fixture or new fixture file, a
  dedicated button, or reusing `restoreRoute`, which drops coords).
- [0043](0043-station-photo-optional-in-backups.md) Station `photo` optional in backup v2: omitted on export when none
  is stored, accepted absent on import, still validated when present; partially supersedes 0033 (d) (over excluding
  the demo route by id, skipping photo-less routes, or a placeholder JPEG).
