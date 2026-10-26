# Covers: MEM-004
# Requirement: the pre-commit scanner blocks a commit (exit 1, stderr names each
# offending path) when a staged file contains a secret-shaped string or carries
# EXIF metadata in a JPEG/PNG/WEBP image, and passes (exit 0) for clean files and
# for paths that no longer exist.
import struct
import subprocess
import sys
import zlib
from io import BytesIO
from pathlib import Path

import pytest
from PIL import Image

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "scripts" / "precommit_scan.py"

# Secret strings are assembled by concatenation so this source file never
# matches the scanner's own patterns.
SECRET_CASES = {
    "sk_key": "api = " + "sk" + "-" + "A1b2C3d4E5f6G7h8I9j0K1",
    "bearer": "Authorization: " + "Bear" + "er " + "abcDEF123._-xyzQRS7890",
    "signature": "https://cdn.example/x.webp?Expires=1&" + "Signa" + "ture=abc",
    "token_query": "https://cdn.example/x.jpg?" + "tok" + "en=abc",
    "token_amp": "https://cdn.example/x.jpg?a=1&" + "tok" + "en=abc",
    "meta_key": "META" + "_API" + "_KEY" + " = " + "'" + "realval12345" + "'",
}


def run_scan(*paths):
    return subprocess.run(
        [sys.executable, str(SCRIPT), *[str(p) for p in paths]],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=60,
    )


def _png_chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))


def _clean_png_bytes() -> bytes:
    buf = BytesIO()
    Image.new("RGB", (4, 4), (10, 20, 30)).save(buf, format="PNG")
    return buf.getvalue()


def _png_with_exif_chunk() -> bytes:
    raw = _clean_png_bytes()
    # Insert an eXIf chunk right after IHDR (8-byte signature + 25-byte IHDR chunk).
    cut = 8 + 25
    exif_payload = b"II*\x00\x08\x00\x00\x00\x00\x00"
    return raw[:cut] + _png_chunk(b"eXIf", exif_payload) + raw[cut:]


def _webp_with_exif() -> bytes:
    vp8x = b"VP8X" + struct.pack("<I", 10) + bytes([0x08, 0, 0, 0]) + b"\x03\x00\x00\x03\x00\x00"
    exif_data = b"Exif\x00\x00II*\x00\x08\x00\x00\x00"
    exif_chunk = b"EXIF" + struct.pack("<I", len(exif_data)) + exif_data
    body = b"WEBP" + vp8x + exif_chunk
    return b"RIFF" + struct.pack("<I", len(body)) + body


def _jpeg_with_app1_exif() -> bytes:
    payload = b"Exif\x00\x00II*\x00\x08\x00\x00\x00\x00\x00"
    app1 = b"\xff\xe1" + struct.pack(">H", len(payload) + 2) + payload
    return b"\xff\xd8" + app1 + b"\xff\xd9"


def _clean_jpeg_bytes() -> bytes:
    buf = BytesIO()
    Image.new("RGB", (8, 8), (200, 100, 50)).save(buf, format="JPEG")
    return buf.getvalue()


def _pillow_jpeg_with_exif() -> bytes:
    img = Image.new("RGB", (8, 8), (1, 2, 3))
    exif = img.getexif()
    exif[0x010F] = "SomeCamera"
    buf = BytesIO()
    img.save(buf, format="JPEG", exif=exif.tobytes())
    return buf.getvalue()


class TestPrecommitScan:
    @pytest.mark.parametrize("name", sorted(SECRET_CASES))
    def test_secret_pattern_blocks_and_names_path(self, tmp_path, name):
        target = tmp_path / f"{name}.txt"
        target.write_text("header line\n" + SECRET_CASES[name] + "\n", encoding="utf-8")
        result = run_scan(target)
        assert result.returncode == 1, result.stderr
        assert str(target) in result.stderr or target.name in result.stderr

    def test_sk_key_boundary_19_chars_passes_20_blocks(self, tmp_path):
        short = tmp_path / "short.txt"
        short.write_text("sk" + "-" + "a" * 19 + "\n", encoding="utf-8")
        long = tmp_path / "long.txt"
        long.write_text("sk" + "-" + "a" * 20 + "\n", encoding="utf-8")
        assert run_scan(short).returncode == 0
        assert run_scan(long).returncode == 1

    def test_meta_key_short_value_passes(self, tmp_path):
        target = tmp_path / "env.txt"
        target.write_text("META" + "_API" + "_KEY" + "=abc1234\n", encoding="utf-8")
        assert run_scan(target).returncode == 0

    def test_hand_built_jpeg_app1_exif_blocks(self, tmp_path):
        target = tmp_path / "photo.jpg"
        target.write_bytes(_jpeg_with_app1_exif())
        result = run_scan(target)
        assert result.returncode == 1
        assert "photo.jpg" in result.stderr

    def test_pillow_jpeg_with_exif_blocks_jpeg_extension(self, tmp_path):
        target = tmp_path / "camera.jpeg"
        target.write_bytes(_pillow_jpeg_with_exif())
        result = run_scan(target)
        assert result.returncode == 1
        assert "camera.jpeg" in result.stderr

    def test_png_with_exif_chunk_blocks(self, tmp_path):
        target = tmp_path / "image.png"
        target.write_bytes(_png_with_exif_chunk())
        result = run_scan(target)
        assert result.returncode == 1
        assert "image.png" in result.stderr

    def test_webp_with_exif_blocks(self, tmp_path):
        target = tmp_path / "edit.webp"
        target.write_bytes(_webp_with_exif())
        result = run_scan(target)
        assert result.returncode == 1
        assert "edit.webp" in result.stderr

    def test_clean_text_and_clean_images_pass(self, tmp_path):
        text = tmp_path / "notes.md"
        text.write_text("# Notes\nNothing secret here; token budget is fine.\n", encoding="utf-8")
        jpg = tmp_path / "clean.jpg"
        jpg.write_bytes(_clean_jpeg_bytes())
        png = tmp_path / "clean.png"
        png.write_bytes(_clean_png_bytes())
        result = run_scan(text, jpg, png)
        assert result.returncode == 0, result.stderr

    def test_missing_path_ignored(self, tmp_path):
        clean = tmp_path / "ok.txt"
        clean.write_text("hello\n", encoding="utf-8")
        result = run_scan(tmp_path / "deleted.txt", clean)
        assert result.returncode == 0, result.stderr

    def test_only_offending_paths_named_among_mixed_inputs(self, tmp_path):
        clean = tmp_path / "innocent.txt"
        clean.write_text("hello\n", encoding="utf-8")
        bad_text = tmp_path / "leaky.txt"
        bad_text.write_text(SECRET_CASES["sk_key"] + "\n", encoding="utf-8")
        bad_img = tmp_path / "gps.jpg"
        bad_img.write_bytes(_jpeg_with_app1_exif())
        result = run_scan(clean, bad_text, bad_img)
        assert result.returncode == 1
        assert "leaky.txt" in result.stderr
        assert "gps.jpg" in result.stderr
        assert "innocent.txt" not in result.stderr
