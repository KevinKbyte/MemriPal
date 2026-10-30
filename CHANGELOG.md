# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
