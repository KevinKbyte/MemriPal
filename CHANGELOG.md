# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - 2026-10-26

### Added

- Project scaffold (Python 3.13, uv, FastAPI, static frontend).
- Health endpoint `GET /healthz` and static shell `GET /` (MEM-001).
- Backend modes `fixture|meta` via `MEMRIPAL_MODE` (MEM-002).
- Logical-key write-through response cache and fixture replay (MEM-003).
- Synthetic demo fixtures with MANIFEST (MEM-005).
- Pre-commit scan for secrets and image EXIF (MEM-004).
