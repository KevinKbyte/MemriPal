# MemriPal spec (continuation)

Continuation of [spec-3.md](spec-3.md), which is over its 500-line cap.

## MEM-068 merge_branch ff race: auto re-bump + retry

Decided-by: ADR [0034](../../../../docs/decisions/0034-merge-branch-rebump-retry.md). Amends MEM-024 (spec.md, at
its line cap): a non-ff on the solo fallback because `main` moved no longer exits with git's code.
- Trigger: no-queue path (`MEMRIPAL_REQUEST_MERGE_CMD` unset, no `$AGENT_WORKFLOW_DIR/scripts/request_merge.py`);
  `git merge --ff-only` fails and `main` is not an ancestor of the branch. `main` still an ancestor -> exit with
  git's code, no re-bump.
- Round: the last commit's subject must start `chore: bump version to `, else exit 1, stderr "not a version bump",
  branch untouched. Drop it, `rebase main`; conflict -> `rebase --abort`, branch reset to its pre-round tip (bump
  commit intact), exit 1, stderr names the rebase. Re-bump to main's `pyproject.toml` version + 1 patch in: the
  first `version =` of `pyproject.toml`, `__version__` in `src/memripal/__init__.py`, the memripal stanza of
  `uv.lock` only, and a new top `## [<v>] - <today>` CHANGELOG heading carrying the dropped entry's body. Re-commit
  with the same message, version swapped. Main's version unreadable -> branch reset, exit 1. Re-run the worktree's
  `scripts/check.sh` (failure -> its code), retry the ff.
- Cap: 3 re-bump rounds after the first attempt; a 4th race -> exit 1, stderr "gave up after 3 re-bump rounds",
  `main` left at the racer.
- Accept: one race -> main + 1 lands, entry body kept; a racer that did not change the version still re-bumps from
  main's version; 3 races land on round 3; a 4th exits 1; non-bump tail refused, branch unchanged; retry conflict
  restores the branch with its bump; `dependencies = ["zzdep>=0.1.1"]`, lock top-level `version = 1` and the zzdep
  stanza survive.

Tests: tests/test_merge_branch_race.py

## MEM-069 merge_branch visual-verify gate on ff + override paths

Decided-by: ADR [0035](../../../../docs/decisions/0035-merge-branch-visual-verify-gate.md). Amends MEM-024.
- Scope: runs before the merge on the `git merge --ff-only` fallback and the `MEMRIPAL_REQUEST_MERGE_CMD` override
  path; skipped on the `request_merge.py` path, whose preenqueue gates run `visual_verify_merge_gate.refuse_reason`.
- UI paths: `git diff --name-only main...HEAD` classified like agent-workflow
  `hooks.global/visual-verify-commit-gate.py::is_ui_path`: `.js .mjs .ts .tsx .jsx .html .vue .svelte .css`, except
  under `scripts/` or any `test/`/`tests/`/`__tests__/` dir, `.test.`/`.spec.` filenames, and `.js`/`.mjs`/`.ts`
  under `core/`/`bg/`/`workflows/`/`workflows.global/` or named `background`/`service-worker`/`service_worker`. No UI
  path -> lookup not consulted.
- Lookup seam: `MEMRIPAL_VISUAL_VERIFY_CMD` (word-split) run as `<cmd> <primary> <branch> main`; exit 0 = verified,
  else refuse (its stderr surfaced). Unset: `refuse_reason(<primary>, <branch>, "main")` from
  `${AGENT_WORKFLOW_DIR:-$HOME/projects/agent-workflow}/scripts/visual_verify_merge_gate.py` via `uv run`; file
  missing -> fail closed, exit 1, stderr names the path. That default dir never selects the `request_merge.py` path.
- Refusal: exit 1 before any merge/enqueue (`main` untouched, primary `scripts/check.sh` not run); stderr
  "visual-verify gate refused; unverified UI path(s):" plus only the UI paths.
- Accept: ff and override UI diff without a record refused, with one merges/enqueues; non-UI diff skips the lookup;
  classification table matches the real `is_ui_path`; request_merge path delegates; missing module fails closed;
  `AGENT_WORKFLOW_DIR` honored for the lookup only.

Tests: tests/test_merge_branch_visual_verify.py
## MEM-070 Design gate: tip-rendered design evidence + recorded approval (PLANNED)

PLANNED, not built, unverified: no code adopts it. ADR [0036](../../../../docs/decisions/0036-design-gate.md).
Decided-by: ADR-0036
Root problem: design evidence a branch carries can be stale (a PNG from an earlier commit) or not evidence at all (a
`README.md`), so a `docs/design/**` change can land without proof it renders at the merged commit.
Actors: `scripts/design_gate.py`, `scripts/approve_design.py` (Kev only), the MEM-067 tools
(`scripts/screenshot_design.py`, `scripts/check_route_css.py`).
- Scope: a branch whose diff touches `docs/design/**`.
- `scripts/design_gate.py` takes its OWN screenshots of the design preview at the branch tip via
  `scripts/screenshot_design.py`; committed or caller-supplied PNGs are never the evidence. Fails on any of:
  - a page or console error (`screenshot_design.py` `ERR` line, exit 1);
  - `scripts/check_route_css.py <css> <contract>` (exactly 2 args) not exit 0;
  - horizontal overflow at the 375 px width (rendered page wider than the viewport);
  - axe contrast or tap-target violations > 0;
  - an id or class used in a CSS selector, or named by the contract, absent from the rendered DOM.
