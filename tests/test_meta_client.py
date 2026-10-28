# Covers: MEM-006
# Requirement: the Meta HTTP client sends the documented JSON payloads for Spark chat
# (strict json_schema, optional image), SAM segmentation and image edits with a bearer
# header; retries only 429/500/503 and connect-phase transport errors (ConnectError,
# ConnectTimeout; never read/protocol errors after the request may have been sent)
# (Retry-After honoured, capped at 60s, else exponential backoff plus jitter, at most 3
# attempts; image edits are never retried); rejects a response body over MAX_RESPONSE_BYTES
# as a non-retryable error without returning its content; surfaces a server error code only when it matches
# [A-Za-z0-9_.-]{1,64}, else "http_error"; returns a CallResult instead of raising;
# never leaks the API key in errors or repr; and offers pure helpers
# to unpack chat JSON, SAM text, edited image bytes and to build JPEG data URLs.
import base64
import dataclasses
import json

import httpx
import pytest

from memripal import meta_client
from memripal.backend import MissingApiKey
from memripal.meta_client import (
    CallResult,
    MetaClient,
    chat_content_json,
    image_bytes,
    responses_text,
    to_data_url,
)

# Built by concatenation so this file never matches the pre-commit secret scanner (MEM-004).
KEY = "fake" + "-meta-" + "k" * 24
DATA_URL = "data:image/jpeg;base64," + base64.b64encode(b"\xff\xd8jpegbytes").decode()
SCHEMA = {"type": "object", "properties": {"phrases": {"type": "array", "items": {"type": "string"}}}}


class Recorder:
    """MockTransport handler returning queued responses (or raising queued exceptions)."""

    def __init__(self, *responses):
        self.queue = list(responses)
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        item = self.queue.pop(0) if len(self.queue) > 1 else self.queue[0]
        if isinstance(item, Exception):
            raise item
        return item

    def payload(self, i: int = 0) -> dict:
        return json.loads(self.requests[i].content)


def ok(body: dict | None = None) -> httpx.Response:
    return httpx.Response(200, json=body if body is not None else {"ok": True})


def err(status: int, code: str | None = "server_error", headers: dict | None = None) -> httpx.Response:
    body = {"error": {"message": "nope", "type": "t", "param": None, "code": code}}
    return httpx.Response(status, json=body, headers=headers or {})


def make_client(rec: Recorder, rand_value: float = 0.0, **kw):
    sleeps: list[float] = []
    client = MetaClient(
        KEY, transport=httpx.MockTransport(rec), sleep=sleeps.append, rand=lambda: rand_value, **kw
    )
    return client, sleeps


class TestPayloads:
    # Covers: MEM-006

    def test_chat_json_with_image_payload_exact(self):
        rec = Recorder(ok())
        client, _ = make_client(rec)
        client.chat_json(prompt="list things", schema=SCHEMA, schema_name="phrases", image_data_url=DATA_URL)
        assert str(rec.requests[0].url) == "https://api.meta.ai/v1/chat/completions"
        assert rec.requests[0].method == "POST"
        assert rec.payload() == {
            "model": "muse-spark-1.3",
            "max_completion_tokens": 1024,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "list things"},
                        {"type": "image_url", "image_url": {"url": DATA_URL}},
                    ],
                }
            ],
            "response_format": {
                "type": "json_schema",
                "json_schema": {"name": "phrases", "strict": True, "schema": SCHEMA},
            },
        }

    def test_chat_json_without_image_has_no_image_part_and_keeps_token_cap(self):
        rec = Recorder(ok())
        client, _ = make_client(rec)
        client.chat_json(prompt="assoc", schema=SCHEMA, schema_name="assoc", max_completion_tokens=77)
        p = rec.payload()
        assert p["max_completion_tokens"] == 77
        assert p["messages"] == [{"role": "user", "content": [{"type": "text", "text": "assoc"}]}]
        assert p["response_format"]["json_schema"]["strict"] is True
        assert "image_url" not in json.dumps(p)

    def test_segment_payload_exact(self):
        rec = Recorder(ok())
        client, _ = make_client(rec)
        client.segment(image_data_url=DATA_URL, phrase="red mug")
        assert str(rec.requests[0].url) == "https://api.meta.ai/v1/responses"
        assert rec.payload() == {
            "model": "sam-3.1",
            "input": [
                {
                    "type": "message",
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": "red mug"},
                        {"type": "input_image", "image_url": DATA_URL},
                    ],
                }
            ],
            "metadata": {"include_confidence": "true"},
        }

    def test_image_edit_payload_without_size(self):
        rec = Recorder(ok())
        client, _ = make_client(rec)
        client.image_edit(image_data_url=DATA_URL, prompt="add a toothbrush")
        assert str(rec.requests[0].url) == "https://api.meta.ai/v1/images/edits"
        assert rec.payload() == {
            "model": "muse-image-1.0",
            "prompt": "add a toothbrush",
            "images": [{"image_url": DATA_URL}],
            "n": 1,
            "output_format": "webp",
        }

    def test_image_edit_payload_with_size(self):
        rec = Recorder(ok())
        client, _ = make_client(rec)
        client.image_edit(image_data_url=DATA_URL, prompt="p", size="512x512")
        assert rec.payload()["size"] == "512x512"

    def test_bearer_header_and_json_content_type(self):
        rec = Recorder(ok())
        client, _ = make_client(rec)
        client.post("/chat/completions", {"x": 1})
        headers = rec.requests[0].headers
        assert headers["authorization"] == "Bearer " + KEY
        assert headers["content-type"].startswith("application/json")
        assert rec.payload() == {"x": 1}

    def test_custom_base_url(self):
        rec = Recorder(ok())
        client, _ = make_client(rec, base_url="https://example.test/v9")
        client.post("/responses", {})
        assert str(rec.requests[0].url) == "https://example.test/v9/responses"


