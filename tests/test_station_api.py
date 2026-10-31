# Covers: MEM-049
# Requirement: POST /station (router from routes_station.make_station_router(backend, passcode_error,
# *, max_concurrent=N), exercised on a standalone FastAPI app) takes raw image bytes with the /loci
# upload types and byte cap, plus the route's used names as a JSON array in the X-Memripal-Used-Names
# header (absent == []; <= 7 strings, each <= 3 words and <= 40 chars, else 400 bad_used_names). It
# runs SAM "person" and "license plate" on the processed photo through a STRICT parser (an empty or
# whitespace body is "none found"; a failed call, non-empty text with no box token, any dropped token,
# any out-of-frame box or an over-cap body -> 502 blur_failed with 0 Spark calls), pixelates those
# boxes, then asks Spark (on the pixelated JPEG, used names in its prompt) for {station_name,
# landmark_phrase, visual, spatial, conceptual}; a name that breaks the shape rule or a reply with
# extra fields is regenerated once, then 502 bad_reply (never > 2 Spark calls). One SAM segment on
# landmark_phrase gives the largest valid box, or null. 200 JSON {image (pixelated JPEG data URL),
# width, height, photo_sha (of that JPEG), name, profile, box}. The passcode check runs before the
# body is read; the two blur-phase calls never write the raw photo to the live cache (only the
# pixelated photo may land in photos/); more than max_concurrent requests at once -> 429 busy.
import base64
import hashlib
import io
import json
import random
import threading

import pytest
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
from PIL import Image

from memripal.backend import BackendCallFailed, MetaBackend
from memripal.imaging import MAX_UPLOAD_BYTES, process_upload
from memripal.meta_client import CallResult

W, H = 1000, 800
DATA_URL_PREFIX = "data:image/jpeg;base64,"
USED_NAMES_HEADER = "X-Memripal-Used-Names"
BLUR_PHRASES = ("person", "license plate")
LANDMARK = "stone arch"
PERSON_TOKEN = f"<|box;x1=200;y1=100;x2=800;y2=700;w={W};h={H}|>"
LANDMARK_TOKEN = f"<|box;x1=100;y1=150;x2=300;y2=350;w={W};h={H}|>"
GOOD_REPLY = {
    "station_name": "Stone Arch",
    "landmark_phrase": LANDMARK,
    "visual": "a grey stone arch",
    "spatial": "at the end of the path",
    "conceptual": "a gateway",
}
WAIT_S = 10.0


def _upload(seed: int = 0) -> bytes:
    """A seeded-noise JPEG: pixelating any box visibly changes it, so its bytes change too."""
    img = Image.frombytes("RGB", (W, H), random.Random(seed).randbytes(W * H * 3))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=90)
    return buf.getvalue()


UPLOAD = _upload()
RAW_SHA = process_upload(UPLOAD).sha


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class FakeBackend:
    """In-process ModelBackend recording (method, subject, image sha) for every call, in call order."""

    mode = "fake"

    def __init__(self, blur=None, replies=(GOOD_REPLY,), landmark=LANDMARK_TOKEN):
        self.blur = {"person": PERSON_TOKEN, "license plate": "", **(blur or {})}
        self.replies = list(replies)
        self.landmark = landmark
        self.calls: list[tuple[str, str, str]] = []
        self.spark_images: list[bytes] = []
        self._lock = threading.Lock()

    def call(self, req):
        with self._lock:
            self.calls.append((req.method, req.subject, _sha(req.image_jpeg)))
            n_spark = sum(1 for c in self.calls if c[0] == "spark_json")
        if req.method == "spark_json":
            self.spark_images.append(req.image_jpeg)
            return dict(self.replies[min(n_spark, len(self.replies)) - 1])
        if req.method == "segment" and req.subject in BLUR_PHRASES:
            value = self.blur[req.subject]
            if isinstance(value, Exception):
                raise value
            return value
        if req.method == "segment":
            return self.landmark if req.subject == LANDMARK else ""
        raise AssertionError(f"unexpected method {req.method!r}")

    def count(self, method: str) -> int:
        return sum(1 for c in self.calls if c[0] == method)


def _open(request):
    return None


def _app(backend, passcode_error=_open, **kwargs) -> FastAPI:
    from memripal.routes_station import make_station_router

    app = FastAPI()
    app.include_router(make_station_router(backend, passcode_error, **kwargs))
    return app


def _post(client, body=UPLOAD, content_type="image/jpeg", used_names=None):
    headers = {"Content-Type": content_type}
    if used_names is not None:
        headers[USED_NAMES_HEADER] = used_names if isinstance(used_names, str) else json.dumps(used_names)
    return client.post("/station", content=body, headers=headers)