- Evidence refusal: evidence that is a `README.md`, or a PNG not produced at the current tip commit (an old PNG),
  is refused.
- Approval: a changed shot needs Kev's approval recorded by `scripts/approve_design.py`, an ask-listed command
  (human-run, never agent-run). A changed shot without a recorded approval fails the gate.
- Pass: fresh tip shots, every check clean, every changed shot approved.
- Accept: README.md as evidence -> refused; PNG from an earlier commit -> refused; fresh tip shots with a changed
  shot and no approval -> fail; fresh tip shots + approval -> pass; each check above failing alone -> fail.

## MEM-071 Lint gate inside pytest

Decided-by: ADR [0037](../../../../docs/decisions/0037-lint-in-pytest.md)
Root problem: on 2026-10-31 two E501s reached main (3da4970 via MEM-034 418fd73; e5a6ead, fixed by a8c8daf). MEM-034
was enqueued by calling agent-workflow `scripts/request_merge.py` directly, which skips `scripts/merge_branch.sh` and
so `scripts/check.sh`, the only place ruff ran. The queue drain's verify (agent-workflow
`scripts/post_merge_verify.py`) runs only pytest, often affected-only on changed test files.
Actors: `tests/conftest.py`, ruff, the agent-workflow queue drain, `scripts/merge_branch.sh`.
- `tests/conftest.py` appends one `ruff-lint` item to every pytest session (`hookimpl(trylast=True)` on
  `pytest_collection_modifyitems`, so after `-k`/`-m` deselection) running `sys.executable -m ruff check <rootpath>`.
- Nonzero exit fails the item with ruff's output. So any pytest run, including a single-file target or a `-m`
  filtered run, fails on a lint error anywhere in the repo (tests or src); a clean repo passes.
- Same interpreter as pytest (ruff and pytest share the dev dependency group), so a missing ruff fails closed.
- `merge_branch.sh` with the real `check.sh` still refuses a lint-error branch before enqueue.
- Residual: a drain run whose changed files map to zero test targets skips pytest entirely, so a lint error there is
  uncaught; closed by the agent-workflow follow-up (drain runs a repo-declared check command).

Tests: tests/test_lint_gate.py
## MEM-072 Route-first flow: map-first shell, set the route, pick loci from alternatives, capture anytime (PARTIAL)

PARTIAL: map-first shell built (home real map, right drawer, bottom tabbar Routes/Landmarks/Recall/Settings, Load demo
lands on the map); loci generation/alternatives (S2-S4) still PLANNED. ADRs
[0038](../../../../docs/decisions/0038-route-first-flow.md) (amended 2026-11-01: map-first shell, map source),
[0045](../../../../docs/decisions/0045-map-first-shell-tabs-and-panel-placement.md) (shell build).
Decided-by: ADR-0038, ADR-0045
Root problem: the route design is capture-first, but Kev requires route-first: set the route, the app generates
landmark loci with alternatives, the user swaps or adds them fine-grained, and own landmark photos supplement the
route at any time (as a generation hint or a user-added stop). Kev then rejected the card-list layout for a
Google-Maps-like map that must stay usable at 1000+ topics, routes and landmarks.
Actors: the user; Muse Spark (loci generation); `docs/design/route/{map-shell.html,map-shell.css,route-contract-2.md}`
(shell); `docs/design/route/{preview.html,route.css,route-contract.md}` (S2-S9 flows).
NFR: off-route landmarks exist in the DOM only inside viewport + margin; route list windowed; reduced motion = instant.

Map-first shell (2026-11-01, contract `docs/design/route/route-contract-2.md`):
- Home = map showing ONLY the selected route: topic-coloured path, numbered stations, emoji landmark markers. Route
  switch: 800 ms viewBox drift, path draw-in, staggered landmark pop-in; `prefers-reduced-motion` = instant.
- Click or ~500 ms long-press on a landmark opens its card; Enter/Space does the same; Escape closes and refocuses.
- Landmark filter "This route" (default) / "All landmarks": off-route landmarks muted grey, rendered only inside the
  viewport + margin, recomputed on pan end, zoom end and tween end.
- Right-side drawer: this route's settings (name, how often, topic typeahead with recents), "Map a new route"
  (`#map-new`, enters S2), existing routes (search, recents, grouped by topic, virtualized list).
- Bottom tabs Routes / Landmarks / Recall / Settings. No global legend: the chip shows the current route's topic
  as colour dot + name. Fixed ~8-colour palette, deterministic per topic id, user-overridable, text beside colour.
- Map source: stylized SVG only until after the hackathon; MapLibre + self-hosted PMTiles (`geo` routes) with SVG
  `sketch` routes is staged as plan B15, adopted only when ADR 0038's map-source conditions hold.
