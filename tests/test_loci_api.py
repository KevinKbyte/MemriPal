# Covers: MEM-015
# Requirement: POST /loci takes raw image bytes (Content-Type image/jpeg|png|webp, else 415),
# refuses bodies over 15 MB with 413 (a too-large Content-Length before reading anything, a
# chunked body as soon as the running byte count passes the cap), runs process_upload ->
# find_loci and answers 200 JSON {image (EXIF-free processed JPEG as a data URL), width,
# height, photo_sha, reask_used, loci:[{n, label, phrase, box{x1,y1,x2,y2}, outline}]}.
# Upload rejections answer their ImageRejected status + {"error": code}; a missing fixture
# answers 404 {"error": "fixture_missing"}; a failed upstream call answers 502
# {"error": "upstream"} with no model text. The offline demo photo yields >= 10 loci, and
# scripts/run_live.ps1 binds uvicorn to 127.0.0.1, never 0.0.0.0, until the S7 passcode.
# Hardening: a Host header other than 127.0.0.1 / localhost (any port) is refused with 400
# (DNS-rebinding guard, every route); a Content-Length that is not plain ASCII digits never
# 500s (400/413 + {"error": ...}); any unexpected pipeline exception answers 500
# {"error": "internal"} with no exception text.
import asyncio
import base64
import hashlib
import io
import json
import re
import struct
import zlib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

import memripal.app as app_module
from memripal import loci
from memripal.app import create_app
from memripal.backend import BackendCallFailed, FixtureBackend, ResponseCache
from memripal.imaging import MAX_UPLOAD_BYTES, process_upload

REPO = Path(__file__).resolve().parents[1]
DEMO_PHOTO = REPO / "fixtures" / "demo" / "photo.jpg"
REPLAY_DIR = REPO / "fixtures" / "replay"
RUN_LIVE = REPO / "scripts" / "run_live.ps1"
MB = 1024 * 1024
W, H = 1000, 800
DATA_URL_PREFIX = "data:image/jpeg;base64,"
LEAK_MARKER = "MODEL-SAID-SECRET-TEXT"
LOOPBACK_URL = "http://127.0.0.1"

NOUNS = [
    "lamp", "chair", "desk", "sofa", "clock", "plant", "rug", "shelf", "door", "window",
    "mirror", "vase",
]  # fmt: skip


def _token(i: int) -> str:
    """120 px square in cell i of a 5x4 grid of 200 px cells on a W x H frame."""
    x1, y1 = 20 + 200 * (i % 5), 20 + 200 * (i // 5)
    return f"<|box;x1={x1};y1={y1};x2={x1 + 120};y2={y1 + 120};w={W};h={H}|>"


class FakeBackend:
    """In-process ModelBackend: fixed phrases, empty re-ask, one separated SAM box per phrase."""

    mode = "fake"

    def __init__(self, phrases=tuple(NOUNS), fail_with: Exception | None = None):
        self.phrases = list(phrases)
        self.fail_with = fail_with
        self.calls = 0

    def call(self, req):
        self.calls += 1
        if self.fail_with is not None:
            raise self.fail_with
        if req.method == "spark_json":
            return {"phrases": self.phrases if req.subject == "phrases" else []}
        if req.method == "segment":
            return _token(self.phrases.index(req.subject)) if req.subject in self.phrases else ""
        raise AssertionError(f"unexpected method {req.method!r}")


class _Recorder:
    """Writes every answer under its derived request key so FixtureBackend can replay it."""

    mode = "fake"

    def __init__(self, inner, root: Path):
        self.inner = inner
        self.cache = ResponseCache(root)

    def call(self, req):
        value = self.inner.call(req)
        body = value.encode("utf-8") if isinstance(value, str) else json.dumps(value).encode("utf-8")
        self.cache.put(req.cache_key(), body)
        return value


def _jpeg(w=W, h=H, color=(120, 80, 40), **save_kwargs) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), color).save(buf, "JPEG", **save_kwargs)
    return buf.getvalue()