def _image_bytes(payload: dict) -> bytes:
    assert payload["image"].startswith(DATA_URL_PREFIX)
    return base64.b64decode(payload["image"][len(DATA_URL_PREFIX) :], validate=True)


class TestStationHappyPath:
    def test_200_carries_pixelated_jpeg_dims_sha_name_profile_and_box(self):
        backend = FakeBackend()
        resp = _post(TestClient(_app(backend)))
        assert resp.status_code == 200, resp.text
        body = resp.json()
        jpeg = _image_bytes(body)
        assert body["photo_sha"] == _sha(jpeg)
        assert body["photo_sha"] != RAW_SHA
        assert (body["width"], body["height"]) == (W, H)
        with Image.open(io.BytesIO(jpeg)) as im:
            assert im.format == "JPEG" and im.size == (W, H)
        assert body["name"] == "Stone Arch"
        assert {k: body["profile"][k] for k in ("visual", "spatial", "conceptual")} == {
            k: GOOD_REPLY[k] for k in ("visual", "spatial", "conceptual")
        }
        assert body["box"] == {"x1": 100, "y1": 150, "x2": 300, "y2": 350}

    def test_same_upload_gives_the_same_pixelated_bytes(self):
        first = _post(TestClient(_app(FakeBackend()))).json()
        second = _post(TestClient(_app(FakeBackend()))).json()
        assert first["photo_sha"] == second["photo_sha"]
        assert first["image"] == second["image"]


class TestStationCallOrder:
    def test_two_blur_segments_then_spark_then_one_landmark_segment(self):
        backend = FakeBackend()
        resp = _post(TestClient(_app(backend)))
        assert resp.status_code == 200, resp.text
        methods = [(m, s) for m, s, _ in backend.calls]
        assert len(methods) == 4
        assert {methods[0], methods[1]} == {("segment", "person"), ("segment", "license plate")}
        assert methods[2][0] == "spark_json"
        assert methods[3] == ("segment", LANDMARK)

    def test_blur_runs_on_the_raw_photo_and_spark_and_landmark_on_the_pixelated_one(self):
        backend = FakeBackend()
        body = _post(TestClient(_app(backend))).json()
        shas = {(m, s): sha for m, s, sha in backend.calls}
        assert shas[("segment", "person")] == RAW_SHA
        assert shas[("segment", "license plate")] == RAW_SHA
        assert _sha(backend.spark_images[0]) == body["photo_sha"]
        assert shas[("segment", LANDMARK)] == body["photo_sha"]


class TestStationBlurFailsClosed:
    @pytest.mark.parametrize("phrase", BLUR_PHRASES)
    def test_blur_call_failure_is_502_blur_failed_with_no_spark_call(self, phrase):
        backend = FakeBackend(blur={phrase: BackendCallFailed("segment call failed: 500 x")})
        resp = _post(TestClient(_app(backend)))
        assert resp.status_code == 502
        assert resp.json() == {"error": "blur_failed"}
        assert backend.count("spark_json") == 0

    @pytest.mark.parametrize("empty", ["", "   \n\t "], ids=["empty", "whitespace"])
    def test_empty_blur_bodies_mean_none_found_and_spark_runs_once(self, empty):
        backend = FakeBackend(blur={"person": empty, "license plate": empty})
        resp = _post(TestClient(_app(backend)))
        assert resp.status_code == 200, resp.text
        assert backend.count("spark_json") == 1

    @pytest.mark.parametrize(
        "text",
        [
            "No objects detected.",
            f"<|box;x1=10;y1=10;x2=100;y2=100;w={W}|>",
            f"<|box;x1=10;y1=10;x2={W + 50};y2=100;w={W};h={H}|>",
            PERSON_TOKEN + f"<|box;x1=10;y1=10;x2=100;y2=100;w={W}|>",
            PERSON_TOKEN + " " * (256 * 1024),
        ],
        ids=["no-token-text", "token-missing-h", "sanitize-reject", "one-dropped-of-two", "over-cap"],
    )
    @pytest.mark.parametrize("phrase", BLUR_PHRASES)
    def test_strict_parser_refusals_are_502_blur_failed_with_no_spark_call(self, phrase, text):
        backend = FakeBackend(blur={phrase: text})
        resp = _post(TestClient(_app(backend)))
        assert resp.status_code == 502
        assert resp.json() == {"error": "blur_failed"}
        assert backend.count("spark_json") == 0