- Preview states: `?s=closed|open|landmark|hidden`, `?lm=route|all`.
- Accept (shell): exactly one route's path in `#route`; filter All at any pan/zoom puts only in-viewport (+ margin)
  off-route landmarks in the DOM; route list DOM rows stay bounded at 1000 routes; long-press and keyboard open the
  same card; each `?s=` / `?lm=` state screenshots at 375 px with no page or console errors.
- Accept (shell build, ADR 0045): Load demo -> real map fills the viewport above the tabbar with the Kendall route, at
  375x812 and 1280x800, light and dark; tabbar visible at the bottom; each tab click sets `aria-current` on itself
  only and shows its panel; drawer opens/closes; every existing id stays exactly once; `#scene-overlay` stays a direct
  child of `main`.

Card-list flow (2026-10-31); S2-S9 flow rules still apply:
- **Superseded by MEM-072 map-first shell (above):** S1 entry is route setup: `#routes-new` reads "New route". Now
  the map is home and `#map-new` "Map a new route" starts S2.
- S2 Set the route: start and end picked on the map or from familiar places (stations of past routes, on the phone),
  end = loop by default, stops 3-8 (default 5), own photos used as hints toggle, "Find landmarks". No typed
  geocoding; only landmark positions leave the phone, and only with the place setting on.
- S3 Pick landmarks: every locus shows its chosen landmark plus an alternatives row; each alternative offers "Use
  this" (swap) and "Add too" (insert beside); per-locus "Add all" adds only into free slots, labelled with the
  count, disabled at 8 with the reason; a counter chip shows n/8; leftovers stay as alternatives with a notice.
- S4 Fix the route (`#route-review`): name, kind, order, drop; rows tagged Suggested / Your photo. While a list is
  memorised on the route, insert, drop and reorder are blocked ("Retire the list first"); a 1:1 swap keeps the
  station id and warns its items need re-learning.
- Capture is reachable from every screen (`.topbar-capture`) and never asks hint-or-stop: before Find landmarks a
  capture is a generation hint; after, it is a "Your photo" alternative on the nearest locus; a capture opened from
  a locus card lands on that locus.
- S5 shows source tags (Suggested / Your photo) and Capture; S6-S9 unchanged apart from Capture.
- Accept (flow): **Superseded by MEM-072 map-first shell (above):** S1 primary action is "New route" (now
  `#map-new` in the drawer). Still binding: every S3 locus card shows >= 1 alternative with Use this + Add too; Add
  all at 6/8 with 3 candidates adds 2 and keeps 1 as an alternative; Add all at 8/8 is disabled with a reason;
  capture button present on S1-S9; no capture screen shows a required hint-or-stop choice; check_route_css.py and
  design_gate.py pass at 375 px.

Tests: static/tabbar.test.mjs, static/index_markup.test.mjs, tests/test_real_map_e2e.py

## MEM-073 Retire the room-photo upload flow (step 1 of 2)

Decided-by: ADR [0040](../../../../docs/decisions/0040-retire-room-photo-flow.md). Supersedes MEM-017's photo-pick
upload and MEM-025's `onPhotoChange` place path; step 2 (Load demo -> demo route, `/loci` deleted, no 410) is plan B10.
Root problem: the route-first pivot dropped room segmentation (objects move), but the page still lets a user pick a
room photo and post it to `/loci`, and the first screen asks for one.
Actors: the user; `static/app.js`, `static/index.html`; `scripts/screenshot_ui.py`; `fixtures/demo/route_backup.json`.
NFR: none.
- `static/app.js`: no `onPhotoChange` export and no `#photo` `change` listener; picking a file sends no request. The
  `<input id="photo">` element stays, unhandled (plan A5 re-homes `#photo`, `#meta-notice`, `#upload-status` to S2
  capture). Load demo (`flow.js` -> `runDemoPalace` -> `/loci`) is unchanged until B10.
- `static/index.html`: no "room photo" / "photo of a room" text; first-screen copy is neutral; every A5 id kept
  exactly once.
- `scripts/screenshot_ui.py`: also writes `route_view.png`, the route view after importing the committed backup-v2
  fixture `fixtures/demo/route_backup.json` through `#backup-import`; `initial.png` and `load_demo.png` unchanged
  until B10 drops the room shot.
- Accept: a `#photo` change sends no request and `app.js` exports no `onPhotoChange`; `index.html` has no "room
  photo" / "photo of a room" text and the A5 id tests stay green; `screenshot_ui.py` writes `route_view.png` from the
  backup fixture.

Tests: tests/test_screenshot_ui.py, static/index_markup.test.mjs, static/app_photo_retired.test.mjs,
static/route_backup_fixture.test.mjs

## MEM-080 Mark got it on a route point said out of order

Amends MEM-033 (end-screen override) for route runs (MEM-051).
Root problem: on a route run a station said out of order is got (the matcher heard it) but its hit is false
(`countInOrder` did not count it). The end screen offered "Mark got it" only on points that were not got, so the user
could not credit that station towards Learned n/N or its hit rate.
Actors: the user; `static/recall_end.js`, `static/flow.js`.
- `pointCounted(record, i)`: point i is got and, when the record has hits, its station's hit (the i-th hits key,
  route order) is true. A record without hits counts got alone.
