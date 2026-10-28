"""Contract (MEM-027): scenes through the live MetaBackend (httpx.MockTransport, no network).

- `MetaBackend.call(ModelRequest(method="image_edit", ...))` sends one POST /images/edits whose `prompt` is
  `scenes.scene_prompt(record)` and whose image is the whole processed photo as a JPEG data URL, with a 30 s
  per-request timeout (overriding the client default); the reply's `data[0].b64_json` is the edited image.
- Timeout (httpx.ReadTimeout, sent so never retried) and content-policy 400 -> tier 3 after exactly 1 request.
- Hostile replies (body over meta_client.MAX_RESPONSE_BYTES, non-JSON, JSON without data, b64 of non-image)
  -> tier 3 after exactly 1 request.
- With `cache_root`, a tier-1 reply is written through, and FixtureBackend on that root replays the same
  scene offline (D3 record-then-replay).
"""

import base64
import importlib
import io
import json
import threading
from concurrent.futures import ThreadPoolExecutor

import httpx
import pytest
from PIL import Image

from memripal import meta_client
from memripal.backend import FixtureBackend, MetaBackend
from memripal.imaging import validate_processed
from memripal.meta_client import MetaClient, to_data_url

ITEM = "milk carton"
LOCUS = "left book"
FAKE_KEY = "fake-test-key-0123456789abcdefXYZ"
LEAK_MARKER = "MODEL-SAID-SECRET-TEXT"
W, H = 64, 48
BOX = {"x1": 8, "y1": 6, "x2": 40, "y2": 30}


def _img(w=W, h=H, fmt="JPEG") -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (120, 80, 40)).save(buf, fmt)
    return buf.getvalue()


PROCESSED = validate_processed(_img())


def good_record(item=ITEM, locus=LOCUS):
    return {
        "item": item,
        "locus": locus,
        "kinesthetic": f"You grip a freezing {item} with both hands.",
        "auditory": "It glugs and sloshes like a drum.",
        "visual": "A towering white carton glows.",
        "emotional": "You feel giddy and a little scared.",
        "conceptual": "Calcium builds strong bones.",
        "olfactory": "Sour cream smell fills the air.",
        "gustatory": "Cold and sweet on your tongue.",
        "spatial": f"It balances on top of the {locus}.",
        "scene_prompt_details": "giant carton, dramatic light",
        "walk_cue": "Look up at the shelf.",
        "reencode_hint": "Picture the drum sound.",
        "question": "Why does cold storage keep it fresh longer?",
        "answer": "Low temperature slows bacterial growth.",
    }


def scenes():
    return importlib.import_module("memripal.scenes")


def _edit_reply(image: bytes) -> httpx.Response:
    return httpx.Response(200, json={"data": [{"b64_json": base64.b64encode(image).decode("ascii")}]})


class _ImageApi:
    """MockTransport handler standing in for Meta /images/edits; `reply` is a Response or an exception."""

    def __init__(self, reply):
        self.reply = reply
        self.requests = []
        self._lock = threading.Lock()

    def __call__(self, request: httpx.Request) -> httpx.Response:
        with self._lock:
            self.requests.append(request)
        if isinstance(self.reply, BaseException):
            raise self.reply
        return self.reply

    def payloads(self):
        return [json.loads(r.content) for r in self.requests]


def _live(api, cache_root=None):
    client = MetaClient(FAKE_KEY, transport=httpx.MockTransport(api), sleep=lambda s: None, rand=lambda: 0.0)
    return MetaBackend(FAKE_KEY, client=client, cache_root=cache_root)


def _render(backend, record=None):
    return scenes().render_scene(backend, PROCESSED, BOX, record or good_record())


def _assert_tier3(scene):
    assert scene.tier == 3
    assert scene.image is None
    assert LEAK_MARKER not in (scene.reason or "")


