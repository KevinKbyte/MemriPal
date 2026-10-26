# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
