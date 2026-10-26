# 0001: Python 3.13 + FastAPI backend, vanilla ES-module frontend

Status: Accepted
Date: 2026-10-26
Source: `docs/plans/2026-10-26-memripal.md` A6, "Rejected alternatives" (Full TS stack).

## Context

Solo build, 6 days. The server does image processing (EXIF transpose, downscale, pixel-bomb checks) and calls the
Meta Model API; the frontend is a small single-user UI.

## Options considered

- Python 3.13 + FastAPI (uv), vanilla ES-module frontend served by the same app, pytest + node:test.
  Pros: strong image processing; matches Kev's recent work; one process serves API and static files.
  Cons: two test runners (pytest + node:test).
- Full TypeScript stack.
  Pros: one language end to end.
  Cons: weaker image processing; Kev's recent work is Python.

## Decision

Python 3.13 + FastAPI with a vanilla ES-module frontend served by the same app.

## Why this over the others

Image processing is load-bearing (S2 intake), and Kev's recent work is Python, which matters on a 6-day solo schedule.

## Consequences

- Pipeline logic stays server-side and is tested with pytest; only UI helpers are tested with node:test.
- No frontend build step.
