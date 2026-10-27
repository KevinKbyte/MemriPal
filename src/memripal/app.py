"""FastAPI app: health, static shell (MEM-001), POST /loci (MEM-015), demo photo (MEM-017),
POST /split (MEM-020)."""

import base64
import json
import logging
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool
from starlette.middleware.trustedhost import TrustedHostMiddleware

from memripal.backend import BackendCallFailed, FixtureMissing, ModelBackend, select_backend
from memripal.imaging import MAX_UPLOAD_BYTES, ImageRejected, process_upload, validate_processed
from memripal.loci import Locus, find_loci
from memripal.split import MAX_POINTS, SplitRejected, check_notes, split_list, split_notes

REPO_ROOT = Path(__file__).resolve().parents[2]
STATIC_DIR = REPO_ROOT / "static"
REPLAY_DIR = REPO_ROOT / "fixtures" / "replay"
# Gitignored: live (meta) responses and photos land here, never in the committed REPLAY_DIR.
LIVE_CACHE_DIR = REPO_ROOT / "refs" / "private" / "live-cache"
DEMO_PHOTO = REPO_ROOT / "fixtures" / "demo" / "photo.jpg"

UPLOAD_TYPES = {"image/jpeg", "image/png", "image/webp"}
# Base64 of a max-size photo plus room for 20 KB of notes even when JSON-escaped as \uXXXX.
SPLIT_BODY_CAP = 4 * -(-MAX_UPLOAD_BYTES // 3) + 256 * 1024

# DNS-rebinding guard for the loopback-only server.
# S7 (public Cloud Run deploy, ADR 0010) must extend this list with the deploy host.
ALLOWED_HOSTS = ("127.0.0.1", "localhost")

logger = logging.getLogger(__name__)


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


async def _read_capped(request: Request, cap: int = MAX_UPLOAD_BYTES) -> bytes | None:
    """Body bytes, or None once the running count passes `cap` (chunked bodies have no length)."""
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > cap:
            return None
        chunks.append(chunk)
    return b"".join(chunks)


def _split_body(raw: bytes) -> dict | None:
    """The parsed /split body, or None if it is not an object with the four well-typed fields."""
    try:
        body = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(body, dict):
        return None
    loci_count = body.get("loci_count")
    if (
        not isinstance(body.get("photo"), str)
        or body.get("mode") not in ("list", "notes")
        or not isinstance(body.get("text"), str)
        or not isinstance(loci_count, int)
        or isinstance(loci_count, bool)
        or not 1 <= loci_count <= MAX_POINTS
    ):
        return None
    return body


def create_app(backend: ModelBackend | None = None) -> FastAPI:
    if backend is None:
        backend = select_backend(None, fixtures_root=REPLAY_DIR, live_cache_root=LIVE_CACHE_DIR)

    app = FastAPI(title="MemriPal")
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=list(ALLOWED_HOSTS))

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok", "mode": backend.mode}

    @app.get("/", include_in_schema=False)
    def index() -> FileResponse:
        return FileResponse(STATIC_DIR / "index.html", media_type="text/html")

    # Fixed path, no user-supplied component: only the committed demo photo is exposed.
    @app.get("/demo/photo.jpg", include_in_schema=False)
    def demo_photo() -> Response:
        if not DEMO_PHOTO.is_file():
            return _error(404, "demo_missing")
        return FileResponse(DEMO_PHOTO, media_type="image/jpeg")

    @app.post("/loci")
    async def post_loci(request: Request) -> JSONResponse:
        media_type = request.headers.get("content-type", "").split(";")[0].strip().lower()
        if media_type not in UPLOAD_TYPES:
            return _error(415, "unsupported_media_type")
        length = request.headers.get("content-length")
        if length is not None:
            # str.isdigit() accepts e.g. U+00B2, which int() rejects; require plain ASCII digits.
            if not (length.isascii() and length.isdigit()):
                return _error(400, "bad_content_length")
            if int(length) > MAX_UPLOAD_BYTES:
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
        except Exception:
            logger.exception("POST /loci failed")
            return _error(500, "internal")
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

    @app.post("/split")
    async def post_split(request: Request) -> JSONResponse:
        media_type = request.headers.get("content-type", "").split(";")[0].strip().lower()
        if media_type != "application/json":
            return _error(415, "unsupported_media_type")
        raw = await _read_capped(request, SPLIT_BODY_CAP)
        if raw is None:
            return _error(413, "too_large")
        body = _split_body(raw)
        if body is None:
            return _error(422, "bad_request")
        text, loci_count = body["text"], body["loci_count"]
        try:
            # Caps first: oversize input is refused before the photo is decoded or any model call.
            if body["mode"] == "list":
                points = split_list(text, loci_count)
            else:
                check_notes(text)
            try:
                # validate=True rejects any non-alphabet char, so a "data:...;base64," prefix fails here.
                photo = base64.b64decode(body["photo"], validate=True)
            except ValueError:  # binascii.Error, or a non-ASCII str
                return _error(400, "bad_base64")
            processed = await run_in_threadpool(validate_processed, photo)
            if body["mode"] == "notes":
                points = await run_in_threadpool(split_notes, backend, processed.jpeg, text, loci_count)
        except SplitRejected as exc:
            return _error(422, str(exc))
        except ImageRejected as exc:
            return _error(exc.status, str(exc))
        except FixtureMissing:
            return _error(404, "fixture_missing")
        except BackendCallFailed:
            return _error(502, "upstream")
        return JSONResponse({"points": points})

    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
    return app


app = create_app()