- `renderEndScreen` puts "Mark got it" on every point that does not count; `markPointGot` then sets that station's
  hit true (got stays true). A failed override write reports the point as still missed when it does not count.
- Accept: a route run with point 1 got/not hit and point 2 missed shows the button on rows 1 and 2 only; marking
  point 1 sets its hit true and removes its button; a non-route run shows no button on got points.

Tests: static/recall_end_order.test.mjs
## MEM-074 Real map: Kendall Square PMTiles extract build (PLANNED)

PLANNED, not built, unverified: extract script not written. Vendored runtime assets landed at 1e46d72 under this ID
(maplibre-gl 5.24.0 CSP trio, pmtiles 4.5.0 IIFE, `@protomaps/basemaps` 5.7.2 build-time, Noto Sans glyph ranges +
v4 sprites; provenance and sha256 in each `VERSION`).
ADR [0041](../../../../docs/decisions/0041-real-map-whole-file-pmtiles.md).
Decided-by: ADR-0041
Root problem: ADR 0038 option A needs real Kendall Square streets served same-origin; the only official extractor is
the Go `pmtiles extract` CLI and the host has no Go.
Actors: `scripts/build_map_extract.py` (planned), PyPI `pmtiles` 3.8.1 (`Reader`, `Writer`), the build.protomaps.com
planet, `static/map/kendall.pmtiles`, `static/map/VERSION`.
NFR: output <= 3 MiB (3,145,728 bytes); build-time only, no runtime network; pytest never touches the network.
<!-- claim-exempt: planned -->
- Source: build key from `https://build-metadata.protomaps.dev/builds.json` (latest, or an explicit key); planet
  `https://build.protomaps.com/<key>.pmtiles` read by `Reader` over an HTTP-Range `get_bytes`.
- Scope: BBOX `(-71.1083, 42.3494, -71.0719, 42.3764)` (min lon, min lat, max lon, max lat), zooms 12-14; every tile
  intersecting the bbox at each zoom; raw stored bytes (gzip MVT) copied, never re-encoded.
- Output: `Writer` in ascending tile-id order (clustered); header tile type MVT, tile compression gzip, bounds = bbox,
  zooms 12-14; planet metadata (`vector_layers`, attribution) carried over.
- Commit `static/map/kendall.pmtiles`; append build key, bbox, zooms and output sha256 to `static/map/VERSION`.
  <!-- claim-exempt: planned -->
- Accept (fake in-memory planet + the committed file): magic `PMTiles`, version 3; min/max zoom 12/14; bounds == bbox
  at e7 precision; tile count == the count enumerated from the bbox, none outside it; tile bytes identical to the
  source's; committed file <= 3,145,728 bytes.

## MEM-075 Real map: light/dark style generation (PLANNED)

PLANNED, not built, unverified. ADR [0041](../../../../docs/decisions/0041-real-map-whole-file-pmtiles.md).
Decided-by: ADR-0041
Root problem: stock Protomaps styles fetch glyphs and sprites from a github.io CDN and emit no labels unless `lang` is
set, breaking ADR 0038 conditions 5 and 8.
Actors: `scripts/build_map_style.mjs` (planned), `vendor-node/protomaps-basemaps/basemaps.js` 5.7.2,
`static/map/style-light.json`, `static/map/style-dark.json`, `static/map/{fonts,sprites}`.
NFR: deterministic (re-run is byte-identical); no network. <!-- claim-exempt: planned -->
- `layers("kendall", namedFlavor("light" | "dark"), {lang: "en"})` per flavour; source `kendall` =
  `{type: "vector", url: "pmtiles://kendall"}` with the Protomaps + "(c) OpenStreetMap contributors" attribution.
- `glyphs` -> `map/fonts/{fontstack}/{range}.pbf`, `sprite` -> `map/sprites/v4/<flavour>`, module-relative paths the
  MEM-076 loader resolves against `import.meta.url`.
- Accept: both files parse; 0 `http(s)://` in `sources.*.url`, `glyphs`, `sprite`; >= 1 `symbol` layer with
  `text-field` per flavour; every `text-font` stack has a dir under `static/map/fonts`; sprite files for both flavours
  exist; a second run is byte-identical.

## MEM-076 Real map: lazy loader, validation, sketch fallback, theme flavour (PLANNED)

