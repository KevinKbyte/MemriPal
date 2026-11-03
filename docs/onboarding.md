# MemriPal onboarding

A place-based recall coach for speeches: study points pinned to stops on a walk you know, recalled aloud,
checked by deterministic code.

## ELI5

You have a talk to give. MemriPal ties each point to a place on a walk you know, draws a silly picture for each
place, then listens while you walk it in your head and say the points. It tells you which ones you forgot.

## WHY

Building a memory palace by hand is slow and self-checking is unreliable. MemriPal automates the build with Meta
models and keeps judging model-free, so a paraphrase cannot talk its way into a pass
([ADR 0008](decisions/0008-spoken-recall-deterministic-matcher.md)). Built for the Meta Global AI Developer
Hackathon (Oct 26 - Nov 4 2026).

## WHAT

- Stateless FastAPI backend (`src/memripal/app.py::create_app@h46203aac`); palaces, routes and rehearsals live in
  the browser ([ADR 0003](decisions/0003-stateless-backend-client-state.md)).
- Vanilla ES-module frontend in `static/`, no build step; page wiring in `static/flow.js:151@h9770af0c`.
- Modes `fixture` (default, offline replay) and `meta` (live API), picked by
  `src/memripal/backend.py::select_backend@hc1241b9b`.
- Direction is route-first ([ADR 0038](decisions/0038-route-first-flow.md)); the served Load demo still runs the
  room-photo chain until plan step B10 ([ADR 0040](decisions/0040-retire-room-photo-flow.md)).

## HOW: architecture

```mermaid
flowchart TB
    user([User: speaker rehearsing a talk])
    meta[/External: Meta Model API/]
    wiki[/External: Wikipedia geosearch/]
    subgraph boundary["MemriPal"]
        web["Browser app: static ES modules + IndexedDB"]
        api["FastAPI backend: stateless, fixture or meta mode"]
    end
    user -->|taps, speech| web
    web -->|HTTPS JSON| api
    api -->|Spark, SAM 3.1, Muse Image, ASR| meta
    api -->|opt-in place lookup| wiki
```

Legend: rounded = person, slanted = external system, boxes = MemriPal containers.

Guards run outermost-first: `src/memripal/security_headers.py::SecurityHeaders@h8fb65e8b`, trusted host, rate
limit `src/memripal/ratelimit.py::ApiGuard@had0c95f5`, then a per-route live passcode
([ADR 0025](decisions/0025-passcode-gate-and-host-allowlist.md)).

## HOW: sequence

```mermaid
sequenceDiagram
    participant U as User
    participant B as Browser
    participant A as API
    U->>B: Load demo
    B->>A: POST /loci, /split, /associate
    A-->>B: loci, points, signed records
    B->>A: POST /scenes (record + sig)
    A-->>B: scene or tier-3 fallback
    U->>B: recall aloud
    B->>A: POST /recall/audio (WAV)
    A-->>B: transcript
    B->>B: deterministic matcher marks hits
```

## HOW: core logic

- Loci: `src/memripal/loci.py::find_loci@ha9e0fdb1` gets Spark phrases and SAM boxes;
  `src/memripal/loci.py::select_loci@hba799d24` and `src/memripal/loci.py::route_order@h636749ea` pick and order
  them with no LLM.
- Split: list mode `src/memripal/split.py::split_list@h0495acc9`; notes mode, one Spark call plus one
  regeneration, `src/memripal/split.py::split_notes@hffee42f8`.
- Associate: `src/memripal/associate.py::validate_association@h83acf155` checks records;
  `src/memripal/associate.py::associate@h68000bc3` regenerates at most twice, then `invalid`.
- Signing: `src/memripal/record_sign.py::sign_record@h5edfb9b0`; `/scenes` renders only records passing
  `src/memripal/record_sign.py::sig_ok@ha2044792`.
- Recall: Levenshtein 0.8 or 60% coverage (`static/recall_match.js:5-6@hfe3a890c`) in
  `static/recall_match.js:139@h15683138`; live lighting relays 5 s slices (`static/recall_live.js:7@hc4d69590`).
- Routes hold 3-8 stations (`static/route_store.js:28-29@h14ec9f79`); the Kendall demo route is frozen code
  (`static/demo_route.js:15@h1f2f12a6`).

