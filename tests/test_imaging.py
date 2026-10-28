# Covers: MEM-012
# Requirement: an uploaded photo is turned into one safe, server-processed JPEG before
# any model sees it. process_upload() rejects empty, oversize (> 15 MB, HTTP 413),
# non-image and pixel-bomb uploads (dimensions checked from the header before decoding)
# with short reason codes (empty, too_large, bad_magic, pixel_bomb, decode_error; 400
# otherwise), applies EXIF orientation, downscales the long side to 2048 px (never
# upscales), strips EXIF/ICC/comments and returns the same bytes and sha256 for the same
# input. validate_processed() re-checks a client-returned processed photo (JPEG, no EXIF,
# long side <= 2048) WITHOUT re-encoding it, because a re-encode changes the sha every
# round (demo photo at q90: 4 shas over 4 rounds) and the sha is the fixture/cache key;
# it rejects with not_jpeg, has_exif, too_big_side or the shared codes.
import dataclasses
import hashlib
import importlib
import io
import struct
import zlib
from pathlib import Path

import pytest
from PIL import Image, PngImagePlugin

REPO = Path(__file__).resolve().parents[1]
DEMO_PHOTO = REPO / "fixtures" / "demo" / "photo.jpg"
MB = 1024 * 1024
EXIF_APP1 = b"Exif\x00\x00"


@pytest.fixture
def imaging():
    return importlib.import_module("memripal.imaging")


def _jpeg(w, h, color=(120, 80, 40), **save_kwargs):
    buf = io.BytesIO()
    Image.new("RGB", (w, h), color).save(buf, "JPEG", **save_kwargs)
    return buf.getvalue()


def _png(w, h, mode="RGB"):
    buf = io.BytesIO()
    Image.new(mode, (w, h)).save(buf, "PNG")
    return buf.getvalue()


def _webp(w, h):
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (10, 200, 30)).save(buf, "WEBP")
    return buf.getvalue()


def _png_header_only(w, h):
    """A tiny PNG that declares w x h in its IHDR but carries no pixel data."""

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IEND", b"")


def _exif(orientation):
    exif = Image.Exif()
    exif[0x0112] = orientation
    return exif


def _decode(data):
    with Image.open(io.BytesIO(data)) as img:
        img.load()
        return img.format, img.size, img.copy()


def _rejected(imaging, fn, data):
    with pytest.raises(imaging.ImageRejected) as excinfo:
        fn(data)
    return excinfo.value


class TestInterface:
    def test_limits_match_the_plan(self, imaging):
        assert imaging.MAX_UPLOAD_BYTES == 15 * MB
        assert imaging.MAX_PIXELS == 40_000_000
        assert imaging.MAX_SIDE == 8000
        assert imaging.LONG_SIDE == 2048

    def test_image_rejected_is_a_value_error(self, imaging):
        assert issubclass(imaging.ImageRejected, ValueError)

    def test_processed_is_frozen(self, imaging):
        out = imaging.process_upload(_jpeg(40, 30))
        with pytest.raises(dataclasses.FrozenInstanceError):
            out.sha = "0" * 64


class TestSniff:
    def test_jpeg_magic(self, imaging):
        assert imaging.sniff(_jpeg(8, 8)) == "jpeg"

    def test_png_magic(self, imaging):
        assert imaging.sniff(_png(8, 8)) == "png"

    def test_webp_magic(self, imaging):
        assert imaging.sniff(_webp(8, 8)) == "webp"

    @pytest.mark.parametrize(
        "data",
        [b"GIF89a" + b"\x00" * 32, b"hello", b"RIFF\x10\x00\x00\x00WAVEfmt ", b"\xff\xd8", b"\x89PNG\r\n"],
        ids=["gif", "text", "riff-wave", "short-jpeg-magic", "short-png-magic"],
    )
    def test_unknown_or_partial_magic_is_bad_magic(self, imaging, data):
        exc = _rejected(imaging, imaging.sniff, data)
        assert str(exc) == "bad_magic"
        assert exc.status == 400