class TestRetry:
    # Covers: MEM-006

    @pytest.mark.parametrize("status", [429, 500, 503])
    def test_retryable_status_then_success(self, status):
        rec = Recorder(err(status), ok({"a": 1}))
        client, sleeps = make_client(rec, rand_value=0.4)
        result = client.post("/x", {})
        assert result.ok is True
        assert result.status == 200
        assert result.attempts == 2
        assert result.error is None
        assert json.loads(result.body) == {"a": 1}
        assert sleeps == [pytest.approx(0.5 + 0.2)]

    def test_exponential_backoff_with_jitter_and_max_three_attempts(self):
        rec = Recorder(err(500), err(500), err(500), ok())
        client, sleeps = make_client(rec, rand_value=1.0)
        result = client.post("/x", {})
        assert result.ok is False
        assert result.status == 500
        assert result.attempts == 3
        assert len(rec.requests) == 3
        assert sleeps == [pytest.approx(0.5 + 0.5), pytest.approx(1.0 + 0.5)]
        assert result.error == "500 server_error"

    @pytest.mark.parametrize("status", [429, 503])
    def test_retry_after_seconds_honoured(self, status):
        rec = Recorder(err(status, headers={"Retry-After": "3"}), ok())
        client, sleeps = make_client(rec, rand_value=0.4)
        assert client.post("/x", {}).ok is True
        assert sleeps == [pytest.approx(3 + 0.2)]

    def test_retry_after_capped_at_60(self):
        rec = Recorder(err(429, headers={"Retry-After": "120"}), ok())
        client, sleeps = make_client(rec, rand_value=0.0)
        client.post("/x", {})
        assert sleeps == [pytest.approx(60.0)]

    def test_unparseable_retry_after_falls_back_to_backoff(self):
        rec = Recorder(err(429, headers={"Retry-After": "soon"}), ok())
        client, sleeps = make_client(rec, rand_value=0.0)
        client.post("/x", {})
        assert sleeps == [pytest.approx(0.5)]

    @pytest.mark.parametrize("status", [400, 401, 413, 504])
    def test_non_retryable_status_returns_immediately(self, status):
        rec = Recorder(err(status, code="bad"), ok())
        client, sleeps = make_client(rec)
        result = client.post("/x", {})
        assert result.ok is False
        assert result.status == status
        assert result.attempts == 1
        assert len(rec.requests) == 1
        assert sleeps == []
        assert result.error == f"{status} bad"

    def test_error_without_code_uses_http_error(self):
        rec = Recorder(httpx.Response(400, content=b"not json"))
        client, _ = make_client(rec)
        assert client.post("/x", {}).error == "400 http_error"

    def test_error_with_null_code_uses_http_error(self):
        rec = Recorder(err(400, code=None))
        client, _ = make_client(rec)
        assert client.post("/x", {}).error == "400 http_error"

    def test_transport_error_retried_then_success(self):
        rec = Recorder(httpx.ConnectError("down"), ok())
        client, sleeps = make_client(rec)
        result = client.post("/x", {})
        assert result.ok is True
        assert result.attempts == 2
        assert len(sleeps) == 1

    @pytest.mark.parametrize(
        "exc_type", [httpx.ConnectError, httpx.ConnectTimeout], ids=["ConnectError", "ConnectTimeout"]
    )
    def test_transport_error_exhausted(self, exc_type):
        rec = Recorder(exc_type("failed"))
        client, sleeps = make_client(rec)
        result = client.post("/x", {})
        assert result.ok is False
        assert result.status is None
        assert result.attempts == 3
        assert len(sleeps) == 2
        assert result.error == f"transport: {exc_type.__name__}"

    @pytest.mark.parametrize(
        "exc",
        [httpx.ReadTimeout("slow"), httpx.RemoteProtocolError("cut"), httpx.WriteTimeout("stuck")],
        ids=["ReadTimeout", "RemoteProtocolError", "WriteTimeout"],
    )
    def test_post_connect_transport_error_not_retried(self, exc):
        # The request may already have reached the server: retrying could double-bill a paid call.
        rec = Recorder(exc, ok())
        client, sleeps = make_client(rec)
        result = client.post("/x", {})
        assert result.ok is False
        assert result.status is None
        assert result.attempts == 1
        assert len(rec.requests) == 1
        assert sleeps == []
        assert result.error == f"transport: {type(exc).__name__}"

    def test_connect_timeout_retried_then_success(self):
        rec = Recorder(httpx.ConnectTimeout("slow dns"), ok())
        client, sleeps = make_client(rec)
        result = client.post("/x", {})
        assert result.ok is True
        assert result.attempts == 2
        assert len(sleeps) == 1

    @pytest.mark.parametrize(
        "code",
        [
            "has space",
            "x" * 65,
            "<script>alert(1)</script>",
            "line\nbreak",
            "path/like",
            "",
        ],
        ids=["space", "65_chars", "markup", "newline", "slash", "empty"],
    )
    def test_error_code_outside_safe_charset_or_length_uses_http_error(self, code):
        rec = Recorder(err(400, code=code))
        client, _ = make_client(rec)
        assert client.post("/x", {}).error == "400 http_error"

    @pytest.mark.parametrize("code", ["invalid_api_key", "rate.limit-exceeded_2", "x" * 64, "A"])
    def test_error_code_in_safe_charset_up_to_64_chars_surfaced(self, code):
        rec = Recorder(err(400, code=code))
        client, _ = make_client(rec)
        assert client.post("/x", {}).error == f"400 {code}"

    def test_non_string_error_code_uses_http_error(self):
        rec = Recorder(err(400, code=123))  # type: ignore[arg-type]
        client, _ = make_client(rec)
        assert client.post("/x", {}).error == "400 http_error"

    def test_max_retries_zero_means_single_attempt(self):
        rec = Recorder(err(500), ok())
        client, sleeps = make_client(rec, max_retries=0)
        result = client.post("/x", {})
        assert result.attempts == 1
        assert sleeps == []


