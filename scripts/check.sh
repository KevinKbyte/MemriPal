#!/bin/sh
# Full local gate: lint, Python tests, frontend tests.
set -e
cd "$(dirname "$0")/.."
uv run ruff check .
uv run pytest -q
# Node 22 treats a bare directory arg as a module path, so pass a glob.
node --test "static/*.test.mjs"
node --test "docs/design/v6/tests/*.test.mjs"