def _png_header_only(w: int, h: int) -> bytes:
    """A tiny PNG that declares w x h in its IHDR but carries no pixel data."""

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IEND", b"")


def _record_replay(root: Path, upload: bytes):
    """Record a 12-phrase run for `upload` under root; return (processed, expected LociResult)."""
    processed = process_upload(upload)
    loci.find_loci(_Recorder(FakeBackend(), root), processed)
    return processed, loci.find_loci(FixtureBackend(root), processed)


def _client(app, base_url: str = LOOPBACK_URL, **kwargs) -> TestClient:
    """TestClient sending a loopback Host (its default "testserver" is refused by the host guard)."""
    return TestClient(app, base_url=base_url, **kwargs)


def _post(client: TestClient, body, content_type: str | None = "image/jpeg"):
    headers = {} if content_type is None else {"Content-Type": content_type}
    return client.post("/loci", content=body, headers=headers)


def _image_bytes(payload: dict) -> bytes:
    assert payload["image"].startswith(DATA_URL_PREFIX)
    return base64.b64decode(payload["image"][len(DATA_URL_PREFIX) :], validate=True)


def _locus_json(lc) -> dict:
    return {
        "n": lc.n,
        "label": lc.label,
        "phrase": lc.phrase,
        "box": {"x1": lc.box.x1, "y1": lc.box.y1, "x2": lc.box.x2, "y2": lc.box.y2},
        "outline": [[x, y] for x, y in lc.outline],
    }


# Covers: MEM-015
class TestLociSuccess:
    def test_returns_exact_response_shape(self, tmp_path):
        upload = _jpeg()
        processed, expected = _record_replay(tmp_path, upload)
        resp = _post(_client(create_app(backend=FixtureBackend(tmp_path))), upload)
        assert resp.status_code == 200, resp.text
        assert resp.headers["content-type"].startswith("application/json")
        payload = resp.json()
        assert set(payload) == {"image", "width", "height", "photo_sha", "reask_used", "loci"}
        assert payload["width"] == processed.width == W
        assert payload["height"] == processed.height == H
        assert payload["photo_sha"] == processed.sha
        assert payload["reask_used"] is False
        assert payload["loci"] == [_locus_json(lc) for lc in expected.loci]

    def test_twelve_phrases_give_twelve_numbered_loci(self, tmp_path):
        upload = _jpeg()
        _record_replay(tmp_path, upload)
        payload = _post(_client(create_app(backend=FixtureBackend(tmp_path))), upload).json()
        assert [lc["n"] for lc in payload["loci"]] == list(range(1, 13))
        assert {lc["phrase"] for lc in payload["loci"]} == set(NOUNS)
        for lc in payload["loci"]:
            assert set(lc) == {"n", "label", "phrase", "box", "outline"}
            assert set(lc["box"]) == {"x1", "y1", "x2", "y2"}
            assert all(isinstance(v, int) for v in lc["box"].values())
            assert all(isinstance(p, list) and len(p) == 2 for p in lc["outline"])

    def test_image_is_the_processed_jpeg_and_sha_matches_it(self, tmp_path):
        upload = _jpeg()
        processed, _ = _record_replay(tmp_path, upload)
        payload = _post(_client(create_app(backend=FixtureBackend(tmp_path))), upload).json()
        image = _image_bytes(payload)
        assert image == processed.jpeg
        assert hashlib.sha256(image).hexdigest() == payload["photo_sha"]

    def test_response_image_carries_no_exif(self, tmp_path):
        exif = Image.Exif()
        exif[0x010F] = "SecretCamMaker"
        exif[0x0112] = 1
        upload = _jpeg(exif=exif.tobytes())
        assert b"Exif\x00\x00" in upload
        _record_replay(tmp_path, upload)
        resp = _post(_client(create_app(backend=FixtureBackend(tmp_path))), upload)
        assert resp.status_code == 200, resp.text
        image = _image_bytes(resp.json())
        assert b"Exif\x00\x00" not in image
        assert b"SecretCamMaker" not in image
        with Image.open(io.BytesIO(image)) as img:
            assert img.format == "JPEG"
            assert "exif" not in img.info

    @pytest.mark.parametrize("fmt,content_type", [("PNG", "image/png"), ("WEBP", "image/webp")])
    def test_png_and_webp_are_accepted(self, tmp_path, fmt, content_type):
        buf = io.BytesIO()
        Image.new("RGB", (W, H), (10, 200, 30)).save(buf, fmt)
        upload = buf.getvalue()
        _record_replay(tmp_path, upload)
        resp = _post(_client(create_app(backend=FixtureBackend(tmp_path))), upload, content_type)
        assert resp.status_code == 200, resp.text
        assert len(resp.json()["loci"]) == 12


