# Architecture decisions

One file per architectural decision: `NNNN-slug.md` with Context, Options considered (Pros/Cons), Decision, Why this
over the others, Consequences. Rule: `CLAUDE.md`. Full history: `docs/plans/2026-10-26-memripal.md`.

Why this log exists, Kev (2026-10-26): "can we make sure we record all architectural decisions, pros/cons of the
choices and why we chose one over the other in the hackathon documentation" ... "such as why we chose cloud run over
the others that you asked about".

## Reserved numbers

A branch may land an ADR above a gap when the missing numbers belong to ADRs still on unmerged branches. List those
numbers on the `Reserved:` line (`Reserved: 0034, 0035`, or `Reserved: none`); MEM-018 accepts a gap only when every
missing number is listed, and fails a listed number that also exists as a file (stale reservation: drop it when that
ADR lands). ADR [0062](0062-reserved-adr-numbers.md).

Reserved: 0075

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
- [0044](0044-route-review-drag-and-edit-trash.md) Route review reorders by drag (grip, pointer + keyboard) and removes
  through an Edit-revealed trash with confirm + Undo (over swipe-to-reveal or long-press).
- [0045](0045-map-first-shell-tabs-and-panel-placement.md) Map-first shell build: four hash-addressed `.tab-panel`
  sections toggled by `hidden` + `aria-current`; legacy panels rehomed to Recall/Settings tabs and the Routes drawer;
  real map mounted in `.map-wrap` filling home above the tabbar (over per-tab pages, CSS `:target`, deleting the
  panels, or keeping them stacked on home).
- [0046](0046-offline-walking-graph-routing-and-geocode.md) Route search runs offline: build-time Overpass walking
  graph + named-POI JSON, in-process A*, fuzzy geocode with a mandatory "meta office" alias and map-click fallback
  (over pmtiles roads, Google, public OSRM/Nominatim/Overpass, Stadia, ORS live, or an osmium/osmnx toolchain).
- [0047](0047-derived-auto-loci-and-swap.md) Auto-loci derived on demand from the POI table along the route; only
  acted-on candidates persist (`candidate:osm:<osm_id>` / `candidate:st:<station_id>`); swap moves in one
  `putRoute`, never drops (over Spark-named landmarks, `Route.alternates`, `Station.alternates`, or a global library).
- [0048](0048-memorize-breakdown-and-route-recommendation.md) Memorize reuses `/split` notes + `/associate` per
  station, client-side mnemonics, deterministic Jaccard route recommendation, `MemorizeItem` fills backup `lists[]`
  (amends 0033) (over `/deconstruct`, Spark ranking, or embeddings).
- [0049](0049-recall-schedule-and-push-reminders.md) Recall schedule = countdown doubling with an S+1d floor; in-app
  due list baseline, web push + Capacitor local notifications for phone reminders, `.ics` fallback (over SM-2,
  `.ics`-only, or local notifications only). Stretch.
- [0050](0050-two-flows-one-codebase-push-only-service-worker.md) Phone and desktop flows share one codebase via the
  900 px breakpoint + capability checks; push-only network-first root `/sw.js`, skipped under Capacitor (over two
  apps, UA sniffing, no worker, or a caching worker).
- [0051](0051-static-part-sub-loci.md) Opt-in "Find parts" sub-loci: SAM over a `STATIC_PARTS` phrase list gated by
  `MOVABLE_NOUNS`, nested `Station.sub_loci`, meta-mode replay fixtures (over always-on parts, Spark phrases, or flat
  extra stations). Stretch.
- [0052](0052-place-space-and-floor-plan-palace.md) Floor-plan palace: `Route.space` "geo" | "plan", normalized
  `plan_xy` on an SVG overlay, number reading with Python range checks and an unplaced tray (over overloading
  `Route.kind`, a separate store, or MapLibre raster). Deferred.
- [0053](0053-station-street-address-and-poi-precision.md) Optional `Station.address` (hand-verified seeds and
  aliases, then OSM addr tags, else "near <street>"); public-place coords at 5 dp, own GPS stays 4 dp; plain "Open
  in Maps" link; backups unchanged; amends 0031, 0042 (over 5 dp everywhere, coords in backups, `geo:` URIs, or a
  nearest-way label).
- [0054](0054-real-map-resize-observer.md) The real map loader observes the map box with `ResizeObserver` and calls
  `map.resize()` on a non-zero box, disconnecting on remove (over a tab-show hook in `tabbar.js` or MapLibre's
  `trackResize`).
- [0055](0055-landmark-emoji-on-live-map.md) Optional `Station.emoji`, U+1F4CD when missing, drawn as a
  `text.lm-emoji` sibling at (cx, cy-30) on the live map overlay, removed on detach (over name-keyword
  heuristics or OSM tag capture, the later upgrade path).
- [0056](0056-judges-only-access-gate-alb-cloud-armor.md) Judges-only live deploy: app key gate (no-JS `/access`
  form, HMAC cookie, fail-closed on Cloud Run) behind a global HTTPS ALB + Cloud Armor (rate ban, sqli/xss WAF),
  LB-only ingress; amends 0004, 0025, 0028 (over IAP, HTTP Basic, key-in-URL, an Armor header rule, or the gate alone).
