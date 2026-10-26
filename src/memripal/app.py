"""FastAPI app: health endpoint and static frontend shell (MEM-001)."""

from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from memripal.backend import ModelBackend, select_backend

REPO_ROOT = Path(__file__).resolve().parents[2]
STATIC_DIR = REPO_ROOT / "static"
REPLAY_DIR = REPO_ROOT / "fixtures" / "replay"


def create_app(backend: ModelBackend | None = None) -> FastAPI:
    if backend is None:
        backend = select_backend(None, REPLAY_DIR)

    app = FastAPI(title="MemriPal")

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok", "mode": backend.mode}

    @app.get("/", include_in_schema=False)
    def index() -> FileResponse:
        return FileResponse(STATIC_DIR / "index.html", media_type="text/html")

    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
    return app


app = create_app()