# Covers: MEM-015
# Needs the S2.6 regenerated demo fixtures (keyed by process_upload(photo) under derived request
# keys); the committed S1 fixtures use legacy CacheKeys and only 3 phrases.
class TestDemoPhotoOffline:
    def test_demo_photo_yields_at_least_ten_loci(self):
        client = _client(create_app(backend=FixtureBackend(REPLAY_DIR)))
        resp = _post(client, DEMO_PHOTO.read_bytes())
        assert resp.status_code == 200, resp.text
        payload = resp.json()
        assert len(payload["loci"]) >= 10
        assert payload["photo_sha"] == process_upload(DEMO_PHOTO.read_bytes()).sha


# Covers: MEM-015
class TestUploadRejections:
    @pytest.mark.parametrize(
        "body,content_type,status,code",
        [
            (b"", "image/jpeg", 400, "empty"),
            (b"GIF89a" + b"\x00" * 64, "image/jpeg", 400, "bad_magic"),
            (b"\xff\xd8\xff" + b"not really a jpeg" * 8, "image/jpeg", 400, "decode_error"),
            (_png_header_only(9000, 9000), "image/png", 400, "pixel_bomb"),
        ],
        ids=["empty", "bad_magic", "decode_error", "pixel_bomb"],
    )
    def test_image_rejected_maps_to_status_and_code(self, body, content_type, status, code):
        backend = FakeBackend()
        resp = _post(_client(create_app(backend=backend)), body, content_type)
        assert resp.status_code == status
        assert resp.json() == {"error": code}
        assert backend.calls == 0

    def test_too_large_with_content_length_is_413(self):
        backend = FakeBackend()
        body = b"\xff\xd8\xff" + b"\x00" * (MAX_UPLOAD_BYTES - 2)
        assert len(body) == MAX_UPLOAD_BYTES + 1
        resp = _post(_client(create_app(backend=backend)), body)
        assert resp.status_code == 413
        assert resp.json() == {"error": "too_large"}
        assert backend.calls == 0

    def test_exactly_fifteen_mb_is_not_413(self):
        body = b"\xff\xd8\xff" + b"\x00" * (MAX_UPLOAD_BYTES - 3)
        assert len(body) == MAX_UPLOAD_BYTES
        resp = _post(_client(create_app(backend=FakeBackend())), body)
        assert resp.status_code == 400
        assert resp.json() == {"error": "decode_error"}

    def test_chunked_body_without_content_length_past_cap_is_413(self):
        def chunks():
            yield b"\xff\xd8\xff"
            for _ in range(16):
                yield b"\x00" * MB

        backend = FakeBackend()
        resp = _post(_client(create_app(backend=backend)), chunks())
        assert resp.status_code == 413
        assert backend.calls == 0