# Covers: MEM-027
# Requirement: a live tier-1 scene is one POST /images/edits carrying the server-built template prompt and
# the whole processed photo, bounded by a 30 s timeout, with the output resized to the input dims.
class TestLiveTierOne:
    def test_single_edit_request_with_server_prompt_and_whole_photo(self):
        api = _ImageApi(_edit_reply(_img(32, 24, "WEBP")))
        scene = _render(_live(api))
        assert scene.tier == 1, scene.reason
        assert len(api.requests) == 1
        assert api.requests[0].url.path.endswith("/images/edits")
        payload = api.payloads()[0]
        assert payload["prompt"] == scenes().scene_prompt(good_record())
        assert payload["images"][0]["image_url"] == to_data_url(PROCESSED.jpeg)
        with Image.open(io.BytesIO(scene.image)) as img:
            assert img.size == (PROCESSED.width, PROCESSED.height)

    def test_edit_request_carries_a_30_second_timeout(self):
        api = _ImageApi(_edit_reply(_img(32, 24, "WEBP")))
        _render(_live(api))
        assert api.requests[0].extensions["timeout"]["read"] == 30


# Covers: MEM-027
# Requirement: a timed-out or content-policy-refused edit falls back to tier 3 without a retry (exactly one
# request), and 10 forced timeouts across 10 loci give 10 tier-3 scenes with nothing raised.
class TestLiveFallback:
    def test_read_timeout_is_tier3_after_one_request(self):
        api = _ImageApi(httpx.ReadTimeout("timed out"))
        _assert_tier3(_render(_live(api)))
        assert len(api.requests) == 1

    def test_content_policy_400_is_tier3_without_retry(self):
        body = {"error": {"code": "content_policy_violation", "message": LEAK_MARKER}}
        api = _ImageApi(httpx.Response(400, json=body))
        _assert_tier3(_render(_live(api)))
        assert len(api.requests) == 1

    def test_forced_timeout_across_10_loci(self):
        api = _ImageApi(httpx.ReadTimeout("timed out"))
        backend = _live(api)
        records = [good_record(item=f"item {i}") for i in range(10)]
        with ThreadPoolExecutor(max_workers=10) as pool:
            results = list(pool.map(lambda r: _render(backend, r), records))
        assert [s.tier for s in results] == [3] * 10
        assert len(api.requests) == 10


# Covers: MEM-027
# Requirement: hostile live replies (oversize body, non-JSON, missing data, non-image bytes) fall back to
# tier 3 after one request, and no reply text reaches the scene.
class TestLiveHostileReply:
    def test_body_over_the_response_cap_is_tier3(self, monkeypatch):
        monkeypatch.setattr(meta_client, "MAX_RESPONSE_BYTES", 1024)
        api = _ImageApi(_edit_reply(_img(256, 256, "PNG") + b"\0" * 4096))
        _assert_tier3(_render(_live(api)))
        assert len(api.requests) == 1

    @pytest.mark.parametrize(
        "reply",
        [
            httpx.Response(200, content=b"<html>" + LEAK_MARKER.encode() + b"</html>"),
            httpx.Response(200, json={"data": []}),
            httpx.Response(200, json={"error": LEAK_MARKER}),
            _edit_reply(b"<script>" + LEAK_MARKER.encode() + b"</script>"),
            httpx.Response(200, json={"data": [{"b64_json": "!!!not-base64!!!"}]}),
        ],
        ids=["non-json", "empty-data", "no-data", "b64-of-html", "bad-base64"],
    )
    def test_malformed_reply_is_tier3(self, reply):
        api = _ImageApi(reply)
        _assert_tier3(_render(_live(api)))
        assert len(api.requests) == 1


# Covers: MEM-027
# Requirement: a live tier-1 scene is written through to the live cache and replays offline from it via
# FixtureBackend (record-then-replay), with the same output dims.
class TestLiveRecordThenReplay:
    def test_write_through_then_fixture_replay(self, tmp_path):
        api = _ImageApi(_edit_reply(_img(32, 24, "WEBP")))
        assert _render(_live(api, cache_root=tmp_path)).tier == 1
        replayed = _render(FixtureBackend(tmp_path))
        assert replayed.tier == 1, replayed.reason
        assert len(api.requests) == 1
        with Image.open(io.BytesIO(replayed.image)) as img:
            assert img.size == (PROCESSED.width, PROCESSED.height)