## HOW: data provenance

- Replays in `fixtures/replay/` keyed by `src/memripal/backend.py::RequestKey@h53469c95` or legacy
  `src/memripal/backend.py::CacheKey@h19661f99`; a miss raises in `src/memripal/backend.py::FixtureBackend@h0cdbe15e`.
- Live calls write to gitignored `refs/private/live-cache` ([ADR 0017](decisions/0017-live-cache-in-refs-private.md)).
- Demo inputs are synthetic (`fixtures/MANIFEST.md`); uploads are re-encoded, EXIF-stripped
  (`src/memripal/imaging.py::process_upload@he12c147e`).
- Wikipedia place text (CC BY-SA 4.0), opt-in only: `src/memripal/place.py::PlaceProvider@h4981c888`.
- Backups carry no coordinates, 8 MiB cap (`static/palace_export.js:14@h9109ef78`).

## HOW: key files

| Path | Role |
| --- | --- |
| `src/memripal/app.py` | App factory, routes, deploy guards |
| `src/memripal/backend.py` | Modes, `ModelRequest`, replay cache |
| `src/memripal/meta_client.py` | Meta HTTP client (`src/memripal/meta_client.py::MetaClient@he9f80c07`) |
| `src/memripal/loci.py`, `split.py`, `associate.py`, `scenes.py` | Encode pipeline stages |
| `static/flow.js`, `static/encode.js` | Page wiring; Load demo chain (`static/encode.js:298@hdb257aca`) |
| `static/route_store.js`, `static/real_map.js` | Route store; Kendall map (`static/real_map.js:13-15@h2e400328`) |
| `docs/decisions/` | ADRs |
| `.claude/spec-cache/memripal/references/` | Feature specs (MEM-NNN) |

## HOW: CLI, env vars, exit codes

| Env var | Effect |
| --- | --- |
| `MEMRIPAL_MODE` | `fixture` (default) or `meta`; else raises |
| `META_API_KEY` | Required in `meta` mode, environment only |
| `MEMRIPAL_CHAT_PROVIDER` | `src/memripal/chat_provider.py::chat_provider_from_env@h1383f730` |
| `MEMRIPAL_SEG_PROVIDER` | `src/memripal/seg_provider.py::select_seg_provider@h02e2a8e3` |
| `MEMRIPAL_PASSCODE`, `MEMRIPAL_ALLOWED_HOSTS`, `MEMRIPAL_CALL_BUDGET` | Deploy guards, read in `create_app` |
| `MEMRIPAL_RECORD_KEY` | HMAC key, else random per process (`src/memripal/record_sign.py::record_key@h4a72c634`) |

No `[project.scripts]` entry points (`pyproject.toml`); every CLI is a file under `scripts/`.

| Command | Does | Exit |
| --- | --- | --- |
| `uv sync`, then `uv run uvicorn memripal.app:app` | Serve the app, fixture mode | - |
| `sh scripts/check.sh` | ruff, pytest, two `node --test` globs (`scripts/check.sh:5-9@h494d8d86`) | first failure (`set -e`) |
| `sh scripts/merge_branch.sh <worktree>` | Refuse dirty tree (`scripts/merge_branch.sh:152@hdab9e2ea`), rebase, `check.sh` (`scripts/merge_branch.sh:168@h9e0e574d`), enqueue via `request_merge.py --wait` (`scripts/merge_branch.sh:179@hc22f2777`) or ff `main` with up to 3 re-bump rounds (`scripts/merge_branch.sh:10@h91e9dbc9`), re-run `check.sh` in the primary (`scripts/merge_branch.sh:188@h236dd9b9`) | 2 bad usage, else failing step's code |
| `uv run --with playwright python scripts/e2e_drive.py --out <dir>` | 22-step browser drive (`scripts/e2e_drive.py::exit_code@hed4f7a0d`) | 0 all pass, 1 failure, 2 server never ready |
| `scripts/screenshot_ui.py`, `screenshot_design.py`, `screenshot_map.py`, `check_route_css.py` | Visual-verify and design CSS lint (README "Setup") | 0 clean, 1 problem, 2 bad usage |
| `powershell -File scripts/run_live.ps1 [cmd]` | Developer-only live mode; decrypts the DPAPI key into the child env | child's code; 2 missing key file |
| `scripts/make_synthetic_fixtures.py`, `promote_live_cache.py`, `build_map_extract.py` | Fixtures, live-cache promotion, offline map rebuild | see each docstring |

