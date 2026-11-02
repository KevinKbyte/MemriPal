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
## MEM-072 Route-first flow: map-first shell, set the route, pick loci from alternatives, capture anytime (PLANNED)

PLANNED, not built, unverified: design only (docs/design/route/). ADR [0038](../../../../docs/decisions/0038-route-first-flow.md)
(amended 2026-11-01: map-first shell, map source).
Decided-by: ADR-0038
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
NFR: DOM marker count == in-viewport count after every `moveend`.
- One SVG overlay above the canvas, re-positioned via `map.project([lon, lat])` on `move`; no route layers in the style.
- Markers: only stations and landmarks inside the viewport bounds (plus the ADR 0038 margin) exist in the DOM,
  recomputed on `moveend`.
- A11y: map canvas container `aria-hidden="true"`; the route and landmark lists stay the accessible path.
- Attribution: Protomaps + "(c) OpenStreetMap contributors" visible without interaction at 375 px.
- Any station outside the bbox -> the whole route renders as sketch.
- Accept: each station's overlay point within 1 px of `map.project` after a pan and a zoom; marker DOM count ==
  in-viewport count at 3 viewports; canvas container `aria-hidden="true"`; attribution text visible at 375 px; one
  out-of-bbox station -> sketch and 0 extract fetches.

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