PLANNED, not built, unverified. ADR [0041](../../../../docs/decisions/0041-real-map-whole-file-pmtiles.md) conditions
1-4.
Decided-by: ADR-0041
Root problem: the basemap must never blank the route view: Capacitor may answer a missing asset with `index.html` 200,
the shell's `apiUrl()` sends root-relative paths cross-origin, and the whole-file fetch is slow on web links.
Actors: a planned loader module in `static/`, `static/route_map.js` (sketch, kept), `static/route_view.js` call sites
(`#route-map`, `#recall-map`), vendored `static/vendor/maplibre` and `static/vendor/pmtiles`.
NFR: no fetch at app boot; one extract fetch per session, held as a Blob.
- Trigger: route-view entry for a `geo` route with every station inside the bbox; else sketch only.
- Fetch: one GET of module-relative `map/kendall.pmtiles`, no `Range` header, never via `api_base.js`.
- Validate: `res.ok`, bytes 0-6 == `PMTiles`, byte 7 == 3, byteLength <= 3 MiB; any failure -> sketch stays.
- Wire: `maplibregl.setWorkerUrl` -> vendored `maplibre-gl-csp-worker.js`; `addProtocol("pmtiles", ...)`;
  `protocol.add(new PMTiles(new FileSource(new File([blob], "kendall"))))`.
- Sketch until ready: the SVG sketch renders immediately and is replaced on the map's first `idle`.
- Theme: app theme light/dark selects `style-light.json` / `style-dark.json`; a theme change swaps the style.
- Accept (fake fetch): 404, HTML body with 200, body < 127 bytes, oversize -> sketch, no map; valid archive -> map;
  0 fetches before route view; request carries no `Range`; URL neither root-relative nor absolute; module does not
  import `api_base.js`; dark theme -> `style-dark.json`.

## MEM-077 Real map: one SVG overlay, viewport-only markers, a11y, attribution (PLANNED)

PLANNED, not built, unverified. Folds plan item 18 (off-screen landmarks not in the DOM). ADR
[0041](../../../../docs/decisions/0041-real-map-whole-file-pmtiles.md); ADR 0038 map-source conditions 3, 4, 6, 7, 9.
Decided-by: ADR-0041
Root problem: two basemaps (map, sketch) must share one route renderer, and markers must stay bounded at 1000+
landmarks.
Actors: the MEM-076 loader, MapLibre `map.project`, the route overlay SVG.
NFR: DOM marker count == station count + in-viewport landmark count after every `moveend`.
- One SVG overlay above the canvas, re-positioned via `map.project([lon, lat])` on `move`; no route layers in the style.
- Markers: stations (3-8 per route) are always drawn, pinned to the map edge when off-map (Q2 below). Viewport
  culling (viewport + 25% margin, `map-shell.js` `cull()`, recomputed on `moveend`) applies only to off-route
  landmarks, per ADR 0038 rule 3; the app has none yet. Amended 2026-11-02 (item 11): previously all stations and
  landmarks were culled, which contradicted Q2.
- A11y: map canvas container `aria-hidden="true"`; the route and landmark lists stay the accessible path.
- Attribution: Protomaps + "(c) OpenStreetMap contributors" visible without interaction at 375 px.
- Any station outside the bbox -> the whole route renders as sketch.
- Accept: each station's overlay point within 1 px of `map.project` after a pan and a zoom; marker DOM count ==
  station count + in-viewport landmark count at 3 viewports; canvas container `aria-hidden="true"`; attribution text visible at 375 px; one
  out-of-bbox station -> sketch and 0 extract fetches.

Product rule, route as memory palace (Kev, 2026-11-02): the route IS the palace, so it must be worth keeping.
- Every route has a real A->B purpose: a place the user goes often or now and then and could reach without GPS
  (e.g. station -> Meta office). That practical use is why the brain keeps it; study items attach afterwards.
- A stable landmark at every turn: permanent buildings, corners and fixtures, never transient things (MEM-079).
- Walkable from the station list alone: the ordered list replays the whole walk with no map. Demo routes (S6) obey this
  rule.

Map behaviours (Kev Q1-Q3, 2026-11-02; preview `docs/design/map/`, shots via `scripts/screenshot_map.py`):
- Q1: panning never draws the route over the side panel; the overlay is clipped to the map (`.mp-wrap` overflow
  hidden).
- Q2: a station whose true spot is off the map is pinned to the map edge at the nearest point to that spot, with class
  `lm-pinned` and an `.lm-arrow` rotated toward it; a station on the map is never pinned.
- Q3 list-detail: the station list item IS the station's detail (profile + its one stored study item across the 8
  channels). Markers select into the list: a marker click or Enter/Space expands that item, moves focus into it, rings
  the marker (`lm-selected`) and eases the map so the station is pinned or nudged into view. On phone the list grows
  to max-height 60%. Escape collapses it and refocuses its button. This replaces the map-shell `#lm-card` popover
  (route-contract-2 M.3, amended there) on the real map.
- Accept: after a pan no overlay pixel lies outside the map; every off-map station has `lm-pinned` + `.lm-arrow`
  and no on-map station has `lm-pinned`; clicking a marker expands exactly its list item with focus inside and the
  marker has `lm-selected`; Escape collapses it and focuses its button.

## MEM-078 Real map: security and privacy (PLANNED)

