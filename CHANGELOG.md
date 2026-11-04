# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.20.69] - 2026-11-04

### Fixed

- Spark loci calls no longer come back empty: every spark_json send adds 8192 reasoning-headroom tokens to max_completion_tokens at send time, so cache keys and fixtures are unchanged (MEM-014, ADR 0077).
- Upstream 502s now log their cause at WARNING (route, exception class, status, a 500-char body excerpt) with every configured provider key masked as ***; a chat provider failure never logs its body, and error responses stay {"error": code} (MEM-014, MEM-015).

## [0.20.66] - 2026-11-04

### Changed

- Design gate axe problems name each offending node's selector and html snippet (MEM-119).

## [0.20.65] - 2026-11-04

### Changed

- The Pal chat panel reads like a messenger: your messages sit right and Pal's left with Pal's face, each with a time; an empty chat shows a Pal greeting; a bottom composer sends on Enter (Shift+Enter for a newline) with a typing indicator while Pal replies; the list scrolls to the newest message (MEM-116). Pal does not answer yet: no reply provider is wired.

### Added

- Generated stickers from the memorized item (MEM-052, ADR 0071): after Load demo, each item's AI scene is cropped to its spot and stuck onto the landmark photo as a die-cut sticker, saved to the sticker pool and listed as "(AI-generated)" in the Stickers panel; offline or on any failure Pal falls back to a matching emoji sticker, else skips the spot.

## [0.20.64] - 2026-11-04

### Fixed

- Cloud Run image (MEM-034, ADR 0069): the Dockerfile sets MEMRIPAL_META_SPEND_DIR=/tmp/memripal/meta-spend, so the non-root runtime user (no home dir) can write Meta spend-guard state; every Meta-routed call previously returned 500 with PermissionError on /home/memripal. Spend state resets when the instance restarts.

- Auto-numbered loci now follow a route that never crosses itself: `route_order` keeps the MEM-013 reading order when it is already clean, otherwise untangles it with 2-opt (exact integer meeting tests: crossings, T-touches, collinear overlaps), falling back to a top-to-bottom (y, x) sort when 2-opt cannot clear a meeting; demo replay fixtures regenerated. Manual renumbering override is not part of this change (MEM-113, ADR 0070).

## [0.20.63] - 2026-11-04

### Fixed

- Pal chats can be created where `crypto.randomUUID` is missing: the chat store mints chat and message ids via `static/uuid.js` (crypto.getRandomValues fallback). A plain-http non-localhost origin still shows "Chats unavailable in this tab", since Web Locks and OPFS are secure-context only (MEM-099).

## [0.20.62] - 2026-11-04

### Added

- Stickers on the demo photo (MEM-045, ADR 0068): after Load demo, the Recall tab shows a Stickers panel where you pick a spot, upload your own picture with a short description, and Pal sticks it (die-cut, tilted) onto that spot of the landmark photo; Peel off asks to confirm and offers Undo; stickers persist across reloads in a client-side IndexedDB pool (localStorage fallback), uploads downscaled to a 256px JPEG before storing.

## [0.20.60] - 2026-11-04

### Fixed

- Pal's tour step 3 stickers (MEM-109, ADR 0067): Tab now reaches each dog-house sticker (focus trap order Skip, the 5 stickers, Roll all, Back, Next) and Enter/Space re-rolls the focused one; a tap on a sticker mid-roll restarts its spin instead of looking ignored; replaying the tour from Settings rolls fresh stickers.

## [0.20.59] - 2026-11-04

### Added

- Regression test: push_secret_gcp.ps1 exits 2 with "gcloud not found on PATH" when $env:MEMRIPAL_GCLOUD cannot be resolved, before decrypting the key and without leaking it (MEM-111).

## [0.20.58] - 2026-11-04

### Added

- Paper Crown theme: a storybook look for the painterly theme with self-hosted Fraunces (display) and Nunito (body) fonts plus their OFL licences (CSP `font-src 'self'`), a crown edge on the top bar, and gold lantern stations marking recalled state (`--lamp`, `--on-lamp`, `--glow`); forced-colors, prefers-contrast and print drop the crown edge and glow; all 15 contrast pairs AA in light and dark; design preview at docs/design/paper-crown/ (MEM-102, ADR 0066).
- Header tagline "Find a home for every memory" under the MemriPal wordmark (MEM-102).

## [0.20.57] - 2026-11-04

### Fixed

- `scripts/push_secret_gcp.ps1` resolves gcloud (default `gcloud.cmd` or a bare MEMRIPAL_GCLOUD name) to its full path via Get-Command before launching it; a bare-name launch made gcloud.cmd's `%~dp0` resolve to the current directory, failing with "can't open file ...\lib\gcloud.py" / "gcloud exited 2". A gcloud not on PATH exits 2 with `push_secret_gcp: gcloud not found on PATH`. Regression test added (MEM-111).

## [0.20.55] - 2026-11-04

### Added

- Pal chat bubble mounted on every screen (MEM-099, ADR 0064): `static/index.html` loads `/static/pal_bubble.js` right after `app.js`, and `mountPalBubble` adds one idempotent `/static/pal_bubble.css` stylesheet link to the document head, so the bubble loads its own stylesheet. Tests in `static/pal_bubble.test.mjs` and `tests/test_assets_wiring.py`.

### Fixed

- `scripts/run_live.ps1` help cites ADR 0064, not ADR 0054, for the Mapillary token (`tests/test_run_live.py`).

- Pal's tour step 3 (MEM-117, ADR 0065): emoji composite stickers on Pal's dog house. Each item is broken into keywords (`static/stickers.js`: pool, keywords, search, compose, rollAll, rollOne) and their emoji are mashed into one sticker anchored at each spot's top-right corner. Tap, Enter or Space on a sticker re-rolls it; `#tour-roll` "Roll all" (house step only) re-rolls all five. Rows show the sticker as the icon with a `.tour-kw` keywords caption ("sizzling + bacon"). Rolls survive Next/Back; reduced motion disables the roll animation. Step-3 rows show a numbered badge in place of the visually hidden spot name so the card fits a 375x812 phone.

## [0.20.54] - 2026-11-04

### Changed