# Covers: MEM-015
class TestContentType:
    @pytest.mark.parametrize(
        "content_type",
        ["text/plain", "application/octet-stream", "image/gif", "image/heic", "multipart/form-data", None],
    )
    def test_wrong_or_missing_content_type_is_415(self, content_type):
        backend = FakeBackend()
        resp = _post(_client(create_app(backend=backend)), _jpeg(), content_type)
        assert resp.status_code == 415
        assert backend.calls == 0


def _loci_scope(headers: list[tuple[bytes, bytes]]) -> dict:
    """POST /loci ASGI scope with a loopback Host header ahead of the given raw headers."""
    return {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": "/loci",
        "raw_path": b"/loci",
        "root_path": "",
        "query_string": b"",
        "headers": [(b"host", b"127.0.0.1:8000"), *headers],
        "client": ("127.0.0.1", 50000),
        "server": ("127.0.0.1", 8000),
    }


def _run_asgi(app, headers: list[tuple[bytes, bytes]], chunk_count: int, chunk_size: int = MB):
    """Drive the ASGI app directly so the test sees how many body chunks it actually pulled."""
    pulled = 0
    sent: list[dict] = []

    async def receive():
        nonlocal pulled
        if pulled < chunk_count:
            pulled += 1
            return {"type": "http.request", "body": b"\x00" * chunk_size, "more_body": pulled < chunk_count}
        return {"type": "http.disconnect"}

    async def send(message):
        sent.append(message)

    asyncio.run(app(_loci_scope(headers), receive, send))
    start = next(m for m in sent if m["type"] == "http.response.start")
    return start["status"], pulled


def _asgi_post(app, headers: list[tuple[bytes, bytes]], body: bytes):
    """One-shot raw ASGI POST /loci; returns (status, response body, exception that escaped the app)."""
    sent: list[dict] = []
    delivered = False

    async def receive():
        nonlocal delivered
        if not delivered:
            delivered = True
            return {"type": "http.request", "body": body, "more_body": False}
        return {"type": "http.disconnect"}

    async def send(message):
        sent.append(message)

    escaped = None
    try:
        asyncio.run(app(_loci_scope(headers), receive, send))
    except Exception as exc:  # recorded and asserted on, so a 500 shows up as a failed assertion
        escaped = exc
    start = next(m for m in sent if m["type"] == "http.response.start")
    payload = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    return start["status"], payload, escaped


# Covers: MEM-015
class TestStreamingCap:
    def test_oversize_content_length_rejected_before_reading_body(self):
        headers = [(b"content-type", b"image/jpeg"), (b"content-length", str(MAX_UPLOAD_BYTES + 1).encode())]
        status, pulled = _run_asgi(create_app(backend=FakeBackend()), headers, chunk_count=16)
        assert status == 413
        assert pulled == 0

    def test_chunked_body_aborts_once_running_count_passes_cap(self):
        # 32 MB offered in 1 MB chunks; a running cap stops pulling at the 16th chunk.
        headers = [(b"content-type", b"image/jpeg"), (b"transfer-encoding", b"chunked")]
        status, pulled = _run_asgi(create_app(backend=FakeBackend()), headers, chunk_count=32)
        assert status == 413
        assert pulled <= MAX_UPLOAD_BYTES // MB + 1


# Covers: MEM-015
class TestBackendErrors:
    def test_fixture_missing_is_404(self, tmp_path):
        resp = _post(_client(create_app(backend=FixtureBackend(tmp_path))), _jpeg())
        assert resp.status_code == 404
        assert resp.json() == {"error": "fixture_missing"}

    def test_backend_call_failed_is_502_without_model_text(self):
        backend = FakeBackend(fail_with=BackendCallFailed(f"spark_json call failed: 500 {LEAK_MARKER}"))
        resp = _post(_client(create_app(backend=backend)), _jpeg())
        assert resp.status_code == 502
        assert resp.json() == {"error": "upstream"}
        assert LEAK_MARKER not in resp.text
        assert "spark_json" not in resp.text