Hooks (`.githooks/pre-commit`; enable with `git config core.hooksPath .githooks`), each failure sets exit 1:

- Secret-shaped strings and EXIF images: `scripts/precommit_scan.py` (`.githooks/pre-commit:6@h1d6c6922`).
- Staged `*.py`: `ruff format --check` on the working-tree copy (`.githooks/pre-commit:12@h4611a802`).
- Staged `docs/decisions/*`: `tests/test_decisions_structure.py` (`.githooks/pre-commit:17@h9781e017`).
- KB anchor gate `$AW/scripts/kb_anchor_gate.py` (`.githooks/pre-commit:27@hd303a54b`) and docs-sync
  `$AW/githooks/pre_commit_docs_sync.py` (`.githooks/pre-commit:36@h65340490`); `AW` defaults to
  `$HOME/projects/agent-workflow`, missing file fails closed.

## HOW: tests

| Suite | Location | Run |
| --- | --- | --- |
| Python (81 files), per module, route or script | `tests/test_*.py`; shared helper `tests/shooter_support.py` | `uv run pytest -q [tests/test_x.py]` |
| Lint | one `ruff-lint` item per pytest run (`tests/conftest.py::RuffLintItem@hba26a39b`, [ADR 0037](decisions/0037-lint-in-pytest.md)) | any pytest run |
| Frontend (88 files) | `static/*.test.mjs`; `static/*_test.mjs` fall outside the glob | `node --test "static/*.test.mjs"` |
| Design previews | `docs/design/v6/tests/*.test.mjs` | `node --test "docs/design/v6/tests/*.test.mjs"` |
| Build scripts | `scripts/*.test.mjs` | `npm test` (`package.json:6@he68046e0`) |
| End to end | `scripts/e2e_drive.py`, steps in `scripts/e2e_steps.py` | see CLI table; needs local Chrome |

- Pass globs, not a bare directory, to `node --test` (Node 22 reads a directory as a module path).
- Hooks and merge script are tested too: `tests/test_githook_precommit.py`, `tests/test_merge_branch*.py`.

## HOW: design decisions

Index: [decisions/README.md](decisions/README.md). Load-bearing:
[0002](decisions/0002-backend-modes-and-replay-cache.md) modes and replay cache;
[0003](decisions/0003-stateless-backend-client-state.md) stateless backend;
[0026](decisions/0026-client-side-recall-matcher.md) client-side matcher;
[0020](decisions/0020-association-validate-and-regenerate.md) bounded regeneration;
[0027](decisions/0027-signed-association-records.md) signed records;
[0038](decisions/0038-route-first-flow.md) route-first; [0041](decisions/0041-real-map-whole-file-pmtiles.md) real map.

## HOW: gotchas

- `/station` and `/baseline` routers are not mounted by `create_app`
  (`src/memripal/routes_station.py::make_station_router@hca85b376`,
  `src/memripal/routes_baseline.py::baseline_router@h9453b53d`).
- CORS unwired (`src/memripal/cors.py::add_cors@h3e407690`): the Android shell cannot reach the API yet.
- `src/memripal/stt_provider.py::select_stt_provider@hdf37e953` has no app caller; `/recall/audio` always uses Muse.
- `static/db/` SQLite worker (`static/db/client.js:1@hb0f07ec9`) has no non-test caller; stores use IndexedDB.
- README is stale for the route-first flow: its intro ("starts from one photo"), pipeline diagram and the
  `pyproject.toml` description still describe the room-photo chain. Trust ADR 0038/0040 over README.
- `scripts/check.sh` skips `scripts/*.test.mjs`; only `npm test` runs them.
- The docs-sync pre-commit gate needs `$AW/githooks/pre_commit_docs_sync.py`; until that agent-workflow change
  lands every commit here fails closed.

## Remaining owner gates

- Kev: replace README `TODO(Kev)` video and Cloud Run URLs; close `docs/submission/checklist.md` items.
- Plan B10: Load demo -> demo route, delete `/loci` ([ADR 0040](decisions/0040-retire-room-photo-flow.md)).
- Wire `/station`, `/baseline` and CORS into `create_app`.
