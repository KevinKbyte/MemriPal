"""Request-body reader, parsers, the app-wide body cap and the shared error response (MEM-060).

Split out of app.py to keep it under its line budget; app.py imports everything here."""

import json
import threading
from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.datastructures import Headers

from memripal.backend import ModelBackend
from memripal.byok import LIMIT_CODE, REJECTED_CODE, ByokKeyRejected, ByokLimitReached
from memripal.imaging import MAX_UPLOAD_BYTES
from memripal.meta_spend_guard import CAP_ERROR_CODE, MetaSpendCapReached
from memripal.place import valid_coords
from memripal.spend_degrade import CAPPED, note_spend_cap
from memripal.split import MAX_POINTS

ASSOCIATE_KEYS = {"image", "item", "locus"}
ASSOCIATE_OPTIONAL_KEYS = {"place", "station"}
PLACE_KEYS = {"lat", "lon"}
SCENES_KEYS = {"image", "box", "record", "sig"}
BOX_KEYS = ("x1", "y1", "x2", "y2")
UPLOAD_TYPES = {"image/jpeg", "image/png", "image/webp"}


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


def _error(status: int, code: str) -> JSONResponse:
    # Only a fixed short code: model/exception text never reaches the client.
    return JSONResponse({"error": code}, status_code=status)


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


def _call_failed(exc: Exception) -> JSONResponse:
    """A refused or failed model call: limits and a refused BYOK key name themselves, else "upstream"."""
    # Ahead of MetaSpendCapReached (it is one): the visitor's own limit, not the shared cap (MEM-122).
    if isinstance(exc, ByokLimitReached):
        return _error(503, LIMIT_CODE)
    if isinstance(exc, ByokKeyRejected):
        return _error(502, REJECTED_CODE)
    if isinstance(exc, MetaSpendCapReached):
        note_spend_cap(CAPPED)
        return _error(503, CAP_ERROR_CODE)
    if isinstance(exc, BudgetExhausted):
        return _error(429, "budget_exhausted")
    return _error(502, "upstream")


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
    """The parsed /associate body, or None unless it is {image, item, locus} strings plus optional place
    and station (their shapes are checked by associate.check_place / check_station)."""
    try:
        body = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(body, dict) or set(body) - ASSOCIATE_OPTIONAL_KEYS != ASSOCIATE_KEYS:
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
