"""Request-body reader, parsers and the shared error response for the app routes (MEM-060).

Split out of app.py to keep it under its line budget; app.py imports everything here."""

import json

from fastapi import Request
from fastapi.responses import JSONResponse

from memripal.imaging import MAX_UPLOAD_BYTES
from memripal.place import valid_coords
from memripal.split import MAX_POINTS

ASSOCIATE_KEYS = {"image", "item", "locus"}
PLACE_KEYS = {"lat", "lon"}
SCENES_KEYS = {"image", "box", "record", "sig"}
BOX_KEYS = ("x1", "y1", "x2", "y2")


def _error(status: int, code: str) -> JSONResponse:
    # Only a fixed short code: model/exception text never reaches the client.
    return JSONResponse({"error": code}, status_code=status)


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