- [0057](0057-emoji-for-keyword-table-fills-station-emoji.md) `emojiFor({ name, category?, tags? })` keyword/category
  table fills `Station.emoji` once at station creation; demo stations hand-picked, kept by `seedRoute` (over
  render-time derivation or OSM tags).
- [0058](0058-spark-chat-meta-fallback.md) Spark chat on an open-weights provider falls back to Meta on any
  `BackendCallFailed` inside `MetaBackend.call`, 120 s breaker, 30 s/5 s connect, 0 retries; `X-Memripal-Chat-Fallback`
  header via ContextVar + ASGI middleware drives a client toast (over a JSON body field, a wrapper backend, no
  breaker, or a flat 20 s timeout).
- [0059](0059-meta-spend-guard.md) Persisted per-call Meta cost estimate; at a configurable cap (default $135, under the $150
  credit) Meta calls get a typed refusal and chat falls back to Baseten or Fireworks; amends 0004 (over dashboard
  notifications only, a billing API per call, or an unpersisted call count).
- [0060](0060-demo-route-seeded-taps-and-profile.md) Demo route seeds photo-derived `taps` `{ sound, smell, feel,
  mood }` and `profile` in `static/demo_route.js`, copied by `seedRoute`, no `turn` (S5 list, MEM-077) and no photos;
  amends 0042 (over an importable backup file or committed photos).
- [0061](0061-spend-cap-degrade-and-byok.md) Past the Meta spend cap: replay saved results (live cache, then fixture
  replay), chat on the backup provider, else the 503 cap code; `X-Memripal-Spend-Cap` toast; each retry charged;
  BYOK offered only at the cap (MEM-122); amends 0059 (over BYOK only or degrade only).
- [0062](0062-reserved-adr-numbers.md) ADR numbering gaps pass only when every missing number is on the README
  `Reserved:` line; a reserved number that exists as a file fails as stale; amends MEM-018 contiguity (over committing
  only in land order or dropping the contiguity check).
- [0063](0063-route-view-mounts-one-station-card.md) The route view mounts the single MEM-050 station card, opened on
  station 1 and following the selected station, with a tap-summary chip row of only the set groups; amends 0060
  (over a card per station or a tap line in each S5 li).
- [0064](0064-memri-copilot-street-photo-scenes.md) Memri copilot: Mapillary street photos go through SAM + Muse Image
  into CC BY-SA 4.0 memory scenes with per-scene credit; C-style pure modules (tool policy, undo stack, `/baseline`),
  Messenger-style Pal chat bubble with on-device chats, fixture-mode demo; amends map-to-palace D1 (over a
  display-only copilot or S11 add-ons only).
- [0065](0065-emoji-composite-stickers.md) Merged tour stickers are layered emoji glyphs composed client-side in inline
  SVG, a sticker layer on MEM-095's house figure (offline, deterministic) over canvas raster, image generation, or
  canned art.
- [0066](0066-paper-crown-theme.md) Paper Crown theme: self-hosted Fraunces/Nunito, crown-edge topbar, gold
  (`--lamp`, `--on-lamp`, `--glow`) reserved for lit recall items as lanterns, dark mode on Lantern Walk roles
  (over Field Atlas, whole-app Lantern Walk, or Pop Palace).
- [0067](0067-restart-sticker-roll-animation.md) A mid-roll sticker tap restarts the spin by removing `is-rolling`,
  forcing a style flush via `getBoundingClientRect()`, and re-adding it, over alternating keyframe classes or the Web
  Animations API.
- [0068](0068-sticker-pool-client-indexeddb.md) The sticker pool (emoji, uploads, generated) lives client-side in
  IndexedDB behind `selectStore` with a localStorage fallback, uploads downscaled before storing (offline, stateless
  backend) over the sqlite-wasm db or server-side storage.
- [0069](0069-container-spend-state-dir.md) The Dockerfile sets `MEMRIPAL_META_SPEND_DIR=/tmp/memripal/meta-spend`
  so the homeless non-root user can write Meta spend state; resets per instance restart (over a deploy-script env
  var, creating the home dir, or a code tempdir fallback).
- [0070](0070-uncrossed-route-order.md) Uncrossed route numbering: MEM-013 reading order seeds a 2-opt that reverses
  meeting legs on strict length decrease, with a (cy, cx) y-monotone fallback, so the 1..n path never meets itself
  (over reading order, snake rows, nearest-neighbour + 2-opt, or a pure y-monotone sort).
- [0071](0071-generated-sticker-from-scene-crop.md) Generated stickers are cropped client-side from the tier-1 scene
  `runScenes` already produced, with an emoji search fallback, over a new server sticker-generation call or storing
  the whole scene image.
- [0072](0072-tour-bubble-body-data-attribute.md) `tour.js` sets body `data-tour-target` to the current step's
  selector; the Pal bubble goes inert unless it is the target (over tour CustomEvents, or a module import).
