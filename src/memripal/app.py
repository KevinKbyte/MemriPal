"""FastAPI app: health, static shell (MEM-001), POST /loci (MEM-015), demo photo (MEM-017),
POST /split (MEM-020), POST /associate (MEM-021), demo notes (MEM-023), POST /scenes (MEM-028),
POST /recall/audio and the demo recall replay (MEM-032), deploy guards (MEM-034), signed records (MEM-036)."""

import base64
import hmac
import json
import logging
import os
import threading
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import Headers
from starlette.middleware.trustedhost import TrustedHostMiddleware

from memripal.associate import (
    FIELDS,
    MAX_FIELD_CHARS,
    AssociateRejected,
    associate,
    check_inputs,
    check_place,
    record_ok,
)
from memripal.backend import BackendCallFailed, FixtureMissing, ModelBackend, select_backend
from memripal.imaging import MAX_UPLOAD_BYTES, ImageRejected, process_upload, validate_processed
from memripal.loci import Locus, find_loci
from memripal.meta_client import MetaClient
from memripal.place import FixturePlaceProvider, PlaceProvider, valid_coords
from memripal.recall_relay import (
    MAX_CHUNK_BYTES,
    MAX_TRANSCRIPT_CHARS,
    RELAY_BODY_CAP,
    decode_audio,
    is_relayable_wav,
    parse_body,
    transcript_or_none,
)
from memripal.record_sign import record_key, sig_ok, sign_record
from memripal.scenes import render_scene
from memripal.split import MAX_POINTS, SplitRejected, check_notes, split_list, split_notes

REPO_ROOT = Path(__file__).resolve().parents[2]
STATIC_DIR = REPO_ROOT / "static"
REPLAY_DIR = REPO_ROOT / "fixtures" / "replay"
# Gitignored: live (meta) responses and photos land here, never in the committed REPLAY_DIR.
LIVE_CACHE_DIR = REPO_ROOT / "refs" / "private" / "live-cache"
DEMO_PHOTO = REPO_ROOT / "fixtures" / "demo" / "photo.jpg"
DEMO_NOTES = REPO_ROOT / "fixtures" / "demo" / "notes.txt"
# Stands in for EXIF GPS: the synthetic demo photo must stay EXIF-free (MEM-005, MEM-025).
DEMO_PLACE = REPO_ROOT / "fixtures" / "demo" / "place.json"
DEMO_RECALL = REPO_ROOT / "fixtures" / "demo" / "recall_timeline.json"