PLANNED, not built, unverified. ADR [0041](../../../../docs/decisions/0041-real-map-whole-file-pmtiles.md) conditions
6 and 9; ADR 0038 map-source conditions 1 and 8.
Decided-by: ADR-0041
Root problem: the map must not widen the CSP, add a third-party origin, or leak location.
Actors: `src/memripal/security_headers.py`, `scripts/build_mobile_web.mjs` (native CSP), `src/memripal/app.py`
(static mount), a Playwright e2e on the map page.
NFR: web and native CSP strings unchanged.
- CSP unchanged on web and native; MapLibre's worker loads same-origin via `setWorkerUrl` (no `blob:` worker).
- Every map request is same-origin; no request URL carries coordinates (the extract URL is constant; tiles are read
  in memory).
- `.pmtiles` served as `application/vnd.pmtiles`.
- Accept: CSP strings equal their pre-map values; 0 `securitypolicyviolation` events on the map page; 0 requests to a
  non-page origin during load, pan and zoom; 0 request URLs matching a lat/lon pattern; `GET
  /static/map/kendall.pmtiles` Content-Type == `application/vnd.pmtiles`.

## MEM-079 Station landmark box marks a fixed structure only

Amends MEM-049 (Spark reply contract). Decision (Kev, 2026-11-02, design-floor item 26): option (a), keep ONE SAM box
per station on a phrase constrained to permanent objects; rejected (b) one SAM call per candidate (N calls on the
shared /station + /loci rate budget; "largest box" favours walls and buses), (c)/(d) multi-loci rooms (revive /loci;
objects move). Recorded in ADR [0040](../../../../docs/decisions/0040-retire-room-photo-flow.md) (note 2026-11-02).
Root problem: the station prompt asks for FIXED structures, but `_checked_reply` checked only length, so a reply
naming "parked car" became the station box. SAM takes one phrase per call and cannot judge permanence, so the check
belongs on the phrase.
Actors: Muse Spark; `src/memripal/station.py`.
- `MOVABLE_NOUNS` = person, people, man, woman, child, dog, car, bus, bike, scooter, truck, chair, table, cart, bag,
  umbrella, cone. `movable_phrase(phrase)`: any alphabetic word, lower-cased, equal to an entry or to an entry + "s" /
  "es".
- A movable landmark_phrase breaks the reply contract like a bad name: one regenerate, then `BadReply` (502
  `bad_reply`). A movable phrase is never sent to SAM. The prompt is unchanged (replay keys stay stable).
- Known cost: fixed things named with a listed word ("bus shelter", "bike rack") are re-asked too.
- Accept: replies "red chair", "parked car", "person by door", "Two Bikes", "PEOPLE" -> BadReply after 2 Spark calls,
  no segment request with that phrase; "parked car" then "brick arch" -> exactly 1 box.

Tests: tests/test_station.py

## MEM-082 Start-screen Pal

Supersedes the `empty-state.webp` parts of MEM-040 (Kev, 2026-11-03). Manifest icons, the `style.css` 360 px rules
and the palace hide rule stay.
Decided-by: none
Root problem: the start screen showed a static WebP; the app mascot (Pal) should greet the user, animated where
motion is allowed, without widening the CSP or adding script to an image.
Actors: the user; `static/index.html`, app JS, `static/assets/pal-idle.svg`, `static/assets/pal-still.svg`; source
dog-mascot `public/pal/` (`export_pal.js`).
NFR: CSP unchanged (`img-src 'self' data: blob:`); SMIL in an `<img>` runs no script; ASCII only.
- Assets: `static/assets/pal-idle.svg` (SMIL auto-blink, 4 s loop, `repeatCount="indefinite"`) and
  `static/assets/pal-still.svg` (same frame, no animation), copied from dog-mascot `public/pal/`; bytes identical to
  the source.
- `index.html`: `<img id="empty-state" src="/static/assets/pal-idle.svg" alt="">`, same position as MEM-040; a bare
  `<img>`, no `<object>`, `<embed>` or inline SVG.
- Reduced motion: when `matchMedia('(prefers-reduced-motion: reduce)')` matches, app JS sets `src` to
  `/static/assets/pal-still.svg`.
- Visibility: gets the `hidden` attribute once a palace's places render (MEM-040 rule, kept) AND once a route exists
  (e.g. Load demo seeds the Kendall route, MEM-077); stays hidden for the page session.
- Lint: every `static/**/*.svg` contains none of `<script`, `<style`, `style=`, `on*=` attributes, `foreignObject`,
  or an external href (`http:`, `https:`, `//`).
- Accept: `#empty-state` src is `pal-idle.svg`, alt empty, no `<object>`/`<embed>`; both SVGs byte-equal the
  dog-mascot sources; reduced motion -> `pal-still.svg`; hidden after places render and after a route exists; SVG
  lint passes on every `static/**/*.svg`; CSP strings unchanged.

Tests: tests/test_assets_wiring.py (replaces the `empty-state.webp` asserts at :26 and :153-159; adds the SVG lint)
## MEM-081 Route review: drag to reorder, Edit-revealed trash

Supersedes the Up/Down/Drop row buttons of the Load-demo route review. ADR 0044.
Root problem: reordering took many Up/Down taps and a destructive Drop sat on every row.
Actors: the user; `static/route_review.js` (new; `createRouteReview` re-exported by `static/encode.js`),
`static/index.html` `#route-review`.
- Row: `N.` | grip button (data-action drag, "Reorder <label>") | label | trash (data-action drop, "Remove <label>"),
  the trash rendered only while `#route-edit` is pressed (aria-pressed, Edit/Done). Leaving edit mode cancels a confirm.
