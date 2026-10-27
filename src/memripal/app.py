"""FastAPI app: health endpoint, static frontend shell (MEM-001) and POST /loci (MEM-015)."""

import base64
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

from memripal.backend import BackendCallFailed, FixtureMissing, ModelBackend, select_backend
from memripal.imaging import MAX_UPLOAD_BYTES, ImageRejected, process_upload
from memripal.loci import Locus, find_loci

REPO_ROOT = Path(__file__).resolve().parents[2]
STATIC_DIR = REPO_ROOT / "static"
REPLAY_DIR = REPO_ROOT / "fixtures" / "replay"

UPLOAD_TYPES = {"image/jpeg", "image/png", "image/webp"}


def _error(status: int, code: str) -> JSONResponse:
    # Only a fixed short code: model/exception text never reaches the client.
    return JSONResponse({"error": code}, status_code=status)


def _locus_json(lc: Locus) -> dict:
    return {
        "n": lc.n,
        "label": lc.label,
        "phrase": lc.phrase,
        "box": {"x1": lc.box.x1, "y1": lc.box.y1, "x2": lc.box.x2, "y2": lc.box.y2},
        "outline": [[x, y] for x, y in lc.outline],
    }


async def _read_capped(request: Request) -> bytes | None:
    """Body bytes, or None once the running count passes MAX_UPLOAD_BYTES (chunked bodies have no length)."""
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > MAX_UPLOAD_BYTES:
            return None
        chunks.append(chunk)
    return b"".join(chunks)


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

    @app.post("/loci")
    async def post_loci(request: Request) -> JSONResponse:
        media_type = request.headers.get("content-type", "").split(";")[0].strip().lower()
        if media_type not in UPLOAD_TYPES:
            return _error(415, "unsupported_media_type")
        length = request.headers.get("content-length", "")
        if length.isdigit() and int(length) > MAX_UPLOAD_BYTES:
            return _error(413, "too_large")
        data = await _read_capped(request)
        if data is None:
            return _error(413, "too_large")
        try:
            # Both block (Pillow decode, SAM fan-out), so keep them off the event loop.
            processed = await run_in_threadpool(process_upload, data)
            result = await run_in_threadpool(find_loci, backend, processed)
        except ImageRejected as exc:
            return _error(exc.status, str(exc))
        except FixtureMissing:
            return _error(404, "fixture_missing")
        except BackendCallFailed:
            return _error(502, "upstream")
        return JSONResponse(
            {
                "image": "data:image/jpeg;base64," + base64.b64encode(processed.jpeg).decode("ascii"),
                "width": processed.width,
                "height": processed.height,
                "photo_sha": processed.sha,
                "reask_used": result.reask_used,
                "loci": [_locus_json(lc) for lc in result.loci],
            }
        )

    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
    return app


app = create_app()
