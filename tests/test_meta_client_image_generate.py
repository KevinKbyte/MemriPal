# Covers: MEM-043
# Requirement (G1): MetaClient.image_generate(*, prompt, model="muse-image-1.0", output_format="webp",
# timeout=None) is Muse Image text-to-image: one POST to <base>/images/generations whose JSON payload
# has exactly the keys {model, prompt, n, output_format} with n == 1 (no seed, no size: unknown fields
# are a 400), returned as a CallResult whose body image_bytes() unpacks; it is paid, so it is never
# retried (0 retries, no backoff sleep) on 429/500/503 or a connect failure.
import base64
import json

import httpx
import pytest

from memripal.meta_client import CallResult, MetaClient, image_bytes

# Built by concatenation so this file never matches the pre-commit secret scanner (MEM-004).
KEY = "fake" + "-gen-" + "q" * 24
WEBP = b"RIFF\x00\x00\x00\x00WEBPVP8 roomdata"


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


def _ok_image() -> httpx.Response:
    return httpx.Response(200, json={"data": [{"b64_json": base64.b64encode(WEBP).decode()}]})


def _err(status: int, headers: dict | None = None) -> httpx.Response:
    body = {"error": {"message": "nope", "type": "t", "param": None, "code": "server_error"}}
    return httpx.Response(status, json=body, headers=headers or {})


def _client(rec: Recorder, **kw):
    sleeps: list[float] = []
    client = MetaClient(KEY, transport=httpx.MockTransport(rec), sleep=sleeps.append, rand=lambda: 0.0, **kw)
    return client, sleeps


# Covers: MEM-043
class TestImageGeneratePayload:
    def test_posts_once_to_images_generations_with_exactly_four_keys(self):
        rec = Recorder(_ok_image())
        client, _ = _client(rec)
        result = client.image_generate(prompt="a cluttered dim kitchen")
        assert len(rec.requests) == 1
        assert rec.requests[0].method == "POST"
        assert str(rec.requests[0].url) == "https://api.meta.ai/v1/images/generations"
        assert rec.payload() == {
            "model": "muse-image-1.0",
            "prompt": "a cluttered dim kitchen",
            "n": 1,
            "output_format": "webp",
        }
        assert rec.requests[0].headers["authorization"] == "Bearer " + KEY
        assert isinstance(result, CallResult)
        assert result.ok is True
        assert image_bytes(result.body) == WEBP

    def test_never_sends_size_or_seed(self):
        rec = Recorder(_ok_image())
        client, _ = _client(rec)
        client.image_generate(prompt="p")
        assert set(rec.payload()) == {"model", "prompt", "n", "output_format"}
        assert "size" not in rec.payload()
        assert "seed" not in rec.payload()

    def test_model_and_output_format_are_overridable(self):
        rec = Recorder(_ok_image())
        client, _ = _client(rec)
        client.image_generate(prompt="p", model="muse-image-2.0", output_format="png")
        assert rec.payload() == {"model": "muse-image-2.0", "prompt": "p", "n": 1, "output_format": "png"}

    def test_custom_base_url(self):
        rec = Recorder(_ok_image())
        client, _ = _client(rec, base_url="https://example.test/v9")
        client.image_generate(prompt="p")
        assert str(rec.requests[0].url) == "https://example.test/v9/images/generations"


# Covers: MEM-043
class TestImageGenerateNoRetry:
    @pytest.mark.parametrize(
        "reply",
        [
            _err(429, headers={"Retry-After": "3"}),
            _err(500),
            _err(503, headers={"Retry-After": "3"}),
            httpx.ConnectError("down"),
            httpx.ConnectTimeout("slow dns"),
        ],
        ids=["429", "500", "503", "ConnectError", "ConnectTimeout"],
    )
    def test_makes_exactly_one_attempt_even_when_client_allows_retries(self, reply):
        rec = Recorder(reply, _ok_image())
        client, sleeps = _client(rec, max_retries=2)
        result = client.image_generate(prompt="p")
        assert result.ok is False
        assert result.attempts == 1
        assert len(rec.requests) == 1
        assert sleeps == []

    def test_5xx_error_is_returned_not_raised_and_key_never_leaks(self):
        rec = Recorder(_err(500), _ok_image())
        client, _ = _client(rec)
        result = client.image_generate(prompt="p")
        assert result.error == "500 server_error"
        assert KEY not in (result.error or "")