- Drag: pointerdown on the grip -> li.dragging + list.is-dragging; pointermove moves the row live to `dropSlot`
  (count of other rows' midpoints < clientY); pointerup commits via `moveTo(from, to)`; pointercancel/Escape revert.
- Keyboard on the grip: ArrowUp/ArrowDown one step, Home/End to the ends; focus stays on the moved grip; `#route-live`
  (polite) says "<label> moved to position i of N".
- Delete: first trash tap arms ("Remove this place?" Remove/Keep); Remove drops it and shows `#route-toast`
  "Removed <label>" with `#route-undo` Undo (stack); the toast mirrors canUndo; Generate hides it.
- Model: `moveTo(from, to)` false when out of range or from === to; `move(i, delta)` kept.
- Design shots: `scripts/screenshot_review_design.py` sizes the viewport to the page's scrollHeight (no full_page,
  which misplaces sticky elements); 2 widths x 2 themes.
- Accept: trash absent until Edit is pressed; one trash tap removes nothing; confirm + Undo restores; a drag or arrow
  key reorder is the order Generate passes to `store.saveRoute`.

Tests: static/encode.test.mjs, static/route_review*.test.mjs, static/index_markup*.test.mjs,
tests/test_screenshot_review_design.py

## MEM-083 Mount the station route (PLANNED)

Plan: `docs/plans/2026-11-03-demo-flow.md` S1. Actors: `src/memripal/routes_station.py`, `src/memripal/app.py`.
- `POST /station` from `routes_station.py` is mounted on the app.
- Accept: TestClient `POST /station` returns 200 on a valid photo; 4xx on a bad one.

Tests: tests/test_station_mount.py

## MEM-084 Offline walking-graph routing and geocode

Decision: ADR [0046](../../../../docs/decisions/0046-offline-walking-graph-routing-and-geocode.md), address fields
ADR [0053](../../../../docs/decisions/0053-station-street-address-and-poi-precision.md). Plan S2.
- `scripts/build_walk_graph.py`: one Overpass bbox query with retry, tested against a recorded response; writes a
  committed compact walk graph + named-POI JSON. POIs keep `addr:housenumber` / `addr:street`, else the enclosing
  building's addr tags.