- Merged origin/main (overnight cloud run, PRs #14 land-all and #15) into local main. Both sides had landed Pal's tour and the Memri copilot groundwork; origin's numbering wins: Memri copilot ADR 0061 -> 0064, tour replay MEM-097 -> MEM-112 (MEM-097 stays the copilot tool dispatcher). Local-only MEM-111 (push_secret_gcp) keeps its id.

## [0.20.53] - 2026-11-04

### Added

- `scripts/create_secrets.sh` (MEM-104, ADR 0005): one-step creation of the Cloud Run Secret Manager secrets (memripal-access-key, memripal-record-key, meta-api-key); keeps existing secrets. Meta key source: META_API_KEY env, else the DPAPI file at MEMRIPAL_META_KEY_FILE (default ~/.secrets/meta-api-key.dpapi) decrypted via powershell, else a hidden prompt; never echoes the key. Tests in `tests/test_create_secrets.py`. Runbook `docs/runbooks/deploy-gcp.md` updated (one-step `sh scripts/create_secrets.sh`, billingbudgets + winget prereqs, PowerShell `$env:MODE` form).

## [0.20.52] - 2026-11-04

### Added

- `scripts/push_secret_gcp.ps1 <name>` pushes a DPAPI-stored API key (meta-api-key, baseten-api-key, fireworks-api-key) to GCP Secret Manager through gcloud stdin, byte-exact with no trailing newline; the deploy runbook uses it instead of typing keys (MEM-111).

### Changed

- Submission checklist and demo script name Muse Spark Open served on Baseten for the open-weights prize.

## [0.20.51] - 2026-11-04

### Added

- Map a new route: the Routes drawer's "Map a new route" finds a walk between two addresses, previews it and saves it; a geocode miss suggests aliases only, one landmark per address; the empty map says so; a map marker click selects its station in both lists; the selected station is styled in both lists and on the map, with 12px clickable overlay markers and a 4px primary route line; a failed Save shows an error and keeps the preview for a retry (MEM-088 R3a/R3b).
- Route view mounts one station card with a tap summary, so Load demo shows the seeded Kendall taps (MEM-110, ADR 0063).
- Pal's first-run tour: a skippable, persisted 10-step tour that explains the memory palace method and points at the four places that matter; step 3 draws Pal's dog house segmented into 5 numbered spots; Settings gains a "Pal's tour" replay button; the browser drivers seed the tour key and shoot tour steps (MEM-095, MEM-112).
- Memri copilot groundwork (planned specs MEM-097..099, ADR 0064): pure tool-policy (allow/ask/off) and undo-stack modules with a copilot dispatcher, street-photo scenes with Mapillary credit and baseline credit fields (run_live Mapillary token), and a Messenger-style Pal chat bubble whose chats live in the on-device db and travel with the palace export.
- POST /baseline is mounted in create_app; the fixture-or-live provider choice is routes_baseline.default_baseline_provider (MEM-098).
- A shared page-wide openDb; the Pal bubble opens through it (MEM-099).
- Landmark fun facts with citations and editable multisensory connections, as a pure module with no UI mount or network call (static/landmark_facts.js, MEM-120).
- ADR gaps pass only for numbers the decisions README reserves, and a stale reservation fails (MEM-018, ADR 0062).
- Meta spend cap degrade: every sent Meta attempt (retries included) is charged; past the cap the model routes return saved results, the backup chat provider or 503 meta_spend_cap_reached (/scenes tier 3), say which in header X-Memripal-Spend-Cap, and the page names it in a dismissible top toast that never blocks the controls under it (MEM-121, ADR 0061; KevinKbyte/MemriPal#7).
- Bring your own Meta key past the spend cap: only when the toast says live steps are paused, a visitor may paste their own Meta key, held in page memory only and sent only in X-Memripal-Meta-Key on the 5 model routes; the server runs that request on a fresh per-request backend, client and $5 guard (MEMRIPAL_BYOK_SPEND_CAP_USD) under an HMAC-named spend dir, with no backup provider, shared cache or call budget; X-Memripal-Byok reports invalid, limit or rejected:<model> (MEM-122, ADR 0061; KevinKbyte/MemriPal#12).

### Changed

- Deploy runbook (deploy-gcp.md): PowerShell forms of each command, winget gcloud install, the billingbudgets API and --filter-projects (KevinKbyte/MemriPal#13).
- ADR renumbering at land: reserved ADR numbers 0061 -> 0062, route view station card 0061 -> 0063, Memri copilot 0058 -> 0064; the tour replay MEM-097 -> MEM-112; leftover "MEM-095 part C" references now say MEM-122.
- `_BudgetedBackend` moved to bodies.py next to BudgetExhausted (still importable from memripal.app), keeping app.py under its MEM-060 line budget.

### Fixed

- Route and rehearsal ids, the route builder's picked stations and route saves mint v4 ids without crypto.randomUUID, so they work on plain-http (insecure-context) hosts (MEM-048, MEM-088).
- .field columns use minmax(0, 1fr) and the file input max-width 100%, so a control never widens the page at 360px; e2e step 14 passes (MEM-072).
- screenshot_design.py ignores only the root /favicon.ico 404 console error (MEM-067).
- BYOK security review (MEM-122): /scenes at the visitor's own limit answers tier 3 byok_limit_reached, not the shared cap's code; a key's spend dir is created only once Meta has accepted the key (its first charges count in memory under the guard lock, so the cap still holds for concurrent first calls), so random keys leave nothing on disk; the key field is a CSS-masked text input outside any form, with no name and autocomplete/autocapitalize/spellcheck off, so password managers do not offer to save it (Continue or Enter); the key and its chip are cleared on pagehide and on a back/forward-cache restore.

## [0.20.50] - 2026-11-04

### Added

- Kendall demo stations seed photo-derived multisensory taps (sound, smell, feel, mood) and a visual/spatial/conceptual profile, hand-authored from Kev's six walk photos and kept by seedRoute; no turn tap and no photos committed (MEM-110, ADR 0060).

## [0.20.49] - 2026-11-03

### Added

- Meta spend guard: a persisted per-call estimate of Meta spend (Spark chat, SAM, ASR, image calls) with a configurable cap (MEMRIPAL_META_SPEND_CAP_USD, default $135, under the $150 credit; state in MEMRIPAL_META_SPEND_DIR). Past the cap the server sends no Meta request and returns 503 meta_spend_cap_reached; Spark chat falls back to Baseten, else Fireworks. ADR 0059 (MEM-094).

## [0.20.48] - 2026-11-03

### Added

- Spark chat on an open-weights provider (MEMRIPAL_CHAT_PROVIDER=baseten|fireworks|local) falls back to Meta's hosted model on error, timeout or schema-invalid reply, with a 120 s skip breaker, 30 s read / 5 s connect timeout and no retries; each call logs which provider served it. The fallback sets response header X-Memripal-Chat-Fallback and the client shows a dismissible, non-blocking notice (MEM-106..108, ADR 0058).
- Deploy: scripts/deploy_cloud_run.sh sets MEMRIPAL_CHAT_PROVIDER=baseten when MODE=meta and secret baseten-api-key exists (MEM-106).

## [0.20.47] - 2026-11-03

### Added

- Best-fit landmark emoji: emojiFor({ name, category?, tags? }) keyword/category table (static/landmark_emoji.js); the Kendall demo stations carry hand-picked emoji, kept by seedRoute, so the live map shows them instead of U+1F4CD (MEM-100, ADR 0057).

### Changed

- Deploy runbook and ADR 0056: judges get the URL and access key from the submission's Project Description (the form has no private notes field); cost exposure bounded by the Meta spend limit and MEMRIPAL_CALL_BUDGET.

## [0.20.46] - 2026-11-03

### Added

- Judges-only live deploy: shared access key traded at /access for a signed HttpOnly cookie; Cloud Run behind a global HTTPS ALB + Cloud Armor (scripts/deploy_edge_gcp.sh); MODE-driven secrets and IAM grants in deploy_cloud_run.sh; client IP from trusted proxy hops, IPv6 keyed by /64 (MEM-103..105, ADR 0056).

## [0.20.45] - 2026-11-03

### Changed

- Dev: `.claude/launch.json` gains a portable `app-main` preview entry (`uv run uvicorn memripal.app:app` on 127.0.0.1:8000, no absolute `--directory`).

### Added

- MEM id uniqueness check: scripts/spec_ids.py + tests/test_spec_ids.py fail check.sh on a MEM id defined twice (MEM-101); CLAUDE.md numbering rule.

## [0.20.44] - 2026-11-03

### Added

- POST /associate accepts an optional station block {name, profile, taps} (MEM-087, ADR 0048 amendment): checked before any model call (unknown keys, blank name or over-200-char values -> 400 bad_station), carried into the prompt via the new ASSOCIATION_STATION template, and sent with send_image False so the photo-less demo station's sentinel JPEG never reaches the model. Memorize's associateKeywords now sends each station's block ({} for a missing profile or taps).

- scripts/gen_demo_photo_json.py [--in PATH] [--out PATH] regenerates static/assets/demo_photo.json byte-exact from fixtures/demo/photo.jpg (MEM-087).

- Live Routes map: each station shows a landmark emoji just above its circle (optional Station.emoji, default U+1F4CD round pushpin), following the station on pan/zoom/resize; aria-hidden, set via textContent, presentation attributes only (static/real_map_overlay.js, MEM-100, ADR 0055).

## [0.20.43] - 2026-11-03

### Added

- Recall schedule (static/recall_schedule.js, MEM-090, ADR 0049 schedule (a)): pure recallSchedule(deadline, { now }) returns review times at S+10m, S+1h, then countdown doubling T-1d, T-2d, T-4d ... down to the S+1d floor, dropping an anchor within 1d of the review before it; a deadline within 1d gets S+10m/S+1h/S+4h before T; no deadline gets 1, 3, 7, 14, 30, 60, 120 days; a passed deadline gets none.

- POST /station (station photo -> pixelated photo, name, profile, box) is now mounted on the app, behind the same passcode guard as /loci (MEM-083).

## [0.20.42] - 2026-11-03

### Added

- README credits OpenStreetMap contributors (ODbL), via the Overpass API, for the offline walking graph and place table (MEM-084).

## [0.20.41] - 2026-11-03

### Added

- Memorize client logic (static/memorize.js): notes-mode /split client, keyword edit re-split with 0 model calls, /associate per keyword and station, client mnemonics, Jaccard + capacity route recommendation with a reason, MemorizeItem list:<id> and backup lists[]; the 6-technique demo notes (fixtures/demo/study_techniques.txt) with a live-recorded split replay fixture so fixture mode makes 0 live calls (MEM-087).

### Fixed

- Real Kendall map no longer stays blank or undersized when its box starts at 0x0 and gains size later (hidden tab, zero viewport): the loader resizes it from a ResizeObserver (MEM-096, ADR 0054).

### Added

- Offline walk routing + geocode (MEM-084): scripts/build_walk_graph.py builds a compact Kendall walk graph and named-POI table from one Overpass query (committed under static/data/), and static/walk_route.js routes by A* snapped to the largest component with a flagged straight-line fallback and geocodes typed places over POIs plus aliases.

- Auto-loci (MEM-085): static/auto_loci.js candidates() lists POIs within 50 m of a routed walk, deduped, 40 m apart, none within 15 m of a station, each with its address or a near-<street> label; route_store swapStation / undoSwap / addCandidate (max 8 stations, swapped-out stations kept under candidate keys with their photo); seeded and map stations keep 5-dp coords, GPS stays 4 dp; demo stations carry street addresses.

## [0.20.40] - 2026-11-03

### Added

- README Credits section for map data and libraries; demo script reworked to the map-first path.

## [0.20.39] - 2026-11-03

### Added

- Onboarding page (docs/onboarding.md + generated docs/onboarding.html, project_docs generator) with CLI, tests and gotchas tables plus the hooks list; the pre-commit hook runs agent-workflow's PDOC-005 docs-sync leg, which fails closed if the leg is absent; the submission checklist gains API credit status (HANDOFF-2).

## [0.20.38] - 2026-11-03

### Added

- Demo-flow design docs: ADRs 0046-0053 (offline walking routes + geocode, auto-loci + swap, Memorize breakdown + route recommendation, recall schedule + push reminders, two flows in one codebase, static-part sub-loci, floor-plan palace, station street address + POI coord precision) and the build plan docs/plans/2026-11-03-demo-flow.md (MEM-083..MEM-093).

## [0.20.37] - 2026-11-03

### Changed

- Home is now map-first: the map fills the screen, a bottom tab bar switches Routes, Landmarks, Recall and Settings, and the route home (Load demo, Map a new route, status) sits in a right-hand drawer opened from its handle; Load demo and route cards open the route on the Routes tab map; ADR 0045 (MEM-072).

## [0.20.36] - 2026-11-03

### Fixed

- E2E driver: the e2e server now runs with a per-IP rate limit a full run never trips, so steps 11 (reload) and 12 (rehearsal delete) no longer fail on a `POST /split` 429 (MEM-034).

## [0.20.35] - 2026-11-03

### Changed

- Route review: reorder places by dragging the grip (pointer or keyboard) instead of tapping Up/Down; the trash appears only after tapping Edit, asks to confirm, and the removal can be undone from a toast; ADR 0044 (MEM-081).

## [0.20.34] - 2026-11-03

### Added

- Start screen: King Memri (Pal) replaces the empty-state picture as a blinking SVG, shown still under reduced motion and hidden once a palace or a route exists; every static SVG is linted for scripts, styles, handlers and external links (MEM-082).

## [0.20.33] - 2026-11-02

### Added

- Real map: the route view shows a self-hosted Kendall Square basemap (PMTiles extract, light and dark styles, vendored icon sprite), falling back to the sketch map when it cannot load (MEM-074, MEM-075, MEM-076, MEM-078).
- Station overlay on the real map: numbered station markers, a station list whose items open each station's detail and stored study item, and markers that select into it; a station marker doubles in size on hover (MEM-076, MEM-077).
- Load demo also seeds the Kendall demo route, so the real map has a route to show (MEM-077).

### Fixed

- The route is clipped to the map, and off-map stations are pinned to its edge with an arrow (MEM-076).
- Backups: a station without a photo now exports and restores instead of failing; ADR 0043 (MEM-054, MEM-077).

## [0.20.32] - 2026-11-02

### Fixed

- Route practice end screen: a station said out of order (heard, but not counted in order) now gets "Mark got it", and marking it counts that station as learned (MEM-080).

## [0.20.31] - 2026-11-02

### Removed

- Room-photo upload: picking a photo no longer posts it to /loci (`onPhotoChange` and its `#photo` listener removed; the `#photo` element stays for S2 capture). Load demo is unchanged until plan B10 repoints it at the demo route and deletes /loci (MEM-073, ADR 0040).

### Changed

- First-screen copy no longer asks for a room photo; `scripts/screenshot_ui.py` also writes `route_view.png` after importing `fixtures/demo/route_backup.json` through backup import (MEM-073).

## [0.20.30] - 2026-11-02

### Fixed

- POST /station: a landmark phrase naming something that moves (a person, car, chair, bike and similar) is refused and re-asked, so the station box always marks a fixed structure (MEM-079).

## [0.20.29] - 2026-11-02

### Fixed

- Recall end screen: "Mark got it" now also sets the matching record.hits entry true, so a point marked got counts as a hit (MEM-033, MEM-051).

## [0.20.28] - 2026-11-01

### Added

- docs/design/route/ map-first route shell (map-shell.html/.css/.js): one selected route drawn on the map with topic colour, landmark dots and emoji, 800 ms pan and draw-in to a newly picked route, a right-hand drawer for route settings and picking or mapping routes, a "This route" / "All landmarks" filter with viewport-virtualized off-route landmarks, and Routes / Landmarks / Recall / Settings tabs; reduced motion is instant (MEM-072, ADR 0038).
- Design gate follows the stylesheets preview pages link and screenshots the split pages; route.css and preview.html are split into files under 500 lines (MEM-067, ADR 0039).

## [0.20.27] - 2026-11-01

### Added

- Pre-commit hook runs agent-workflow kb_anchor_gate (docs/decisions code anchors; AW env var, default $HOME/projects/agent-workflow) (KB-041).

## [0.20.26] - 2026-11-01

### Added

- Mascot canon: King Memri ("Pal") in docs/design/mascot.md, linked from README.

## [0.20.25] - 2026-11-01

### Changed

- Taste (gustatory) cue is optional in associations; channels constant renamed MULTISENSORY_CHANNELS; docs say multisensory (MEM-022).

## [0.20.24] - 2026-10-31

### Added

- tests/conftest.py lint gate: every pytest run carries one ruff-lint item over the whole repo, so the merge-queue drain's pytest verify (even affected-only, single-file or -m filtered) fails on a ruff error in tests or src when request_merge.py is called directly and scripts/check.sh is skipped (MEM-071, ADR 0037).

## [0.20.23] - 2026-10-31

### Fixed

- API docs pages (/docs, /redoc, /openapi.json) no longer served (MEM-042).

### Changed

- CLAUDE.md: the visual-verify screenshot rule now also covers `docs/design/**` `.css`/`.html` diffs (design previews shot with scripts/screenshot_design.py, MEM-067), and points to the global render-first rule for design tasks.

## [0.20.22] - 2026-10-31

### Added

- Routes and stations stored in SQLite (OPFS worker) with soft delete and undo; photos stay in IndexedDB; route_store API unchanged (MEM-039).

## [0.20.21] - 2026-10-31

### Added

- scripts/design_gate.py design gate: re-shoots docs/design/** at the branch tip and checks the render (page errors, route CSS lint, 375 px overflow, axe contrast and tap targets, selector and contract ids present); refuses README-only or stale-PNG evidence. scripts/approve_design.py records Kev's approval of changed shots (MEM-070, ADR 0036).

## [0.20.20] - 2026-10-31

### Added

- scripts/merge_branch.sh ff race auto-recovery: drops the trailing version-bump commit, rebases on main, re-bumps the 4 version files to main+1, re-runs the check and retries the ff, capped at 3 rounds; refuses a branch whose last commit is not a bump (MEM-068, ADR 0034).
- scripts/merge_branch.sh visual-verify gate on the ff and MEMRIPAL_REQUEST_MERGE_CMD paths: a UI diff without a recorded visual-verify gate is refused; MEMRIPAL_VISUAL_VERIFY_CMD seam, default lookup via agent-workflow visual_verify_merge_gate fails closed (MEM-069, ADR 0035).

## [0.20.19] - 2026-10-31

### Added

- API hardening (MEM-034): per-IP sliding-window rate limit on limited routes, passcode lockout (MEMRIPAL_PASSCODE_MAX_FAILS=5, MEMRIPAL_LOCKOUT_S=300) cleared on success, per-route concurrency cap (MEMRIPAL_ROUTE_CONCURRENCY=4), stale-key sweep, IPv6 keyed by /64 and IPv4-mapped IPv6 keyed as IPv4; Cloud Run deploy --concurrency=20 --timeout=120.

## [0.20.18] - 2026-10-31

### Added

- SQLite storage layer (S1): vendored @sqlite.org/sqlite-wasm 3.54.1-build1, static/db/ migrations runner (PRAGMA user_version, sync-only steps, refuses newer DB), Worker RPC client with single-tab navigator.locks leader, opfs-sahpool worker, Node in-memory driver for tests; CSP adds script-src 'self' 'wasm-unsafe-eval' for wasm compile (MEM-039).

## [0.20.17] - 2026-10-31

### Added

- Design-floor tooling: scripts/check_route_css.py mechanically checks route.css against the design prompt's hard constraints (tokens, ids, contract classes, banned properties, colours) and prints OK or each problem; scripts/screenshot_design.py screenshots the route preview per screen, width and theme and fails on page/console errors (MEM-067).

## [0.20.16] - 2026-10-31

### Fixed

- Route Undo whose storage write fails now shows "Couldn't restore the route. Try again." and keeps Undo; a retry restores the route (was: reported success, route lost on reload) (MEM-051).

## [0.20.15] - 2026-10-31

### Added

- Route UX design deliverables (S1-S9) in docs/design/route/: route.css (additions only), route-contract.md (class contract, state tables, id map) and preview.html, screenshot-verified at phone and desktop widths in light and dark.

## [0.20.14] - 2026-10-31

### Fixed

- Backup export with a saved route no longer throws: the app now wires a canvas JPEG thumbnail (static/thumbnail.js) into backup export (MEM-054).

## [0.20.13] - 2026-10-31

### Added

- Backup v2: export carries routes and lists by field allowlist with 640 px station thumbnails and never coordinates; 8 MiB cap; v1 backups refused with a plain message; station photos without a readable JPEG size are refused (MEM-054, ADR 0033).

## [0.20.12] - 2026-10-31

### Added

- Route view (S5): practise a route's stations in order, and delete a route with Undo that restores it even when the store write fails (MEM-051).

## [0.20.11] - 2026-10-31

### Added

- Scene images pass the Muse Image reply through unchanged, with an AI-generated chip pinned to each scene image and the overlay (MEM-046).

## [0.20.10] - 2026-10-31

### Added

- S3 station card: name rules, tap tags, drop with Undo, used_names sent to /station (MEM-050).

## [0.20.9] - 2026-10-31

### Added

- Plan amendment: B14 route planning (B14a-c, MEM-064..066), Boston demo place, Q4 HTML fragments; Parts C-F and below-cut slices moved to docs/plans/2026-10-31-map-to-palace-ledgers.md.

## [0.20.8] - 2026-10-31

### Added

- Capacitor 8 Android shell: build:mobile bundles static/ into www/, API base via MEMRIPAL_API_BASE, native
  meta CSP, CORS module; ADR 0032 (MEM-063).

## [0.20.7] - 2026-10-31

### Added

- POST /station: fail-closed pixelation, route-station name and profile, one landmark box; regenerates on an
  invalid live reply, no retry on transport errors; used-names header is ASCII-only JSON (MEM-049, B4).

## [0.20.6] - 2026-10-31

### Changed

- Untracked agent scratch directories that were auto-committed, and gitignored them.

## [0.20.5] - 2026-10-31

### Added

- Client route + station store and capture session: routes keep up to 8 stations in capture order, pending
  stations retry, and the finish step names the route and picks its kind with two radios (MEM-048;
  `static/route_store.test.mjs`, `static/route_capture.test.mjs`, ADR 0031).
- Route markup: S1 routes home, S2 capture session, S4 finish fields; passcode and auto-capture move into the
  collapsible Live settings panel (MEM-048).

## [0.20.4] - 2026-10-31

### Changed

- Request-body parsers, the error helper and the capped body reader move from `app.py` to `src/memripal/bodies.py`
  with no behaviour change; `app.py` drops from 581 to 491 lines (MEM-060; `tests/test_bodies.py`).

## [0.20.3] - 2026-10-31

### Added

- Mapillary street-photo baseline server core: nearest CC BY-SA image within 30 m of a station, coords rounded to
  4 dp outbound, token only in the OAuth header, thumbnails https-only from the Mapillary CDN, size-capped and
  EXIF-stripped; router not yet wired into the app (MEM-053; `tests/test_baseline.py`, `tests/test_baseline_api.py`).

## [0.20.2] - 2026-10-31

### Changed

- Demo-place prose in README, ADR 0022 and spec-2 is neutral (no named real-world site); the synthetic fixture
  generator scrub is deferred to plan slice B10 behind strict xfail tests (MEM-047; `tests/test_demo_place_scrub.py`).

## [0.20.1] - 2026-10-30

### Fixed

- The full-size scene overlay is a modal dialog with a top-right Close button; focus moves to Close on open and
  back to the thumbnail on close, and thumbnails open with Enter/Space (MEM-044;
  `static/app_ux_scene_overlay.test.mjs`).
- Scene images carry "<item> at <place>" alt text in the scenes panel and walk view (MEM-044;
  `static/app_ux_scene_overlay.test.mjs`).
- The scenes panel is a polite live region, marked aria-busy while rendering (MEM-044;
  `static/app_ux_scene_overlay.test.mjs`).
- At 360px, Confirm drop and Cancel share one line, and locus badges shrink at small scale so the demo's 12 do
  not overlap (MEM-044; `static/app_ux_badges_360.test.mjs`, `static/style_v6_components.test.mjs`).

### Changed

- E2E step 6 (scene overlay) is strict, backed by a tier-1 demo scene fixture
  (`fixtures/replay/image_edit/272afd50...webp`) (MEM-044; `tests/test_e2e_scene_step.py`).

## [0.20.0] - 2026-10-30

### Added

- A painterly theme (`static/theme-painterly.css`, loaded last): warm cream watercolour paper with a faint
  grain in light mode, deep ink-blue in dark mode, ultramarine/burnt-sienna/sap-green pigment colours, a
  serif display face, and deckled panel edges; every text pair stays at least 4.5:1 against the grain;
  forced-colours, more-contrast and print fall back to plain panels (MEM-044 P1;
  `static/theme_painterly.test.mjs`, `tests/test_assets_wiring.py`).
- The sticky top bar stays above the panels while scrolling, and the place-history legend sits on its own
  paper tab (MEM-044 P1; `static/theme_painterly.test.mjs`).

## [0.19.1] - 2026-10-30

### Changed

- Each said-vs-palace row puts the place, "You said:" and "In your palace:" on their own lines, and the route
  numbers each place in a fixed box so even "100." never runs into its label (MEM-044;
  `static/style_v6_components.test.mjs`).
- The numbered place badges on the scene use white text on #A1341A, about 7:1 contrast (MEM-044;
  `static/style_v6_components.test.mjs`).
- The Show/Hide toggles and the file chooser match the other buttons and respond on hover, and a route row's
  Up/Down/Drop buttons wrap together so Drop never sits alone (MEM-044;
  `static/style_v6_components.test.mjs`).

## [0.19.0] - 2026-10-30

### Added

- Generated demo rooms: `scripts/gen_room_fixtures.py` makes photo-like room images through the Meta
  text-to-image call (never retried, key-gated, dry-run option) and records them in the fixture MANIFEST,
  keeping rows it did not write (MEM-043; `tests/test_gen_room_fixtures.py`).
- `?room=<id>` opens a demo room, and Load demo fetches that room's fixtures (MEM-043; `static/app.test.mjs`,
  `tests/test_e2e_drive.py`).
- Live runs write a `.sha` sidecar beside each cache entry, so `scripts/promote_live_cache.py --room <id>`
  promotes only that room's entries (MEM-043; `tests/test_promote_live_cache.py`,
  `tests/test_live_cache_sidecar.py`).

### Fixed

- Promoting a room with no recorded entries exits 1 with "0 entries for room <id>" instead of silently copying
  nothing (MEM-043, Q25; `tests/test_promote_live_cache.py`).

## [0.18.1] - 2026-10-30

### Fixed

- A missing demo scene image shows plain-language copy instead of a raw error code (MEM-029;
  `static/app_ux_scene_fixture_missing.test.mjs`).
- Pressing Start recall before the server health check answers waits for the mode instead of guessing (MEM-032;
  `static/app_ux_start_before_health.test.mjs`).
- An empty Done after a speech relay failure keeps the failure message visible, and a run with points already marked
  got still saves (MEM-032; `static/app_ux_empty_done_after_relay_fail.test.mjs`).
- Overlapping Mark got it clicks keep the screen and the saved history in agreement (MEM-033;
  `static/app_ux_mark_got_overlap.test.mjs`).

## [0.18.0] - 2026-10-30

### Changed

- The app adopts the v6 painterly look: design tokens, light and dark color schemes, system fonts, panel and field
  styling, and 44px tap targets; Auto mode sits beside Load demo (MEM-044, ADR 0030; `static/style_v6.test.mjs`,
  `static/index_markup.test.mjs`).

## [0.17.3] - 2026-10-29

### Fixed

- After Generate, the association and scene cards collapse behind Show/Hide toggles and the walk scrolls into view
  (MEM-030; `static/app_ux_generate_collapse.test.mjs`).
- Uploading your own photo on a demo (fixture) server explains to use Load demo instead of showing raw
  "fixture_missing" (MEM-017; `static/app_ux_fixture_upload.test.mjs`).
- On a fixture server, Start recall goes straight to typed recall, never asking for the mic (MEM-032;
  `static/app_ux_fixture_start_typed.test.mjs`).
- Done is disabled before Start and after a saved run; an empty typed Done saves nothing and prompts to type first
  (MEM-032, MEM-033; `static/app_ux_done_guard.test.mjs`).
- Reordering route places keeps keyboard focus on the moved place's button (MEM-030;
  `static/app_ux_route_focus.test.mjs`).
- History rows show local time instead of raw UTC ISO (MEM-033; `static/app_ux_history_local_time.test.mjs`).
- A failed Mark got it save no longer claims success; the end screen says it could not be saved (MEM-033;
  `static/app_ux_mark_got_fails.test.mjs`).
- A failed history Delete keeps the row and shows "Could not delete" instead of an unhandled error (MEM-033;
  `static/app_ux_delete_fails.test.mjs`).

## [0.17.2] - 2026-10-29

### Fixed

- Double-clicking Start recall opens one mic, not two (MEM-032; `static/app_ux_start_twice.test.mjs`).
- Load demo is disabled while a demo load is pending (MEM-030; `static/app_ux_load_demo_twice.test.mjs`).
- Double-clicking replay saves one run (MEM-032, MEM-033; `static/app_ux_replay_twice.test.mjs`).
- A failing `AudioContext.close` falls back to typed recall, never an unhandled rejection (MEM-032, MEM-037;
  `static/app_ux_close_rejects.test.mjs`).
- An unavailable or corrupt rehearsal store shows "History unavailable", skips corrupt/null records, and the end
  screen still renders (MEM-033; `static/app_ux_history_unavailable.test.mjs`).
- The tests above drive the app through the shared harness `static/ux_flow_harness_test.mjs`.

## [0.17.1] - 2026-10-29

### Fixed

- E2E driver (`scripts/e2e_checks.py`, `e2e_steps.py`, `e2e_support.py`) no longer waits via `page.wait_for_function`,
  whose JS string the MEM-042 CSP (no `'unsafe-eval'`) refuses once it polls (step 12 failed, 21/22); it waits with
  locators / `expect` (`wait_status_ready`), back to 22/22. `tests/test_e2e_drive.py` `TestNoEvalWaits` fails if any
  `scripts/e2e_*.py` calls `wait_for_function`.

## [0.17.0] - 2026-10-29

### Added

- Palace backup (MEM-042, ADR 0028): `<section id="backup">` in `index.html`. "Download backup" writes
  `memripal-backup.json` (`{v: 1, palace_id: "demo", route, associations, rehearsals}`, `static/palace_export.js`
  `buildBackup`): rehearsal history, cached associations and the route, never photos or scene images. Only an
  entry's `record`/`status`/`sig` keys are exported; a store over an import cap gives "Export failed: <reason>" and
  no file, so every exported file imports.
- Import a backup (`importBackup`): a file over 1048576 bytes (`file.size`, then text byte length), not JSON, with
  other top-level keys, `v` not 1, another palace, or over a count cap is rejected whole, before any write, with
  "Import failed: <reason>". Every entry is checked against exact keys, types and caps before the first write; a bad
  entry is skipped. Merge is additive (an existing entry wins, nothing overwritten or deleted), result "Imported n,
  skipped m", then history re-renders. An unsigned entry is stored with status "invalid" so it regenerates; the
  route is imported only when none is stored. Imported text renders via textContent only.
- A /scenes 403 `bad_signature` re-puts that stored entry with status "invalid" (`static/encode.js`), so the next
  run regenerates it instead of reusing a dead signature (e.g. a backup signed under another instance's key).

### Security

- `src/memripal/security_headers.py` `SecurityHeaders` middleware, outermost of the app's middleware, sets a
  `Content-Security-Policy` (`default-src 'self'; img-src 'self' data: blob:; object-src 'none'; ...`) and
  `X-Content-Type-Options: nosniff` on every response, host refusals and 404s included (not Starlette's
  unhandled-error 500; ADR 0028). FastAPI `/docs` and `/redoc` no longer render.

## [0.16.0] - 2026-10-28

### Added

- v6 Review prototype source under `docs/design/v6/` (MEM-041) as a design reference, with a photo-crop regression
  test (`docs/design/v6/tests/crop_use_size.test.mjs`) run by `scripts/check.sh`.

## [0.15.0] - 2026-10-28

### Added

- Generated assets wired into the page (MEM-040): `manifest.webmanifest` keeps `icon.svg` first and adds
  `/static/assets/icon-192.png` (192x192) and `icon-512.png` (512x512), `image/png`, purpose `any`. `index.html`
  shows a decorative `<img id="empty-state">` (`/static/assets/empty-state.webp`) before `#scene-wrap`: centered,
  `max-width: min(100%, 360px)`; hidden once a palace's places are drawn (photo upload or Load demo) and never shown
  again that session.

## [0.14.0] - 2026-10-28

### Added

- `scripts/gen_assets.py` (MEM-038): generates the app icon (`icon-512.png`, `icon-192.png`) and `empty-state.webp`
  under `static/assets/` (`--out <dir>` overrides) with one Meta `image_edit` per asset on a blank white canvas (2
  paid calls, `max_retries=0`). `--dry-run` prints the plan and `calls: 2` (no key, no calls, no writes).
  `META_API_KEY` is required (unset or blank: exit 2); a failed asset keeps its existing files, the next still runs,
  exit 1. Writes files only; wiring them into the manifest / `index.html` is a later change.

### Changed

- On page load where IndexedDB exists, palace and rehearsal history saved in localStorage (`memripal.palace:`,
  `memripal.rehearsal:`) is copied into IndexedDB once (`static/storage_migrate.js`, MEM-039). A record already in
  IndexedDB wins; a malformed entry is skipped and kept; a prefix's localStorage keys are cleared only when every
  copy for it succeeded, else the next load retries.
- Recall replay failure now shows one line "Replay failed: <code>" in the results (`network`, the server's error code
  such as `demo_missing` else `http_<status>`, `bad_response`, `unexpected error`) and saves no rehearsal (MEM-039).

## [0.13.0] - 2026-10-28

### Added

- Live recall lighting (MEM-037): during spoken recall the page shows a board in `#recall-live` (badge "LIVE", one
  row per palace point) and lights each point (class `lit`) as soon as the matcher finds it. The mic clip is sliced
  every 5 s with 1 s overlap (`recordClip` `take()`, `static/recall_live.js` `createLiveRelay`) and each slice goes
  through the unchanged `POST /recall/audio` relay; Done posts only the untaken remainder. A relay failure falls
  back to typed answers with "Speech relay failed (<code>)"; lit points stay lit. Server unchanged; <= 37 ASR calls
  per 3-min run (36 slices + the Done remainder).
- `#recall-replay` shows the same board badged "recorded replay" and lights points as the replay plays. Typed mode
  has no board.
- E2E driver step "8b live board lights on replay" (`scripts/e2e_steps.py` `s_live_board`): badge reads "recorded
  replay", one board row per palace point, lit rows == got points (>= 1). The driver now runs 22 steps.

## [0.12.0] - 2026-10-28

### Added

- `scripts/e2e_drive.py` (+ `e2e_steps.py`, `e2e_checks.py`, `e2e_support.py`): 21-step Playwright browser E2E
  driver; starts its own fixture-mode server with `MEMRIPAL_ALLOWED_HOSTS=memripal-e2e.test` (inherited `MEMRIPAL_*`
  dropped); `--out`, `--base-url`; exit 0 all pass, 1 any failure, 2 server never ready. `tests/test_e2e_drive.py`
  locks its pure helpers. Not part of `scripts/check.sh`.
- `docs/submission/demo-script.md` (3-min demo script mapped to the judging rubric) and
  `docs/submission/checklist.md` (compliance + submission checklist).

### Changed

- README: submission framing, "Built during the hackathon" note, route-to-Meta-call table, AI-generated refs image
  disclosure, `MEMRIPAL_SEG_PROVIDER` / `MEMRIPAL_STT_PROVIDER` in Modes (STT toggle not yet wired into
  `POST /recall/audio`), E2E driver command in Setup.

### Fixed

- E2E step 11 (scratchpad driver ported into `scripts/e2e_drive.py`) asserted said-vs-palace in `#recall-results`
  after reload without a recall run, stale since history moved to its own section (MEM-033); it now checks the
  history rows before and after Load demo.

## [0.11.0] - 2026-10-28

### Added

- Recall end screen: "Mark got it" on each missed point stores an override; counts and hit rates update and the
  override survives reload (MEM-033).
- Rehearsal history + hit rates render on page load when runs are stored, in their own section
  (`static/history.js`); each row's "View" button shows that run's said-vs-palace from the stored record (MEM-033).

### Fixed

- `scripts/merge_branch.sh` skips `git rebase` when `main` is already an ancestor, so merge commits are no longer
  flattened.

### Security

- Signed association records, ADR 0027 (MEM-036): `POST /associate` signs each valid record (HMAC-SHA256, key from
  `MEMRIPAL_RECORD_KEY`, else a random per-process key) and returns `sig`; `POST /scenes` requires exactly
  `{image, box, record, sig}`: missing `sig` -> 400 `bad_request`, bad `sig` -> 403 `bad_signature`, both before any
  model call. `spatial`, `visual` and `scene_prompt_details` are capped at 300 chars. The client skips unsigned
  stored entries as tier 3 `unsigned`.
- Palaces stored before 0.11.0 show unsigned scenes until regenerated; multi-instance deploys must set
  `MEMRIPAL_RECORD_KEY` (a per-process key fails signatures across instances and restarts).

## [0.10.0] - 2026-10-28

### Added

- S4 `src/memripal/scenes.py` + `POST /scenes`: one whole-photo Muse Image edit per association under a 3-slot cap,
  never retried, re-encoded to JPEG at the photo dims; any failure is 200 tier 3 with a short `reason`; ADR 0024
  (MEM-027, MEM-028).
- S5 scene panel `static/scenes.js` (3 in flight, zoom to the locus box, full-size overlay) and encode UI
  `static/encode.js`: route review (reorder, drop with confirm + Undo), walk view (MEM-029, MEM-030).
- S6 client-side deterministic recall matcher `static/recall_match.js`, zero network calls; ADR 0026 (MEM-031).
- S6 `POST /recall/audio` (`src/memripal/recall_relay.py`): relays one mono 16-bit WAV clip (<= 1 MiB decoded) plus
  palace labels as keywords to Muse Voice Transcribe, returns `{"text"}`; fixture mode 409 `live_only`; audio never
  stored or logged (MEM-032).
- S6 `static/recall.js`: typed answers on the same matcher when the mic is missing or denied, never Web Speech;
  offline replay of `GET /demo/recall.json` (MEM-032).
- S6 `static/rehearsals.js`: stored rehearsals (JSON, no audio), per-point hit rates with chronic misses,
  said-vs-palace view, delete with confirm + Undo (MEM-033).
- S7 deploy guards, ADR 0025 (MEM-034): `MEMRIPAL_PASSCODE` gate (`X-Memripal-Passcode`) on every live model route,
  unset fails closed off loopback; `MEMRIPAL_ALLOWED_HOSTS` host allowlist; `MEMRIPAL_CALL_BUDGET` per-instance live
  call budget -> 429 `budget_exhausted`; `MEMRIPAL_MAX_BODY_BYTES` app-wide body cap.
- `/recall/audio` spends the call budget shared with the other model routes: refusals (401/415/413/400) spend
  nothing, a failed upstream call (502) still spends (MEM-032, MEM-034).
- S7 artifacts: `Dockerfile` (fixture mode, non-root, no secrets), `scripts/deploy_cloud_run.sh`
  (`--max-instances=1`, secrets only via `--set-secrets`), web manifest + icon, `#public-banner` on non-loopback hosts
  (MEM-034, MEM-035).
- Page flow `static/flow.js`: Load demo -> demo palace -> scenes -> walk -> recall panel (spoken, typed, or demo
  replay) -> rehearsal history with hit rates; a typed passcode rides as `X-Memripal-Passcode` on model routes
  (MEM-029..033).
- Spoken recall `static/mic_wav.js`: mic capture to 16 kHz WAV, relayed to `/recall/audio` in `MAX_CHUNK_BYTES`
  chunks; a relay error falls back to typed answers and names the error code (MEM-032).
- IndexedDB KV adapter `static/idb_adapter.js`; `selectStore` backs the palace and rehearsal stores with IndexedDB
  when present, else localStorage (MEM-033).

### Changed

- Palace and rehearsal stores move to IndexedDB where available; history already in localStorage is not migrated
  and goes unread while IndexedDB is present (MEM-033; migrated as of 0.14.0, MEM-039).
- README: intro and recall flow describe the shipped misses, hit rates and demo -> scenes -> walk -> recall page.

### Fixed

- S4 security review: decompression-bomb PNG -> scene tier 3 `decode_error` and `POST /loci` 400 `decode_error`;
  bounded slot wait `SLOT_WAIT_S` -> tier 3 `busy`; tier-1 JPEG carries no comment; `MetaClient.image_edit` sends one
  attempt; live timeouts map to `timeout` (MEM-027, MEM-028).

## [0.9.0] - 2026-10-27

### Added

- `MEMRIPAL_CHAT_PROVIDER=meta|baseten|fireworks|local` (default `meta`, live mode only) moves Spark chat to an
  OpenAI-compatible host; segmentation stays on Meta; answers cached under `<provider>/<provider model>`; ADR 0023
  (MEM-026, D12).
- `scripts/run_live.ps1` also loads `~/.secrets/<provider>-api-key.dpapi` for `baseten` / `fireworks`; missing file
  exits 2 before the child starts (MEM-026).

## [0.8.0] - 2026-10-27

### Added

- S3e opt-in place context, server side: `POST /place` lookup; optional `place` on `POST /associate`, rejected with
  400 `place_too_long` (title over 255 or extract over 400 chars) or `bad_place`; ADR 0022 amends ADR 0009 (MEM-025).
- S3e client: place toggle, EXIF GPS read, typed place, "Near:" chips, CC BY-SA attribution (MEM-025).
- Demo place fixtures plus place-keyed association replays, so the demo runs offline with place on (MEM-025).

### Fixed

- `src/memripal/__init__.py` `__version__` synced to the package version.

## [0.7.0] - 2026-10-27

### Added

- S3a `POST /split` + shared text normalizer `src/memripal/textnorm.py`: list mode without a model call, notes mode
  via one image-less Spark call and one regeneration; ADR 0019 (MEM-020).
- S3b `src/memripal/associate.py` + `POST /associate`: KAVE COGS association per (item, locus), validated in code,
  up to 2 regenerations; ADR 0020 (MEM-021).
- S3c client palace store `static/palace_store.js` + `runAssociations` generate/resume flow; ADR 0021 (MEM-022).
- S3d demo notes `fixtures/demo/notes.txt` served at `GET /demo/notes.txt`, with replayed split and associations so
  the whole demo runs offline (MEM-023).
- `scripts/merge_branch.sh` one-command branch merge (MEM-024); `scripts/screenshot_ui.py` visual-verify helper.
- README HTTP API table.

### Fixed

- UI: demo/upload status names the HTTP status and an unreadable response (MEM-017).

## [0.6.1] - 2026-10-27

### Fixed

- `scripts/merge_branch.sh` resolves `request_merge.py` via `AGENT_WORKFLOW_DIR` instead of a hardcoded path; unset
  falls back to a solo `git merge --ff-only` that skips the merge queue (MEM-024).

## [0.6.0] - 2026-10-27

### Added

- S2.3b `find_loci` with deadline and `on_progress`; ADR 0014 loci prompt args + progress semantics (MEM-014).
- S2.4 `POST /loci` endpoint with host guard, ASCII content-length check and internal error mapping (MEM-015).
- S2.5 seg provider toggle `src/memripal/seg_provider.py` + Modal SAM adapter, wired into the backend: Modal segment
  failures raise `BackendCallFailed`, cache key is provider-distinct; ADR 0018 (MEM-016).
- S2.6 upload UI + demo fixtures; Load demo uploads raw bytes (ADR 0016), shared upload-flow stale-response gate,
  clear on new upload, `demo_missing` 404 (MEM-017).
- Live-mode response cache in gitignored `refs/private` with photo save; ADR 0017 (MEM-014).
- Local Whisper STT provider toggle `src/memripal/stt_provider.py`; ADR 0015 (MEM-019).
- Pre-commit runs the ADR structure test when `docs/decisions/` is staged (MEM-018).
- README pipeline diagram, Meta model table, ADR links.

### Changed

- README: re-recite of misses marked planned, user-driven; intro describes spoken recall per ADR 0008.
- Ruff pins `memripal` as first-party for deterministic import sort.

### Fixed

- Live cache: best-effort cache writes, photo-first, two-way containment; an existing photo counts as success so the
  response is cached (MEM-014).
- UI: single list numbering, label-only list items (MEM-017).
- Secret scan: word boundary before `sk-` (MEM-004).
- Modal box parsing drops non-finite and overflowing numbers (MEM-016).
- Live probe rejects a bool ASR duration; `asr_ok` follows `CallResult.ok`.

## [0.5.0] - 2026-10-26

### Added

- S2.3a `ModelRequest` + derived `RequestKey` in `src/memripal/backend.py`: photo_sha derived from image bytes, digest-compatible
  with `CacheKey`; `MetaBackend.call()` writes through only schema-valid content; atomic `ResponseCache.put` (MEM-014).
- ADR 0013 derived request key.

## [0.4.0] - 2026-10-26

### Added

- Architecture decision records `docs/decisions/` (12 ADRs + index), linked from README; structure enforced by
  `tests/test_decisions_structure.py` (MEM-018).
- Repo `CLAUDE.md`: every architectural decision gets an ADR in the same change.
- S2.1 image intake `src/memripal/imaging.py`: validation, pixel-bomb guard, no re-encode of processed JPEGs (MEM-012).
- S2.2 locus selection (MEM-013).
- Spec IDs MEM-012..MEM-018 for S2 Loci; MEM-003 CacheKey/ModelBackend bullets superseded by MEM-014.
- Pre-commit hook also runs `ruff format --check` on staged Python files, with an integration test.

### Fixed

- Deploy runbook: GCP trial credit is $299, not $300.

## [0.3.0] - 2026-10-26

### Added

- Meta speech-to-text client `MetaClient.transcribe` + `transcript_text` in `src/memripal/meta_client.py` (MEM-010).
- Live probe optional `--audio <clip.wav>`, adding `asr_ok` / `asr_transcript_nonempty` / `asr_has_duration` checks
  and an `asr` report block (MEM-011).

## [0.2.0] - 2026-10-26

### Added

- Meta Model API client `src/memripal/meta_client.py`: Spark chat, SAM segmentation, image edits (MEM-006).
- SAM box parsing, locus selection and image-edit drift metrics `src/memripal/probe_metrics.py` (MEM-007).
- Live probe `src/memripal/probe.py` + `scripts/probe_live.py`, writing `report.json` and `tier1.webp`/`tier2.webp`
  (MEM-008).
- Key-custody launcher `scripts/run_live.ps1`: DPAPI key file decrypted into the child process env only (MEM-009).

### Changed

- `httpx` is now a runtime dependency.

## [0.1.0] - 2026-10-26

### Added

- Project scaffold (Python 3.13, uv, FastAPI, static frontend).
- Health endpoint `GET /healthz` and static shell `GET /` (MEM-001).
- Backend modes `fixture|meta` via `MEMRIPAL_MODE` (MEM-002).
- Logical-key write-through response cache and fixture replay (MEM-003).
- Synthetic demo fixtures with MANIFEST (MEM-005).
- Pre-commit scan for secrets and image EXIF, wired via `.githooks/pre-commit` (MEM-004).