# Covers: MEM-006, MEM-027
# Requirement: an image edit is sent exactly once: no retry and no backoff sleep on 429/500/503 or a
# connect failure, so a scene never holds a render slot through retries.
class TestImageEditNoRetry:
    @pytest.mark.parametrize(
        "reply",
        [
            err(429, headers={"Retry-After": "3"}),
            err(500),
            err(503, headers={"Retry-After": "3"}),
            httpx.ConnectError("down"),
            httpx.ConnectTimeout("slow dns"),
        ],
        ids=["429", "500", "503", "ConnectError", "ConnectTimeout"],
    )
    def test_image_edit_makes_exactly_one_attempt(self, reply):
        rec = Recorder(reply, ok())
        client, sleeps = make_client(rec)
        result = client.image_edit(image_data_url=DATA_URL, prompt="p")
        assert result.ok is False
        assert result.attempts == 1
        assert len(rec.requests) == 1
        assert sleeps == []


class TestResponseSizeCap:
    # Covers: MEM-006

    def test_cap_constant_is_a_sane_size(self):
        cap = meta_client.MAX_RESPONSE_BYTES
        assert isinstance(cap, int)
        assert 8 * 1024 * 1024 <= cap <= 64 * 1024 * 1024

    def test_body_at_cap_is_accepted(self):
        cap = meta_client.MAX_RESPONSE_BYTES
        rec = Recorder(httpx.Response(200, content=b"a" * cap))
        client, _ = make_client(rec)
        result = client.post("/x", {})
        assert result.ok is True
        assert len(result.body) == cap

    @pytest.mark.parametrize("status", [200, 500])
    def test_body_over_cap_is_non_retryable_error_without_content(self, status):
        cap = meta_client.MAX_RESPONSE_BYTES
        marker = b"SECRET-ECHO-"
        rec = Recorder(httpx.Response(status, content=marker + b"a" * cap), ok())
        client, sleeps = make_client(rec)
        result = client.post("/x", {})
        assert result.ok is False
        assert result.status == status
        assert result.attempts == 1
        assert len(rec.requests) == 1
        assert sleeps == []
        assert result.body == b""
        assert result.error == f"{status} response_too_large"