- Pure JS module: A* (haversine heuristic); geocode by normalized fuzzy match + aliases ("kendall/mit t", "meta
  office" = 42.36554,-71.0809); alias entries carry `address`; snap to the largest component; straight-line fallback
  flagged as such.
- Accept: A* Kendall T -> 100 Binney stays within 40 m of the `DEMO_ROUTE` polyline and is 600-750 m long; every demo
  phrase resolves; a miss returns >= 1 suggestion; the fallback result is flagged; 100 Binney resolves with address
  "100 Binney St"; POI JSON + graph < 1 MB.

Tests: tests/test_build_walk_graph.py, static/walk_route.test.mjs

## MEM-085 Auto-loci candidates and swap

Decision: ADR [0047](../../../../docs/decisions/0047-derived-auto-loci-and-swap.md), ADR
[0053](../../../../docs/decisions/0053-station-street-address-and-poi-precision.md). Plan S3.
- Pure `candidates(polyline, pois)`: 30-50 m from the route, deduped, ranked, evenly spaced, in route order; each
  carries `address`; none within 15 m of an existing station (seeded stations have no `osm_id`).
- `static/route_store.js` swap / add / undo; keys `candidate:osm:<osm_id>` / `candidate:st:<station_id>`; no photo
  loss; `MAX_STATIONS` = 8. `coordsOf` / `round4` take a dp parameter: 5 dp public / seeded / alias, 4 dp GPS /
  map-click. The 6 `static/demo_route.js` stations carry hand-verified addresses and 5-dp coords.
- Accept: the Kendall route gives >= 6 candidates in route order; swap round-trips `photo_ref`; undo restores; backup
  v2 export unchanged; every candidate has an address or a "near <street>" label; no candidate within 15 m of an
  existing station; seeded stations keep 5 dp, GPS-captured stay 4 dp.
- Even spacing: consecutive candidates at least 40 m apart along the route.

Tests: static/auto_loci.test.mjs, static/route_store_swap.test.mjs, static/route_store.test.mjs

## MEM-087 Memorize: notes split, keyword edit, route recommendation

Decision: ADR [0048](../../../../docs/decisions/0048-memorize-breakdown-and-route-recommendation.md). Plan S5.
- Client for `/split` notes mode; keyword edit -> `split_list`; `/associate` per (keyword, station); client-side
  mnemonics; Jaccard + capacity route recommendation with a reason; MemorizeItem `list:<id>` + backup `lists[]`;
  Deconstruct checkbox dependency rules.
- Spark fixtures recorded for the 6-technique demo text; every template digest has a fixture.
- Accept: 6 keywords from the demo text; edited keywords re-split with 0 model calls; the recommendation picks a route
  with >= 6 free stations and shows a reason; a fixture-mode run makes 0 live calls.

Tests: static/memorize.test.mjs (incl. associateKeywords sends station {name, profile, taps}, {} for a missing
profile/taps), tests/test_split_demo_fixtures.py, tests/test_associate_station.py (/associate station block
{name, profile, taps} in prompt args; SEND_IMAGE False; unknown station key 400 before any model call; live payload
has no image and carries name/profile/taps), tests/test_demo_photo_json.py (static/assets/demo_photo.json decodes
byte-exact to fixtures/demo/photo.jpg; scripts/gen_demo_photo_json.py regenerates it, --in/--out, repo-root
defaults, missing input exits non-zero without traceback)

## MEM-090 Recall schedule (pure module) (PLANNED)

Decision: ADR [0049](../../../../docs/decisions/0049-recall-schedule-and-push-reminders.md). Plan S8.
- Pure schedule module matching ADR 0049's simulated schedules exactly.
- Accept: S = 11-03 18:00 with T = 11-21; no deadline; T = S+12h; T already passed.

Tests: static/recall_schedule.test.mjs

## MEM-096 Real map resizes when its box gains size

- A map mounted into a 0x0 box (hidden route view) grows when the box later gains size: `static/real_map.js` observes
  the map box with `win.ResizeObserver` and calls `map.resize()` on a non-zero box; a 0x0 box never resizes.
- The observer disconnects when the map is removed (remount of the same svg); no `win.ResizeObserver` -> mount still
  resolves `{ map }`.

Tests: static/real_map_resize.test.mjs

## MEM-100 Landmark emoji on the live map

Decided-by: ADR-0055
Root problem: the live Routes map draws stations as bare circles; ADR 0038 rule 1 planned emoji landmark markers,
built only in the design previews.
Actors: the user; `static/real_map_overlay.js` (`attachOverlay` / `detachOverlay`); the `Station` typedef in
`static/route_store.js`.
NFR: CSP-safe (presentation attributes only, no `style`); glyph set via `textContent`.
- Optional `Station.emoji`; missing -> U+1F4CD.
- Each station gets a `text.lm-emoji` sibling at (cx, cy-30), moved with the circle on map move/resize; removed by
  `detachOverlay`.
- Accept: one `lm-emoji` per station at cy-30; a station without `emoji` shows U+1F4CD; none remain after detach;
  no `style` attribute on any added node.

Tests: static/real_map_overlay_emoji.test.mjs
## MEM-101 Spec MEM ids defined once

Root problem: parallel branches each claim the next MEM id; a collision (e.g. commit 95331c4) reached main unnoticed
because nothing checked MEM uniqueness (ADR numbers are already checked by tests/test_decisions_structure.py).
- A definition is a line matching `## MEM-NNN ...` in any `.claude/spec-cache/memripal/references/spec*.md`; only the
  heading's first id counts.
- `scripts/spec_ids.py` exposes pure `duplicate_mem_errors(paths) -> list[str]`: one error per id defined more than
  once, naming the id and every `file:line` defining it, in id order; [] when clean.
- Ignored: cross-refs in body text, `**Superseded by MEM-NNN**`, `Amends MEM-NNN`, ids in non-heading lines.
- pytest-collected (tests/test_spec_ids.py) so `scripts/check.sh`, and so `scripts/merge_branch.sh` after its rebase
  onto main, fails on a duplicate.
- No reservation/claims file: numbers are the lowest free on the branch base at land time; on collision the
  later-landing branch renumbers.
- Accept: a duplicate in one file and across two files each yield an error; superseded refs and cross-refs yield none;
  the real spec-cache yields [].

Tests: tests/test_spec_ids.py
## MEM-100 Judges-only access gate (PLANNED)
## MEM-103 Judges-only access gate (PLANNED)

PLANNED, not built, unverified. Amends MEM-034 passcode gate (spec-2.md, ADR 0025): a valid access cookie
satisfies `_passcode_error`, checked before its passcode-unset branch. <!-- claim-exempt: planned -->
Decided-by: ADR-0055
Root problem: the live (paid) deploy must admit only judges, who share one key delivered out of band; the passcode
header is per-session UI friction and fails open on a client-controlled loopback Host.
Actors: judges (browser); `src/memripal/app.py` (`AccessGate`, `_passcode_error`), `src/memripal/ratelimit.py`,
`src/memripal/security_headers.py`, new `static/access.html`, `static/index.html`, `static/public_banner.js`.
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

## MEM-104 Deploy script: live mode, secret mapping, edge-aware ingress (PLANNED)

PLANNED, not built, unverified. Amends MEM-034 (`scripts/deploy_cloud_run.sh`).
Decided-by: ADR-0055
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

## MEM-105 Edge: global HTTPS ALB + Cloud Armor, trusted proxy hops (PLANNED)

PLANNED, not built, unverified. New `scripts/deploy_edge_gcp.sh`. <!-- claim-exempt: planned -->
Decided-by: ADR-0055
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