# Covers: MEM-015
class TestRunLiveBindsLoopback:
    def test_default_command_binds_127_0_0_1_and_never_0_0_0_0(self):
        text = RUN_LIVE.read_text(encoding="utf-8")
        default_lines = [ln for ln in text.splitlines() if "memripal.app:app" in ln and "$Command" in ln]
        assert default_lines, "run_live.ps1 has no default uvicorn command"
        for line in default_lines:
            assert re.search(r"'--host'\s*,\s*'127\.0\.0\.1'", line), line
        assert "0.0.0.0" not in text


# Covers: MEM-015
# Requirement: the loopback-only server refuses any Host header other than 127.0.0.1 / localhost
# (with or without a port) on every route, so a DNS-rebinding page cannot drive it.
class TestHostGuard:
    @pytest.mark.parametrize(
        "host",
        [
            "evil.example.com",
            "evil.example.com:8000",
            "127.0.0.1.evil.example.com",
            "localhost.evil.example.com:8000",
            "testserver",
        ],
    )
    def test_foreign_host_is_refused_on_post_loci(self, host):
        backend = FakeBackend()
        resp = _post(_client(create_app(backend=backend), base_url=f"http://{host}"), _jpeg())
        assert resp.status_code == 400, resp.text[:200]
        assert "loci" not in resp.text
        assert backend.calls == 0

    @pytest.mark.parametrize("host", ["evil.example.com", "evil.example.com:8000", "testserver"])
    def test_foreign_host_is_refused_on_healthz(self, host):
        resp = _client(create_app(backend=FakeBackend()), base_url=f"http://{host}").get("/healthz")
        assert resp.status_code == 400, resp.text
        assert "mode" not in resp.text

    @pytest.mark.parametrize("host", ["127.0.0.1", "127.0.0.1:8000", "localhost", "localhost:8000"])
    def test_loopback_host_is_accepted(self, host):
        client = _client(create_app(backend=FakeBackend()), base_url=f"http://{host}")
        assert client.get("/healthz").status_code == 200
        resp = _post(client, _jpeg())
        assert resp.status_code == 200, resp.text
        assert len(resp.json()["loci"]) == 12


# Covers: MEM-015
# Requirement: a Content-Length made of non-ASCII digit characters (str.isdigit() is True for
# U+00B2 superscript two, but int() rejects it) is a client error, never a 500.
class TestNonAsciiContentLength:
    @pytest.mark.parametrize("length", ["\u00b2", "\u00b3", "1\u00b9"], ids=["sup2", "sup3", "one-sup1"])
    def test_non_ascii_digit_content_length_is_a_json_client_error(self, length):
        backend = FakeBackend()
        upload = _jpeg()
        headers = [(b"content-type", b"image/jpeg"), (b"content-length", length.encode("latin-1"))]
        status, payload, escaped = _asgi_post(create_app(backend=backend), headers, upload)
        assert status in (400, 413), (status, payload)
        assert escaped is None, repr(escaped)
        body = json.loads(payload)
        assert set(body) == {"error"}
        assert isinstance(body["error"], str)
        assert backend.calls == 0


# Covers: MEM-015
# Requirement: an unexpected exception anywhere in the upload pipeline answers 500
# {"error": "internal"} and never echoes the exception text or type to the client.
class TestInternalErrorMapping:
    @pytest.mark.parametrize("target", ["find_loci", "process_upload"])
    def test_unexpected_exception_is_500_internal_without_detail(self, monkeypatch, target):
        def boom(*_args, **_kwargs):
            raise TypeError("secret-marker")

        monkeypatch.setattr(app_module, target, boom)
        client = _client(create_app(backend=FakeBackend()), raise_server_exceptions=False)
        resp = _post(client, _jpeg())
        assert resp.status_code == 500
        assert resp.headers["content-type"].startswith("application/json"), resp.text
        assert resp.json() == {"error": "internal"}
        assert "secret-marker" not in resp.text
        assert "TypeError" not in resp.text
