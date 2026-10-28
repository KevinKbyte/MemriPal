"""Upload intake: turn an untrusted photo into one safe, server-processed JPEG (MEM-012)."""

import hashlib
from dataclasses import dataclass
from io import BytesIO

from PIL import Image, ImageOps, UnidentifiedImageError

MAX_UPLOAD_BYTES = 15 * 1024 * 1024
MAX_PIXELS = 40_000_000
MAX_SIDE = 8000
LONG_SIDE = 2048
JPEG_QUALITY = 90

_PILLOW_FORMAT = {"jpeg": "JPEG", "png": "PNG", "webp": "WEBP"}
# ValueError: Pillow raises it for hostile chunks (a zTXt decompression bomb), not only OSError.
_DECODE_ERRORS = (UnidentifiedImageError, OSError, Image.DecompressionBombError, SyntaxError, ValueError)


class ImageRejected(ValueError):
    """Upload refused; str(exc) is the short reason code, .status the HTTP status."""

    def __init__(self, reason: str, status: int = 400):
        super().__init__(reason)
        self.status = status


@dataclass(frozen=True)
class Processed:
    jpeg: bytes
    width: int
    height: int
    sha: str


def sniff(data: bytes) -> str:
    if data.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    raise ImageRejected("bad_magic")


def _check_bytes(data: bytes) -> str:
    if not data:
        raise ImageRejected("empty")
    if len(data) > MAX_UPLOAD_BYTES:
        raise ImageRejected("too_large", status=413)
    return sniff(data)


def _open_header(data: bytes, kind: str) -> Image.Image:
    # Image.open only parses the header; the pixel caps are enforced here, before any
    # load(), so a small file declaring huge dimensions is never decoded. Restricting
    # formats to the sniffed one stops Pillow from trying other plugins on the bytes.
    try:
        img = Image.open(BytesIO(data), formats=[_PILLOW_FORMAT[kind]])
    except _DECODE_ERRORS as exc:
        raise ImageRejected("decode_error") from exc
    w, h = img.size
    if w * h > MAX_PIXELS or w > MAX_SIDE or h > MAX_SIDE:
        img.close()
        raise ImageRejected("pixel_bomb")
    return img


def _fit_long_side(w: int, h: int) -> tuple[int, int]:
    long_side = max(w, h)
    if long_side <= LONG_SIDE:
        return w, h
    scale = LONG_SIDE / long_side
    return max(1, round(w * scale)), max(1, round(h * scale))


def process_upload(data: bytes) -> Processed:
    kind = _check_bytes(data)
    with _open_header(data, kind) as img:
        try:
            img.load()
            upright = ImageOps.exif_transpose(img).convert("RGB")
            size = _fit_long_side(*upright.size)
            if size != upright.size:
                upright = upright.resize(size, Image.Resampling.LANCZOS)
            # Pillow re-emits comment/ICC from .info on save; clear it so no metadata survives.
            upright.info = {}
            buf = BytesIO()
            upright.save(buf, "JPEG", quality=JPEG_QUALITY)
        except _DECODE_ERRORS as exc:
            raise ImageRejected("decode_error") from exc
    jpeg = buf.getvalue()
    return Processed(jpeg=jpeg, width=size[0], height=size[1], sha=hashlib.sha256(jpeg).hexdigest())


def validate_processed(data: bytes) -> Processed:
    """Re-check a client-returned processed photo WITHOUT re-encoding it.

    A re-encode changes the bytes (and so the sha, the fixture/cache key) every round, so the
    returned Processed wraps the input bytes as-is.
    """
    if _check_bytes(data) != "jpeg":
        raise ImageRejected("not_jpeg")
    with _open_header(data, "jpeg") as img:
        if "exif" in img.info:
            raise ImageRejected("has_exif")
        w, h = img.size
        if max(w, h) > LONG_SIDE:
            raise ImageRejected("too_big_side")
        try:
            img.load()
        except _DECODE_ERRORS as exc:
            raise ImageRejected("decode_error") from exc
    return Processed(jpeg=data, width=w, height=h, sha=hashlib.sha256(data).hexdigest())