- [0073](0073-fixed-row-js-windowing-for-long-lists.md) Long lists: a client-side token-AND filter
  (`static/list_filter.js`, over server search) plus fixed-row-height JS windowing (`static/virtual_window.js`,
  CSSOM padding, `aria-setsize`/`aria-posinset`; over `content-visibility`, pagination, a virtual-list library, or
  measured rows). Windowing half pending: lands with the virtual_window fix. <!-- claim-exempt: planned -->
- [0074](0074-routes-empty-map-default-center.md) Zero-route Routes map centers on Kendall Square (inside the
  self-hosted extract), not Meta's Menlo Park HQ; `mountAt` reuses the station mount's `place()` path.
- [0076](0076-flashcards-derived-from-memorize-items.md) Recall flashcards derived at read time from MemorizeItem
  keywords on named stations (id `item:station`); only a `{note, review}` overlay stored under KV `card:<id>`; two
  ratings via the 0049 schedule (over a persisted deck, notes inside MemorizeItem, or four Anki ratings).
- [0077](0077-spark-reasoning-headroom.md) Spark reasoning headroom: `MetaBackend.call` adds
  `REASONING_HEADROOM_TOKENS` (8192) to `max_completion_tokens` at send time for every `spark_json` call, so cache keys
  and fixtures stay unchanged; `BackendCallFailed` is logged with a body excerpt masking every configured key (Meta and
  each chat provider), provider bodies never logged (over raising per-request caps in `gen_params` or lowering
  reasoning effort).
- [0078](0078-sticker-drag-snap-explicit-regen.md) Tap selects a sticker, drag moves it and snaps to the nearest
  segmented locus box, an explicit New sticker button regenerates, every change undoable (over tap-regen plus
  long-press drag, or a drag handle per sticker).
- [0079](0079-chat-route-intent-client-side.md) Chat route intent: client regex + `create_route` copilot tool over
  `planRoute`; demo routes generated offline (over LLM tool-calling or a button).
- [0080](0080-emoji-tags-replace-sense-taps.md) Emoji tags replace sense taps, auto-filled by keyword match over the
  Muse profile; `taps` kept (over a live Spark call or fixed taps).
- [0081](0081-central-meta-spend-counter-firestore.md) The meta-mode Meta spend counter is one Firestore doc updated
  by a check-and-increment transaction; any store failure or a missing (unseeded) doc refuses Meta (over Memorystore
  Redis, a GCS generation-precondition object, or the `/tmp` file).
- [0082](0082-landmark-slots-from-loci.md) Landmark photo slots: reuse POST `/loci`, client picks 3 largest
  distinct-label loci, live -> cached -> sample fallback, drag by dynamic import (MEM-141).
- [0083](0083-landmarks-photo-gallery.md) Landmarks tab: photo-tile gallery beside the hidden `ol#landmarks-list`,
  native datalist + chips route typeahead (union), `list_filter.js` reuse, wiring in `mountLandmarkGallery` (over
  replacing the list, a custom listbox, a local filter, or wiring in `flow.js`).
- [0084](0084-pal-chat-dedicated-route.md) Pal chat replies via a dedicated POST /chat route (server-side
  Pal system prompt, `MEMRIPAL_CHAT_PROVIDER` + BYOK, passcode gate, 502 `chat_unavailable`) (over piggybacking the
  recall grading route or calling the provider from the browser).
- [0085](0085-landmark-gallery-detail-dialog.md) Landmarks-tab tile opens a native `<dialog id="landmark-detail">`
  built by pure `landmark_gallery_detail.js` (over jumping to the route's station card, or merging the map-hover
  `landmark_detail.js` from unmerged `mem-landmark-detail`).
- [0086](0086-spark-recall-grading-keyword-fallback.md) Opt-in Spark grading of spoken recall (Settings toggle,
  default off; BYOK Meta key first, then non-Meta chat providers, 8 s timeout); got = union with the unchanged keyword
  matcher, which stays the whole fallback, with a downgrade notice on failure (over keyword-only or Spark replacing
  the matcher).
- [0087](0087-landmark-emoji-spark-bm25.md) Landmark station emoji: Spark via `POST /landmark-emoji` (2.5s, single
  pictographic grapheme), else keyword table, then BM25 over `static/emoji_corpus.js`, then pushpin (over keyword table,
  BM25 or Spark alone).
- [0088](0088-landmark-pull-street-photo.md) A photo-less landmark can pull a Mapillary street photo, ranked
  client-side by pure `landmark_pull_photo.js` (distance, facing, recency) and never replacing a user photo (over a
  backend ranking endpoint, a Spark rerank, or taking the nearest result).
- [0089](0089-gcp-app-pause-resume.md) GCP app pause/resume: `scripts/gcp_app.sh` sets ingress internal and deletes
  only the forwarding rule, keeping IP, cert and the rest of the edge (over ingress-only, or deleting the whole edge)
  (MEM-147).