class TestProcessUploadRejections:
    def test_one_byte_over_15_mb_is_413_too_large(self, imaging):
        data = b"\xff\xd8\xff" + b"\x00" * (15 * MB + 1 - 3)
        exc = _rejected(imaging, imaging.process_upload, data)
        assert str(exc) == "too_large"
        assert exc.status == 413

    def test_exactly_15_mb_is_not_rejected_for_size(self, imaging):
        data = b"\xff\xd8\xff" + b"\x00" * (15 * MB - 3)
        exc = _rejected(imaging, imaging.process_upload, data)
        assert str(exc) != "too_large"
        assert exc.status == 400

    def test_gif_is_bad_magic(self, imaging):
        exc = _rejected(imaging, imaging.process_upload, b"GIF89a\x01\x00\x01\x00\x00\x00\x00;")
        assert str(exc) == "bad_magic"
        assert exc.status == 400

    def test_zero_bytes_is_empty(self, imaging):
        exc = _rejected(imaging, imaging.process_upload, b"")
        assert str(exc) == "empty"
        assert exc.status == 400

    def test_non_image_is_bad_magic(self, imaging):
        exc = _rejected(imaging, imaging.process_upload, b"hello")
        assert str(exc) == "bad_magic"
        assert exc.status == 400

    def test_pixel_bomb_header_is_rejected_without_decoding(self, imaging):
        # 9000x9000 = 81M pixels > MAX_PIXELS; the file has no pixel data at all, so a
        # decode attempt would surface as decode_error rather than pixel_bomb.
        data = _png_header_only(9000, 9000)
        assert len(data) < 1024
        exc = _rejected(imaging, imaging.process_upload, data)
        assert str(exc) == "pixel_bomb"
        assert exc.status == 400

    @pytest.mark.parametrize("size", [(8001, 1), (1, 8001)], ids=["wide", "tall"])
    def test_side_over_max_side_is_pixel_bomb_even_with_few_pixels(self, imaging, size):
        exc = _rejected(imaging, imaging.process_upload, _png_header_only(*size))
        assert str(exc) == "pixel_bomb"
        assert exc.status == 400

    def test_truncated_jpeg_is_decode_error(self, imaging):
        full = _jpeg(256, 256)
        exc = _rejected(imaging, imaging.process_upload, full[: len(full) // 2])
        assert str(exc) == "decode_error"
        assert exc.status == 400

    def test_jpeg_magic_followed_by_garbage_is_decode_error(self, imaging):
        exc = _rejected(imaging, imaging.process_upload, b"\xff\xd8\xff" + b"\x00" * 64)
        assert str(exc) == "decode_error"
        assert exc.status == 400

    def test_png_magic_followed_by_garbage_is_decode_error(self, imaging):
        exc = _rejected(imaging, imaging.process_upload, b"\x89PNG\r\n\x1a\n" + b"\x00" * 64)
        assert str(exc) == "decode_error"
        assert exc.status == 400


def _ztxt_bomb_png():
    """A tiny valid PNG whose zTXt chunk inflates past Pillow's MAX_TEXT_CHUNK (Image.open -> ValueError)."""
    info = PngImagePlugin.PngInfo()
    info.add_text("k", "A" * (2 * PngImagePlugin.MAX_TEXT_CHUNK), zip=True)
    buf = io.BytesIO()
    Image.new("RGB", (8, 8)).save(buf, "PNG", pnginfo=info)
    return buf.getvalue()


# Covers: MEM-012
# Requirement: an upload Pillow refuses with a non-OSError (zTXt decompression bomb raises ValueError in
# Image.open) is rejected as decode_error (400), never an unhandled exception.
class TestProcessUploadNonOsDecodeErrors:
    def test_ztxt_bomb_png_is_decode_error(self, imaging):
        exc = _rejected(imaging, imaging.process_upload, _ztxt_bomb_png())
        assert str(exc) == "decode_error"
        assert exc.status == 400


class TestProcessUploadOutput:
    def test_orientation_6_is_applied_and_exif_dropped(self, imaging):
        # 300x100, left half red / right half blue; orientation 6 = rotate 90 deg clockwise
        # for display, so the upright image is 100x300 with red on top.
        img = Image.new("RGB", (300, 100), (0, 0, 255))
        img.paste((255, 0, 0), (0, 0, 150, 100))
        buf = io.BytesIO()
        img.save(buf, "JPEG", exif=_exif(6))
        data = buf.getvalue()
        assert EXIF_APP1 in data

        out = imaging.process_upload(data)

        assert (out.width, out.height) == (100, 300)
        assert EXIF_APP1 not in out.jpeg
        fmt, size, decoded = _decode(out.jpeg)
        assert (fmt, size) == ("JPEG", (100, 300))
        top = decoded.getpixel((50, 20))
        bottom = decoded.getpixel((50, 280))
        assert top[0] > 200 and top[2] < 60
        assert bottom[2] > 200 and bottom[0] < 60

    def test_landscape_4000x3000_downscales_to_2048x1536(self, imaging):
        out = imaging.process_upload(_jpeg(4000, 3000))
        assert (out.width, out.height) == (2048, 1536)
        assert _decode(out.jpeg)[1] == (2048, 1536)

    def test_portrait_3000x4000_downscales_to_1536x2048(self, imaging):
        out = imaging.process_upload(_jpeg(3000, 4000))
        assert (out.width, out.height) == (1536, 2048)
        assert _decode(out.jpeg)[1] == (1536, 2048)

    def test_800x600_is_never_upscaled(self, imaging):
        out = imaging.process_upload(_jpeg(800, 600))
        assert (out.width, out.height) == (800, 600)
        assert _decode(out.jpeg)[1] == (800, 600)

    def test_long_side_exactly_2048_is_unchanged(self, imaging):
        out = imaging.process_upload(_jpeg(2048, 100))
        assert (out.width, out.height) == (2048, 100)

    def test_same_input_twice_gives_same_bytes_and_sha(self, imaging):
        data = _jpeg(4000, 3000, color=(33, 66, 99))
        first = imaging.process_upload(data)
        second = imaging.process_upload(data)
        assert first.jpeg == second.jpeg
        assert first.sha == second.sha

    def test_sha_is_sha256_hex_of_output_jpeg(self, imaging):
        out = imaging.process_upload(_jpeg(640, 480))
        assert out.sha == hashlib.sha256(out.jpeg).hexdigest()
        assert len(out.sha) == 64

    def test_png_input_becomes_rgb_jpeg(self, imaging):
        out = imaging.process_upload(_png(320, 240, mode="RGBA"))
        fmt, size, decoded = _decode(out.jpeg)
        assert fmt == "JPEG"
        assert size == (320, 240)
        assert decoded.mode == "RGB"

    def test_webp_input_becomes_jpeg(self, imaging):
        out = imaging.process_upload(_webp(320, 240))
        assert _decode(out.jpeg)[:2] == ("JPEG", (320, 240))

    def test_exif_icc_and_comment_are_stripped(self, imaging):
        icc = b"\x00" * 128 + b"fake-icc-profile"
        data = _jpeg(200, 100, exif=_exif(1), icc_profile=icc, comment=b"secret-comment")
        out = imaging.process_upload(data)
        assert EXIF_APP1 not in out.jpeg
        assert b"fake-icc-profile" not in out.jpeg
        assert b"secret-comment" not in out.jpeg
        with Image.open(io.BytesIO(out.jpeg)) as img:
            assert len(img.getexif()) == 0
            assert "icc_profile" not in img.info

    def test_output_passes_validate_processed(self, imaging):
        out = imaging.process_upload(_jpeg(4000, 3000))
        assert imaging.validate_processed(out.jpeg).sha == out.sha


class TestValidateProcessed:
    def test_already_processed_photo_round_trips_byte_identical(self, imaging):
        # Regression (C1 Decision): re-encoding the demo photo at q90 changed the sha
        # every round; validate_processed must hand back the input bytes untouched.
        processed = imaging.process_upload(DEMO_PHOTO.read_bytes())
        checked = imaging.validate_processed(processed.jpeg)
        assert checked.jpeg == processed.jpeg
        assert checked.sha == processed.sha
        assert (checked.width, checked.height) == (processed.width, processed.height)
        again = imaging.validate_processed(checked.jpeg)
        assert again.jpeg == processed.jpeg
        assert again.sha == processed.sha

    def test_sha_is_of_the_input_bytes_not_a_re_encode(self, imaging):
        raw = DEMO_PHOTO.read_bytes()
        checked = imaging.validate_processed(raw)
        assert checked.jpeg == raw
        assert checked.sha == hashlib.sha256(raw).hexdigest()
        assert (checked.width, checked.height) == (1024, 768)

    def test_long_side_exactly_2048_is_accepted(self, imaging):
        data = _jpeg(100, 2048)
        checked = imaging.validate_processed(data)
        assert checked.jpeg == data
        assert (checked.width, checked.height) == (100, 2048)

    def test_png_is_not_jpeg(self, imaging):
        exc = _rejected(imaging, imaging.validate_processed, _png(64, 64))
        assert str(exc) == "not_jpeg"
        assert exc.status == 400

    def test_webp_is_not_jpeg(self, imaging):
        exc = _rejected(imaging, imaging.validate_processed, _webp(64, 64))
        assert str(exc) == "not_jpeg"
        assert exc.status == 400

    def test_exif_bearing_jpeg_is_has_exif(self, imaging):
        exc = _rejected(imaging, imaging.validate_processed, _jpeg(64, 48, exif=_exif(6)))
        assert str(exc) == "has_exif"
        assert exc.status == 400

    def test_3000_px_long_side_is_too_big_side(self, imaging):
        exc = _rejected(imaging, imaging.validate_processed, _jpeg(3000, 2000))
        assert str(exc) == "too_big_side"
        assert exc.status == 400

    def test_2049_px_long_side_is_too_big_side(self, imaging):
        exc = _rejected(imaging, imaging.validate_processed, _jpeg(10, 2049))
        assert str(exc) == "too_big_side"

    def test_empty_is_empty(self, imaging):
        exc = _rejected(imaging, imaging.validate_processed, b"")
        assert str(exc) == "empty"
        assert exc.status == 400

    def test_over_15_mb_is_413_too_large(self, imaging):
        exc = _rejected(imaging, imaging.validate_processed, b"\xff\xd8\xff" + b"\x00" * (15 * MB))
        assert str(exc) == "too_large"
        assert exc.status == 413

    @pytest.mark.parametrize("data", [b"hello", b"GIF89a" + b"\x00" * 32], ids=["text", "gif"])
    def test_non_image_is_bad_magic(self, imaging, data):
        exc = _rejected(imaging, imaging.validate_processed, data)
        assert str(exc) == "bad_magic"
        assert exc.status == 400