class TestStationSparkReply:
    @pytest.mark.parametrize(
        "bad",
        [
            {**GOOD_REPLY, "station_name": "Big Old Stone Arch"},
            {**GOOD_REPLY, "station_name": "Arch 2"},
            {**GOOD_REPLY, "extra": "field"},
        ],
        ids=["four-words", "digit", "extra-field"],
    )
    def test_bad_reply_twice_is_502_bad_reply_after_exactly_two_spark_calls(self, bad):
        backend = FakeBackend(replies=(bad, bad, bad))
        resp = _post(TestClient(_app(backend)))
        assert resp.status_code == 502
        assert resp.json() == {"error": "bad_reply"}
        assert backend.count("spark_json") == 2

    def test_bad_then_good_reply_is_200_with_the_regenerated_name(self):
        backend = FakeBackend(replies=({**GOOD_REPLY, "station_name": "Arch 2"}, GOOD_REPLY))
        resp = _post(TestClient(_app(backend)))
        assert resp.status_code == 200, resp.text
        assert resp.json()["name"] == "Stone Arch"
        assert backend.count("spark_json") == 2

    def test_no_landmark_box_is_200_with_box_null(self):
        backend = FakeBackend(landmark="")
        resp = _post(TestClient(_app(backend)))
        assert resp.status_code == 200, resp.text
        assert resp.json()["box"] is None


class TestStationUsedNames:
    @pytest.mark.parametrize(
        "names",
        [
            [f"name{c}" for c in "abcdefgh"],
            ["big old stone arch"],
            ["arch", 5],
            ["x" * 41],
            {"names": ["arch"]},
            "not json",
        ],
        ids=["eight-names", "four-word-name", "non-string", "41-chars", "not-a-list", "malformed"],
    )
    def test_invalid_used_names_is_400_bad_used_names_with_no_backend_call(self, names):
        backend = FakeBackend()
        resp = _post(TestClient(_app(backend)), used_names=names)
        assert resp.status_code == 400
        assert resp.json() == {"error": "bad_used_names"}
        assert backend.calls == []

    def test_seven_short_names_are_accepted(self):
        names = ["blue door", "old bench", "the mural", "oak tree", "red sign", "iron gate", "x" * 40]
        resp = _post(TestClient(_app(FakeBackend())), used_names=names)
        assert resp.status_code == 200, resp.text

    def test_absent_header_is_accepted(self):
        assert _post(TestClient(_app(FakeBackend()))).status_code == 200


def _ok(body: bytes) -> CallResult:
    return CallResult(ok=True, status=200, body=body, error=None, attempts=1, latency_s=0.01)


def _failed() -> CallResult:
    return CallResult(ok=False, status=500, body=b"", error="500 server_error", attempts=1, latency_s=0.01)


class FakeMetaClient:
    """Stands in for MetaClient behind a real MetaBackend; same keyword-only signatures as the real one."""

    def __init__(self, segments: dict, reply: dict = GOOD_REPLY):
        self.segments = segments
        self.reply = reply
        self.prompts: list[str] = []
        self._lock = threading.Lock()

    def segment(self, *, image_data_url: str, phrase: str, model: str = "sam-3.1") -> CallResult:
        value = self.segments.get(phrase, "")
        if isinstance(value, CallResult):
            return value
        return _ok(json.dumps({"output_text": value}).encode("utf-8"))

    def chat_json(
        self,
        *,
        prompt: str,
        schema: dict,
        schema_name: str,
        image_data_url: str | None = None,
        max_completion_tokens: int = 1024,
        model: str = "muse-spark-1.3",
    ) -> CallResult:
        with self._lock:
            self.prompts.append(prompt)
        envelope = {"choices": [{"message": {"content": json.dumps(self.reply)}}]}
        return _ok(json.dumps(envelope).encode("utf-8"))


def _photos(root) -> list[str]:
    folder = root / "photos"
    return sorted(p.name for p in folder.iterdir()) if folder.is_dir() else []


