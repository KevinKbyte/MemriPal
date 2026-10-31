# Requirement: on the LIVE backend (a real MetaBackend validating Spark's reply against STATION_SCHEMA;
# only the MetaClient transport is stubbed), a Spark reply that is malformed JSON, has an extra key, or
# lacks a key is an invalid reply: MetaBackend raises BackendReplyInvalid (a BackendCallFailed subclass),
# POST /station regenerates exactly once (attempt 1), a valid second reply is 200, and a second invalid
# reply is 502 bad_reply (never > 2 Spark calls). A transport failure (not ok CallResult) is NOT an
# invalid reply: 502 upstream after exactly one Spark call, no regenerate. Reply text, profile fields and
# used names refuse Unicode format characters (category Cf: bidi override U+202E, zero-width space
# U+200B) as well as control characters (Cc).
import io
import json
import random

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from memripal.backend import BackendCallFailed, MetaBackend, ModelRequest
from memripal.meta_client import CallResult

W, H = 1000, 800
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
INVALID_CONTENT = {
    "malformed-json": '{"station_name": "Stone Arch",',
    "extra-key": json.dumps({**GOOD_REPLY, "extra": "field"}),
    "missing-key": json.dumps({k: v for k, v in GOOD_REPLY.items() if k != "conceptual"}),
}
RLO, ZWSP = "‮", "​"


def _upload() -> bytes:
    img = Image.frombytes("RGB", (W, H), random.Random(0).randbytes(W * H * 3))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=90)
    return buf.getvalue()


UPLOAD = _upload()


def _ok(body: bytes) -> CallResult:
    return CallResult(ok=True, status=200, body=body, error=None, attempts=1, latency_s=0.01)


def _failed() -> CallResult:
    return CallResult(ok=False, status=500, body=b"", error="500 server_error", attempts=1, latency_s=0.01)


def _chat_ok(content: str) -> CallResult:
    return _ok(json.dumps({"choices": [{"message": {"content": content}}]}).encode("utf-8"))


class ScriptedMetaClient:
    """MetaClient transport stub: SAM per phrase, Spark answers scripted in order (last one repeats)."""

    def __init__(self, chat_results: list[CallResult]):
        self.segments = {"person": PERSON_TOKEN, "license plate": "", LANDMARK: LANDMARK_TOKEN}
        self.chat_results = list(chat_results)
        self.chat_calls = 0

    def segment(self, *, image_data_url: str, phrase: str, model: str = "sam-3.1") -> CallResult:
        return _ok(json.dumps({"output_text": self.segments.get(phrase, "")}).encode("utf-8"))

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
        self.chat_calls += 1
        return self.chat_results[min(self.chat_calls, len(self.chat_results)) - 1]


def _post(client: ScriptedMetaClient, used_names=None):
    from memripal.routes_station import make_station_router

    app = FastAPI()
    app.include_router(make_station_router(MetaBackend("fake-key", client=client), lambda request: None))
    headers = {"Content-Type": "image/jpeg"}
    if used_names is not None:
        headers["X-Memripal-Used-Names"] = json.dumps(used_names)
    return TestClient(app).post("/station", content=UPLOAD, headers=headers)


def _spark_request() -> ModelRequest:
    from memripal.station import STATION_SCHEMA

    return ModelRequest(
        method="spark_json",
        image_jpeg=UPLOAD,
        subject="station",
        attempt=0,
        model="muse-spark-1.3",
        prompt_template_id="station",
        gen_params={},
        schema=STATION_SCHEMA,
    )


# Covers: MEM-049
class TestMetaBackendReplyInvalid:
    @pytest.mark.parametrize("content", INVALID_CONTENT.values(), ids=INVALID_CONTENT.keys())
    def test_schema_invalid_spark_reply_raises_backend_reply_invalid(self, content):
        from memripal.backend import BackendReplyInvalid

        assert issubclass(BackendReplyInvalid, BackendCallFailed)
        backend = MetaBackend("fake-key", client=ScriptedMetaClient([_chat_ok(content)]))
        with pytest.raises(BackendReplyInvalid):
            backend.call(_spark_request())

    def test_transport_failure_is_backend_call_failed_but_not_reply_invalid(self):
        from memripal.backend import BackendReplyInvalid

        backend = MetaBackend("fake-key", client=ScriptedMetaClient([_failed()]))
        with pytest.raises(BackendCallFailed) as info:
            backend.call(_spark_request())
        assert not isinstance(info.value, BackendReplyInvalid)


# Covers: MEM-049
class TestStationLiveReplyRegenerate:
    @pytest.mark.parametrize("content", INVALID_CONTENT.values(), ids=INVALID_CONTENT.keys())
    def test_invalid_then_valid_reply_is_200_after_exactly_one_regenerate(self, content):
        client = ScriptedMetaClient([_chat_ok(content), _chat_ok(json.dumps(GOOD_REPLY))])
        resp = _post(client)
        assert resp.status_code == 200, resp.text
        assert resp.json()["name"] == "Stone Arch"
        assert client.chat_calls == 2

    @pytest.mark.parametrize("content", INVALID_CONTENT.values(), ids=INVALID_CONTENT.keys())
    def test_two_invalid_replies_are_502_bad_reply_after_exactly_two_spark_calls(self, content):
        client = ScriptedMetaClient([_chat_ok(content)])
        resp = _post(client)
        assert resp.status_code == 502
        assert resp.json() == {"error": "bad_reply"}
        assert client.chat_calls == 2

    def test_spark_transport_failure_is_502_upstream_with_no_retry(self):
        client = ScriptedMetaClient([_failed(), _chat_ok(json.dumps(GOOD_REPLY))])
        resp = _post(client)
        assert resp.status_code == 502
        assert resp.json() == {"error": "upstream"}
        assert client.chat_calls == 1


# Covers: MEM-049
class TestStationFormatCharacters:
    @pytest.mark.parametrize(
        "bad",
        [
            {**GOOD_REPLY, "station_name": "Stone" + ZWSP + "Arch"},
            {**GOOD_REPLY, "station_name": RLO + "Stone Arch"},
            {**GOOD_REPLY, "landmark_phrase": LANDMARK + ZWSP},
            {**GOOD_REPLY, "visual": "a grey " + RLO + "hcra enots"},
        ],
        ids=["zwsp-name", "rlo-name", "zwsp-phrase", "rlo-profile"],
    )
    def test_format_character_reply_is_regenerated_then_502_bad_reply(self, bad):
        client = ScriptedMetaClient([_chat_ok(json.dumps(bad))])
        resp = _post(client)
        assert resp.status_code == 502
        assert resp.json() == {"error": "bad_reply"}
        assert client.chat_calls == 2

    @pytest.mark.parametrize("name", ["Stone" + ZWSP + "Arch", RLO + "Arch"], ids=["zwsp", "rlo"])
    def test_station_name_with_format_character_is_refused(self, name):
        from memripal.station import valid_station_name

        assert valid_station_name(name) is False

    def test_used_name_with_bidi_override_is_400_bad_used_names(self):
        client = ScriptedMetaClient([_chat_ok(json.dumps(GOOD_REPLY))])
        resp = _post(client, used_names=["blue " + RLO + "door"])
        assert resp.status_code == 400
        assert resp.json() == {"error": "bad_used_names"}
        assert client.chat_calls == 0