class TestCallResultAndSecrecy:
    # Covers: MEM-006

    def test_call_result_fields_and_frozen(self):
        rec = Recorder(ok({"z": 2}))
        client, _ = make_client(rec)
        result = client.post("/x", {})
        assert isinstance(result, CallResult)
        assert isinstance(result.body, bytes)
        assert isinstance(result.latency_s, float)
        assert result.latency_s >= 0.0
        with pytest.raises(dataclasses.FrozenInstanceError):
            result.ok = False  # type: ignore[misc]

    def test_error_never_contains_key_when_server_echoes_it(self):
        error = {"message": "invalid key " + KEY, "type": "auth", "param": None, "code": "invalid_api_key"}
        body = {"error": error}
        rec = Recorder(httpx.Response(401, json=body))
        client, _ = make_client(rec)
        result = client.post("/x", {})
        assert result.error == "401 invalid_api_key"
        assert KEY not in result.error

    def test_transport_error_message_with_key_not_leaked(self):
        rec = Recorder(httpx.ConnectError("boom " + KEY))
        client, _ = make_client(rec)
        result = client.post("/x", {})
        assert KEY not in result.error

    def test_repr_and_str_hide_key(self):
        client, _ = make_client(Recorder(ok()))
        assert repr(client) == "MetaClient()"
        assert str(client) == "MetaClient()"

    def test_empty_key_raises_missing_api_key(self):
        with pytest.raises(MissingApiKey):
            MetaClient("", transport=httpx.MockTransport(Recorder(ok())))


class TestHelpers:
    # Covers: MEM-006

    def test_chat_content_json(self):
        content = json.dumps({"phrases": ["a", "b"]})
        body = json.dumps({"choices": [{"message": {"content": content}}]}).encode()
        assert chat_content_json(body) == {"phrases": ["a", "b"]}

    def test_responses_text_prefers_output_text(self):
        body = json.dumps({"output_text": "top", "output": [{"content": [{"text": "nested"}]}]}).encode()
        assert responses_text(body) == "top"

    def test_responses_text_joins_nested_output_in_order(self):
        body = json.dumps(
            {
                "output": [
                    {"content": [{"type": "output_text", "text": "<|box;A|>"}]},
                    {"content": [{"text": "<|box;B|>"}]},
                ]
            }
        ).encode()
        text = responses_text(body)
        assert "<|box;A|>" in text and "<|box;B|>" in text
        assert text.index("<|box;A|>") < text.index("<|box;B|>")

    def test_responses_text_single_nested_part(self):
        body = json.dumps({"output": [{"content": [{"type": "output_text", "text": "only"}]}]}).encode()
        assert responses_text(body) == "only"

    @pytest.mark.parametrize("payload", [{}, {"output": []}, {"output": [{"content": []}]}])
    def test_responses_text_empty(self, payload):
        assert responses_text(json.dumps(payload).encode()) == ""

    def test_image_bytes_decodes_b64_json(self):
        raw = b"RIFF\x00\x00WEBPdata"
        body = json.dumps({"data": [{"b64_json": base64.b64encode(raw).decode()}]}).encode()
        assert image_bytes(body) == raw

    def test_to_data_url(self):
        raw = b"\xff\xd8\xff\xe0abc"
        assert to_data_url(raw) == "data:image/jpeg;base64," + base64.b64encode(raw).decode()

    def test_to_data_url_empty(self):
        assert to_data_url(b"") == "data:image/jpeg;base64,"