UPLOAD_TYPES = {"image/jpeg", "image/png", "image/webp"}
# Base64 of a max-size photo plus room for 20 KB of notes even when JSON-escaped as \uXXXX.
SPLIT_BODY_CAP = 4 * -(-MAX_UPLOAD_BYTES // 3) + 256 * 1024
JPEG_DATA_URL = "data:image/jpeg;base64,"
# A max-size photo as a data URL plus room for item and locus even when JSON-escaped.
ASSOCIATE_BODY_CAP = 4 * -(-MAX_UPLOAD_BYTES // 3) + 64 * 1024
ASSOCIATE_KEYS = {"image", "item", "locus"}
PLACE_BODY_CAP = 1024
PLACE_KEYS = {"lat", "lon"}
# A max-size photo as a data URL plus a max-size record even when every char is JSON-escaped as \uXXXX.
SCENES_BODY_CAP = 4 * -(-MAX_UPLOAD_BYTES // 3) + 6 * MAX_FIELD_CHARS * len(FIELDS) + 64 * 1024
SCENES_KEYS = {"image", "box", "record", "sig"}
BOX_KEYS = ("x1", "y1", "x2", "y2")

# DNS-rebinding guard; the public deploy (ADR 0010) appends its host via MEMRIPAL_ALLOWED_HOSTS.
ALLOWED_HOSTS = ("127.0.0.1", "localhost")
PASSCODE_HEADER = "X-Memripal-Passcode"

logger = logging.getLogger(__name__)


def _error(status: int, code: str) -> JSONResponse:
    # Only a fixed short code: model/exception text never reaches the client.
    return JSONResponse({"error": code}, status_code=status)


def _env_int(name: str, minimum: int) -> int | None:
    """The env var as an int >= `minimum`, None when unset; anything else fails startup loudly."""
    raw = os.environ.get(name)
    if raw is None:
        return None
    if not (raw.isascii() and raw.isdigit()) or int(raw) < minimum:
        raise ValueError(f"{name} must be an integer >= {minimum}")
    return int(raw)


class BudgetExhausted(RuntimeError):
    """The per-instance live call budget is spent; the call never reached the backend."""


class _BudgetedBackend:
    """Counts live backend.call against a per-instance cap (MEM-034); everything else passes through."""

    def __init__(self, backend: ModelBackend, cap: int) -> None:
        self._backend = backend
        self._left = cap
        # Routes run in the threadpool and /loci fans SAM calls out across threads.
        self._lock = threading.Lock()

    def __getattr__(self, name: str) -> Any:
        return getattr(self._backend, name)

    def spend(self) -> None:
        """Charge one live upstream call; /recall/audio charges each ASR relay here, after validation."""
        with self._lock:
            if self._left <= 0:
                raise BudgetExhausted
            self._left -= 1

    def call(self, req: Any) -> Any:
        self.spend()
        return self._backend.call(req)


class _BodyTooLarge(Exception):
    pass


class _BodyCap:
    """App-wide body cap ahead of every route cap: a declared or streamed body past `cap` -> 413."""

    def __init__(self, app, cap: int) -> None:
        self.app = app
        self.cap = cap

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        length = Headers(scope=scope).get("content-length")
        # A malformed length is left to the route's own _length_error.
        if length is not None and length.isascii() and length.isdigit() and int(length) > self.cap:
            return await _error(413, "too_large")(scope, receive, send)
        total = 0

        async def capped_receive():
            nonlocal total
            message = await receive()
            if message["type"] == "http.request":
                total += len(message.get("body", b""))
                if total > self.cap:
                    raise _BodyTooLarge
            return message

        try:
            await self.app(scope, capped_receive, send)
        except _BodyTooLarge:
            # Routes read the whole body before responding, so no response has started yet.
            await _error(413, "too_large")(scope, receive, send)


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


def _associate_body(raw: bytes) -> dict | None:
    """The parsed /associate body, or None unless it is {image, item, locus} strings plus optional place."""
    try:
        body = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(body, dict) or set(body) - {"place"} != ASSOCIATE_KEYS:
        return None
    if not all(isinstance(body[k], str) for k in ASSOCIATE_KEYS):
        return None
    return body


def _scenes_body(raw: bytes) -> dict | None:
    """The parsed /scenes body, or None unless it is exactly {image, box, record, sig} with a string image."""
    try:
        body = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(body, dict) or set(body) != SCENES_KEYS or not isinstance(body["image"], str):
        return None
    return body


def _box_ok(box: object, width: int, height: int) -> bool:
    """Exactly four ints (bools refused) with 0 <= x1 < x2 <= width and 0 <= y1 < y2 <= height."""
    if not isinstance(box, dict) or set(box) != set(BOX_KEYS):
        return False
    if not all(isinstance(box[k], int) and not isinstance(box[k], bool) for k in BOX_KEYS):
        return False
    return 0 <= box["x1"] < box["x2"] <= width and 0 <= box["y1"] < box["y2"] <= height


def _place_body(raw: bytes) -> tuple[float, float] | None:
    """(lat, lon) when the body is exactly {lat, lon} as finite in-range numbers, else None."""
    try:
        body = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(body, dict) or set(body) != PLACE_KEYS or not valid_coords(body["lat"], body["lon"]):
        return None
    return body["lat"], body["lon"]


def _length_error(request: Request, cap: int) -> JSONResponse | None:
    """An error for a malformed or over-cap Content-Length header, else None (absent is fine)."""
    length = request.headers.get("content-length")
    if length is None:
        return None
    # str.isdigit() accepts e.g. U+00B2, which int() rejects; require plain ASCII digits.
    if not (length.isascii() and length.isdigit()):
        return _error(400, "bad_content_length")
    if int(length) > cap:
        return _error(413, "too_large")
    return None


def create_app(backend: ModelBackend | None = None, place_provider=None, asr_client=None) -> FastAPI:
    if backend is None:
        backend = select_backend(None, fixtures_root=REPLAY_DIR, live_cache_root=LIVE_CACHE_DIR)
    if place_provider is None:
        # Fixture mode stays offline end to end, so the demo place replays like every other answer.
        place_provider = FixturePlaceProvider(REPLAY_DIR) if backend.mode == "fixture" else PlaceProvider()
    if asr_client is None and backend.mode != "fixture":
        api_key = os.environ.get("META_API_KEY", "")
        asr_client = MetaClient(api_key) if api_key else None

    # Deploy guards (MEM-034), read once here. Strip: Secret Manager values carry a trailing newline.
    extra_hosts = [h.strip() for h in os.environ.get("MEMRIPAL_ALLOWED_HOSTS", "").split(",") if h.strip()]
    passcode = os.environ.get("MEMRIPAL_PASSCODE", "").strip() or None
    call_budget = _env_int("MEMRIPAL_CALL_BUDGET", 0)
    max_body = _env_int("MEMRIPAL_MAX_BODY_BYTES", 1)
    signing_key = record_key()
    live = backend.mode != "fixture"
    if live and call_budget is not None:
        backend = _BudgetedBackend(backend, call_budget)

    app = FastAPI(title="MemriPal")
    if max_body is not None:
        app.add_middleware(_BodyCap, cap=max_body)
    # Added last so it runs first: an unlisted host is refused before any other check.
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=[*ALLOWED_HOSTS, *extra_hosts])

    def _passcode_error(request: Request) -> JSONResponse | None:
        """401 for a live model route without the passcode; checked before the body is read."""
        if not live:
            return None
        if passcode is None:
            # Unconfigured: local run_live use stays open, anything public fails closed.
            return None if request.url.hostname in ALLOWED_HOSTS else _error(401, "passcode_required")
        # Header values arrive latin-1 decoded; re-encoding recovers the raw bytes the client sent.
        sent = request.headers.get(PASSCODE_HEADER, "").encode("latin-1")
        if hmac.compare_digest(sent, passcode.encode("utf-8")):
            return None
        return _error(401, "passcode_required")

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

    # Served as stored bytes: the notes text is part of the split replay key (MEM-023).
    @app.get("/demo/notes.txt", include_in_schema=False)
    def demo_notes() -> Response:
        if not DEMO_NOTES.is_file():
            return _error(404, "demo_missing")
        return FileResponse(DEMO_NOTES, media_type="text/plain")

    @app.get("/demo/place.json", include_in_schema=False)
    def demo_place() -> Response:
        if not DEMO_PLACE.is_file():
            return _error(404, "demo_missing")
        return FileResponse(DEMO_PLACE, media_type="application/json")

    # The offline recall path: the client replays this recorded transcript timeline through its matcher.
    @app.get("/demo/recall.json", include_in_schema=False)
    def demo_recall() -> Response:
        if not DEMO_RECALL.is_file():
            return _error(404, "demo_missing")
        return FileResponse(DEMO_RECALL, media_type="application/json")

    # Audio lives only in this request's memory: never written to disk, never logged (D4).
    @app.post("/recall/audio")
    async def post_recall_audio(request: Request) -> JSONResponse:
        if backend.mode == "fixture":
            return _error(409, "live_only")
        # Before the body: an unauthenticated caller gets no validation hints and spends no ASR.
        if (passcode_error := _passcode_error(request)) is not None:
            return passcode_error
        media_type = request.headers.get("content-type", "").split(";")[0].strip().lower()
        if media_type != "application/json":
            return _error(415, "unsupported_media_type")
        if (length_error := _length_error(request, RELAY_BODY_CAP)) is not None:
            return length_error
        raw = await _read_capped(request, RELAY_BODY_CAP)
        if raw is None:
            return _error(413, "too_large")
        parsed = parse_body(raw)
        if parsed is None:
            return _error(400, "bad_request")
        audio_b64, keywords = parsed
        audio = decode_audio(audio_b64)
        if audio is None:
            return _error(400, "bad_base64")
        if len(audio) > MAX_CHUNK_BYTES:
            return _error(413, "too_large")
        if not is_relayable_wav(audio):
            return _error(400, "bad_audio")
        if asr_client is None:
            return _error(503, "asr_unavailable")
        if isinstance(backend, _BudgetedBackend):
            try:
                backend.spend()
            except BudgetExhausted:
                return _error(429, "budget_exhausted")
        result = await run_in_threadpool(asr_client.transcribe, audio, keywords=keywords)
        text = transcript_or_none(result.body) if result.ok else None
        if text is None:
            return _error(502, "upstream")
        return JSONResponse({"text": text[:MAX_TRANSCRIPT_CHARS]})

    # Stateless: the coords are used for one lookup and never stored or logged (MEM-025).
    @app.post("/place")
    async def post_place(request: Request) -> JSONResponse:
        media_type = request.headers.get("content-type", "").split(";")[0].strip().lower()
        if media_type != "application/json":
            return _error(415, "unsupported_media_type")
        if (length_error := _length_error(request, PLACE_BODY_CAP)) is not None:
            return length_error
        raw = await _read_capped(request, PLACE_BODY_CAP)
        if raw is None:
            return _error(413, "too_large")
        coords = _place_body(raw)
        if coords is None:
            return _error(400, "bad_request")
        places = await run_in_threadpool(place_provider.lookup, *coords)
        return JSONResponse({"places": places})

    @app.post("/loci")
    async def post_loci(request: Request) -> JSONResponse:
        if (passcode_error := _passcode_error(request)) is not None:
            return passcode_error
        media_type = request.headers.get("content-type", "").split(";")[0].strip().lower()
        if media_type not in UPLOAD_TYPES:
            return _error(415, "unsupported_media_type")
        if (length_error := _length_error(request, MAX_UPLOAD_BYTES)) is not None:
            return length_error
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
        except BudgetExhausted:
            return _error(429, "budget_exhausted")
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
        if (passcode_error := _passcode_error(request)) is not None:
            return passcode_error
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
        except BudgetExhausted:
            return _error(429, "budget_exhausted")
        return JSONResponse({"points": points})

    @app.post("/associate")
    async def post_associate(request: Request) -> JSONResponse:
        if (passcode_error := _passcode_error(request)) is not None:
            return passcode_error
        media_type = request.headers.get("content-type", "").split(";")[0].strip().lower()
        if media_type != "application/json":
            return _error(415, "unsupported_media_type")
        if (length_error := _length_error(request, ASSOCIATE_BODY_CAP)) is not None:
            return length_error
        raw = await _read_capped(request, ASSOCIATE_BODY_CAP)
        if raw is None:
            return _error(413, "too_large")
        body = _associate_body(raw)
        if body is None:
            return _error(400, "bad_request")
        item, locus, image, place = body["item"], body["locus"], body["image"], body.get("place")
        try:
            # Caps first: bad input is refused before the photo is decoded or any model call.
            check_inputs(item, locus)
            if "place" in body:
                check_place(place)
            if not image.startswith(JPEG_DATA_URL):
                return _error(400, "bad_data_url")
            try:
                photo = base64.b64decode(image[len(JPEG_DATA_URL) :], validate=True)
            except ValueError:  # binascii.Error, or a non-ASCII str
                return _error(400, "bad_base64")
            # Never re-encoded: the bytes key the fixture/cache entries.
            processed = await run_in_threadpool(validate_processed, photo)
            result = await run_in_threadpool(associate, backend, processed, item, locus, place)
        except AssociateRejected as exc:
            return _error(400, str(exc))
        except ImageRejected as exc:
            return _error(exc.status, str(exc))
        except FixtureMissing:
            return _error(404, "fixture_missing")
        except BackendCallFailed:
            return _error(502, "upstream")
        except BudgetExhausted:
            return _error(429, "budget_exhausted")
        except Exception:
            logger.exception("POST /associate failed")
            return _error(500, "internal")
        payload = {
            "item": result.item,
            "locus": result.locus,
            "status": result.status,
            "attempts": result.attempts,
            "record": result.record,
        }
        if result.record is not None:
            payload["sig"] = sign_record(signing_key, result.record)
        return JSONResponse(payload)

    @app.post("/scenes")
    async def post_scenes(request: Request) -> JSONResponse:
        if (passcode_error := _passcode_error(request)) is not None:
            return passcode_error
        media_type = request.headers.get("content-type", "").split(";")[0].strip().lower()
        if media_type != "application/json":
            return _error(415, "unsupported_media_type")
        if (length_error := _length_error(request, SCENES_BODY_CAP)) is not None:
            return length_error
        raw = await _read_capped(request, SCENES_BODY_CAP)
        if raw is None:
            return _error(413, "too_large")
        body = _scenes_body(raw)
        if body is None:
            return _error(400, "bad_request")
        image, box, record = body["image"], body["box"], body["record"]
        # Signature, then caps: a bad record is refused before the photo is decoded or any model call.
        if not sig_ok(signing_key, record, body["sig"]):
            return _error(403, "bad_signature")
        if not record_ok(record):
            return _error(400, "bad_record")
        if not image.startswith(JPEG_DATA_URL):
            return _error(400, "bad_data_url")
        try:
            photo = base64.b64decode(image[len(JPEG_DATA_URL) :], validate=True)
        except ValueError:  # binascii.Error, or a non-ASCII str
            return _error(400, "bad_base64")
        try:
            # Never re-encoded: the bytes key the fixture/cache entries.
            processed = await run_in_threadpool(validate_processed, photo)
        except ImageRejected as exc:
            return _error(exc.status, str(exc))
        if not _box_ok(box, processed.width, processed.height):
            return _error(400, "bad_box")
        # Never raises: every model failure, fixture miss included, comes back as tier 3.
        scene = await run_in_threadpool(render_scene, backend, processed, box, record)
        if scene.tier != 1:
            return JSONResponse({"tier": scene.tier, "reason": scene.reason})
        return JSONResponse(
            {
                "tier": 1,
                "image": "data:image/jpeg;base64," + base64.b64encode(scene.image).decode("ascii"),
                "width": processed.width,
                "height": processed.height,
            }
        )

    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
    return app


app = create_app()
