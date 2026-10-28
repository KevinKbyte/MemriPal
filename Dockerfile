# MemriPal Cloud Run image (MEM-034, ADR 0010): fixture mode, non-root, no secrets baked in.
# Keys and the live passcode arrive at runtime via Cloud Run --set-secrets only.
FROM python:3.13-slim

COPY --from=ghcr.io/astral-sh/uv:0.13.1 /uv /bin/uv

WORKDIR /app

# Deps from the lockfile only; the app runs from /app/src because memripal.app resolves
# static/ and fixtures/ relative to the source tree.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY src ./src
COPY static ./static
COPY fixtures ./fixtures

RUN useradd --system --uid 10001 --no-create-home memripal
USER memripal

ENV PATH="/app/.venv/bin:$PATH" PYTHONPATH=/app/src PYTHONUNBUFFERED=1 MEMRIPAL_MODE=fixture

# Shell form via sh -c so Cloud Run's $PORT expands; exec keeps uvicorn as PID 1 for SIGTERM.
CMD ["sh", "-c", "exec uvicorn memripal.app:app --host 0.0.0.0 --port ${PORT:-8080}"]