class TestStationLiveBackend:
    def test_used_names_appear_in_the_spark_prompt(self, tmp_path):
        client = FakeMetaClient({"person": PERSON_TOKEN, "license plate": "", LANDMARK: LANDMARK_TOKEN})
        backend = MetaBackend("fake-key", cache_root=tmp_path / "cache", client=client)
        names = ["blue door", "old bench"]
        resp = _post(TestClient(_app(backend)), used_names=names)
        assert resp.status_code == 200, resp.text
        assert len(client.prompts) == 1
        for name in names:
            assert name in client.prompts[0]

    def test_after_200_photos_holds_only_the_pixelated_photo(self, tmp_path):
        client = FakeMetaClient({"person": PERSON_TOKEN, "license plate": "", LANDMARK: LANDMARK_TOKEN})
        root = tmp_path / "cache"
        resp = _post(TestClient(_app(MetaBackend("fake-key", cache_root=root, client=client))))
        assert resp.status_code == 200, resp.text
        assert _photos(root) == [resp.json()["photo_sha"] + ".jpg"]

    def test_blur_failed_after_person_succeeded_leaves_no_photo_on_disk(self, tmp_path):
        client = FakeMetaClient({"person": PERSON_TOKEN, "license plate": _failed()})
        root = tmp_path / "cache"
        resp = _post(TestClient(_app(MetaBackend("fake-key", cache_root=root, client=client))))
        assert resp.status_code == 502
        assert resp.json() == {"error": "blur_failed"}
        assert _photos(root) == []
        assert client.prompts == []


class _ReceiveSpy:
    """ASGI wrapper counting body messages the app pulls from receive()."""

    def __init__(self, app):
        self.app = app
        self.body_reads = 0

    async def __call__(self, scope, receive, send):
        async def spy():
            message = await receive()
            if message["type"] == "http.request":
                self.body_reads += 1
            return message

        await self.app(scope, spy, send)


def _deny(request):
    return JSONResponse({"error": "passcode_required"}, status_code=401)


class TestStationGates:
    @pytest.mark.parametrize(
        ("body", "content_type"),
        [(UPLOAD, "image/jpeg"), (b"GIF89a", "image/gif"), (b"\xff" * (MAX_UPLOAD_BYTES + 1), "image/jpeg")],
        ids=["valid", "gif", "over-size"],
    )
    def test_passcode_refusal_is_401_before_the_body_is_read(self, body, content_type):
        backend = FakeBackend()
        spy = _ReceiveSpy(_app(backend, passcode_error=_deny))
        resp = _post(TestClient(spy), body=body, content_type=content_type)
        assert resp.status_code == 401
        assert resp.json() == {"error": "passcode_required"}
        assert spy.body_reads == 0
        assert backend.calls == []

    @pytest.mark.parametrize(
        ("body", "content_type", "status", "code"),
        [
            (b"\xff" * (MAX_UPLOAD_BYTES + 1), "image/jpeg", 413, "too_large"),
            (b"GIF89a" + b"\x00" * 64, "image/gif", 415, "unsupported_media_type"),
            (UPLOAD, "application/octet-stream", 415, "unsupported_media_type"),
        ],
        ids=["over-size", "gif", "unknown-type"],
    )
    def test_upload_limits_match_loci_and_call_no_backend(self, body, content_type, status, code):
        backend = FakeBackend()
        resp = _post(TestClient(_app(backend)), body=body, content_type=content_type)
        assert resp.status_code == status
        assert resp.json() == {"error": code}
        assert backend.calls == []


class _BlockingBackend(FakeBackend):
    """Holds every "person" blur call until released, so requests stay in flight deterministically."""

    def __init__(self):
        super().__init__()
        self.release = threading.Event()
        self.entered = 0
        self.cond = threading.Condition()

    def call(self, req):
        if req.method == "segment" and req.subject == "person":
            with self.cond:
                self.entered += 1
                self.cond.notify_all()
            self.release.wait(WAIT_S)
        return super().call(req)


class TestStationConcurrencyCap:
    @pytest.mark.parametrize("cap", [1, 2])
    def test_one_request_over_the_cap_is_429_busy(self, cap):
        backend = _BlockingBackend()
        results: list = []
        lock = threading.Lock()

        with TestClient(_app(backend, max_concurrent=cap)) as client:

            def send():
                resp = _post(client)
                with lock:
                    results.append((resp.status_code, resp.json()))

            holders = [threading.Thread(target=send) for _ in range(cap)]
            extra = threading.Thread(target=send)
            try:
                for t in holders:
                    t.start()
                with backend.cond:
                    assert backend.cond.wait_for(lambda: backend.entered >= cap, WAIT_S)
                extra.start()
                extra.join(WAIT_S)
            finally:
                backend.release.set()
                for t in [*holders, extra]:
                    if t.ident is not None:
                        t.join(WAIT_S)

        statuses = sorted(s for s, _ in results)
        assert statuses == [200] * cap + [429]
        assert [body for s, body in results if s == 429] == [{"error": "busy"}]


# Criterion (14) app.py <= 582 lines is deferred to the B4 create_app wiring slice (routes_station is
# not wired into create_app here); that slice owns its test.
