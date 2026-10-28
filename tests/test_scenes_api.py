"""Contract (MEM-028): POST /scenes, mirroring the POST /associate idiom (MEM-021).

- Request: Content-Type application/json (else 415 {"error": "unsupported_media_type"}); body capped before
  and while reading (-> 413 {"error": "too_large"}); body = exactly {"image": "data:image/jpeg;base64,
  <processed JPEG from POST /loci>", "box": {"x1","y1","x2","y2"} (POST /loci shape), "record": <POST
  /associate record>}.
- Rejections, each before any model call: malformed JSON / non-object / missing or unknown key -> 400; image
  not a JPEG data URL or not a processed photo -> 400 (validate_processed codes, never re-encoded); box not
  exactly four ints (bools refused) with 0 <= x1 < x2 <= width and 0 <= y1 < y2 <= height -> 400 {"error":
  "bad_box"}; record failing `validate_association` against its own item/locus (incl. an unknown field) -> 400
  {"error": "bad_record"}. Error bodies carry no model or input text.
- 200 tier 1: exactly {"tier": 1, "image": "data:image/(png|jpeg|webp);base64,...", "width", "height"} at the
  input photo's dims. 200 tier 3: exactly {"tier": 3, "reason": <short code>} on any model failure, including
  a fixture miss (never 404/502/500). Host guard applies.
"""

import base64
import io
import json
import logging
import re
import socket

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from memripal.app import create_app
from memripal.backend import BackendCallFailed, FixtureBackend, FixtureMissing, ResponseCache

ITEM = "milk carton"
LOCUS = "left book"
LOOPBACK_URL = "http://127.0.0.1"
LEAK_MARKER = "MODEL-SAID-SECRET-TEXT"
MB = 1024 * 1024
W, H = 64, 48
BOX = {"x1": 8, "y1": 6, "x2": 40, "y2": 30}
DATA_URL = re.compile(r"data:image/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)")


def _img(w=W, h=H, fmt="JPEG") -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (120, 80, 40)).save(buf, fmt)
    return buf.getvalue()


JPEG = _img()
WEBP_SMALL = _img(32, 24, "WEBP")


def _data_url(data: bytes = JPEG, prefix: str = "data:image/jpeg;base64,") -> str:
    return prefix + base64.b64encode(data).decode("ascii")


def good_record(item=ITEM, locus=LOCUS, **over):
    rec = {
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
    rec.update(over)
    return rec


class FakeBackend:
    """Answers every image_edit call with `answer` (bytes or exception); counts calls."""

    mode = "fake"

    def __init__(self, answer=WEBP_SMALL):
        self.answer = answer
        self.calls = 0

    def call(self, req):
        self.calls += 1
        if isinstance(self.answer, BaseException):
            raise self.answer
        return self.answer


class _Recorder:
    """Stores each raw image reply under the request's own cache key, as a live write-through would."""

    mode = "fake"

    def __init__(self, inner, root):
        self.inner = inner
        self.cache = ResponseCache(root)

    def call(self, req):
        value = self.inner.call(req)
        self.cache.put(req.cache_key(), value)
        return value


def _client(backend, base_url: str = LOOPBACK_URL) -> TestClient:
    return TestClient(create_app(backend=backend), base_url=base_url)


def _body(**over) -> dict:
    body = {"image": _data_url(), "box": dict(BOX), "record": good_record()}
    body.update(over)
    return body


def _post(client, body, content_type="application/json"):
    content = json.dumps(body) if isinstance(body, dict) else body
    return client.post("/scenes", content=content, headers={"Content-Type": content_type})


def _assert_error(resp, status, code=None):
    assert resp.status_code == status, resp.text
    payload = resp.json()
    assert set(payload) == {"error"}
    if code is not None:
        assert payload["error"] == code


def _assert_tier1(resp):
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert set(payload) == {"tier", "image", "width", "height"}
    assert payload["tier"] == 1
    assert (payload["width"], payload["height"]) == (W, H)
    match = DATA_URL.fullmatch(payload["image"])
    assert match, payload["image"][:40]
    with Image.open(io.BytesIO(base64.b64decode(match.group(2)))) as img:
        assert img.size == (W, H)


def _assert_tier3(resp):
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert set(payload) == {"tier", "reason"}
    assert payload["tier"] == 3
    assert re.fullmatch(r"[a-z_]{1,40}", payload["reason"])
    assert LEAK_MARKER not in resp.text


# Covers: MEM-028
# Requirement: POST /scenes turns one processed photo + locus box + validated association record into a
# tier-1 scene image (a data URL at the photo's dims) or a tier-3 fallback signal the client draws as a
# canvas overlay.
class TestScenesSuccess:
    def test_tier1_shape(self):
        backend = FakeBackend()
        _assert_tier1(_post(_client(backend), _body()))
        assert backend.calls == 1

    def test_full_image_box_is_accepted(self):
        _assert_tier1(_post(_client(FakeBackend()), _body(box={"x1": 0, "y1": 0, "x2": W, "y2": H})))

    @pytest.mark.parametrize(
        "exc",
        [
            FixtureMissing(LEAK_MARKER),
            BackendCallFailed("image_edit call failed: transport: ReadTimeout " + LEAK_MARKER),
            BackendCallFailed("image_edit call failed: 400 content_policy_violation " + LEAK_MARKER),
            RuntimeError(LEAK_MARKER),
        ],
        ids=["fixture-miss", "timeout", "content-policy", "unexpected"],
    )
    def test_model_failure_is_200_tier3_after_one_call(self, exc):
        backend = FakeBackend(exc)
        _assert_tier3(_post(_client(backend), _body()))
        assert backend.calls == 1

    def test_hostile_non_image_reply_is_tier3(self):
        _assert_tier3(_post(_client(FakeBackend(b"<html>" + LEAK_MARKER.encode())), _body()))

    def test_forced_timeout_across_10_loci_gives_10_tier3_and_no_tracebacks(self, caplog):
        backend = FakeBackend(BackendCallFailed("image_edit call failed: transport: ReadTimeout"))
        client = _client(backend)
        caplog.set_level(logging.DEBUG)
        for i in range(10):
            record = good_record(item=f"item {i}", kinesthetic=f"You grip item {i}.")
            _assert_tier3(_post(client, _body(record=record)))
        assert backend.calls == 10
        assert not [r for r in caplog.records if r.exc_info]


def _no_network(*args, **kwargs):
    raise AssertionError("network access attempted in fixture mode")


# Covers: MEM-028
# Requirement: fixture mode replays a recorded scene offline (no network) and a scene never recorded for
# that record falls back to tier 3 instead of an error.
class TestScenesFixtureReplay:
    def test_recorded_scene_replays_offline_and_unrecorded_is_tier3(self, tmp_path, monkeypatch):
        recorded = _post(_client(_Recorder(FakeBackend(), tmp_path)), _body())
        _assert_tier1(recorded)
        monkeypatch.setattr(socket, "getaddrinfo", _no_network)
        monkeypatch.setattr(socket, "create_connection", _no_network)
        client = _client(FixtureBackend(tmp_path))
        _assert_tier1(_post(client, _body()))
        other = good_record(item="red apple", kinesthetic="You grip a freezing red apple.")
        _assert_tier3(_post(client, _body(record=other)))


# Covers: MEM-028
# Requirement: input is validated at the boundary before any model call (content type, body cap, exact
# {image, box, record} shape, processed JPEG, in-bounds integer box, record passing the association
# validator); every rejection is {"error": code} only and echoes no input text.
class TestScenesRejections:
    def test_wrong_content_type_is_415(self):
        backend = FakeBackend()
        resp = _post(_client(backend), json.dumps(_body()), "text/plain")
        _assert_error(resp, 415, "unsupported_media_type")
        assert backend.calls == 0

    @pytest.mark.parametrize(
        "body",
        [
            "{not json",
            "[]",
            json.dumps({"image": _data_url(), "box": BOX}),
            json.dumps({"box": BOX, "record": good_record()}),
            json.dumps(_body(extra="x")),
        ],
        ids=["malformed", "array", "missing-record", "missing-image", "unknown-key"],
    )
    def test_bad_body_is_400_without_model_call(self, body):
        backend = FakeBackend()
        _assert_error(_post(_client(backend), body), 400)
        assert backend.calls == 0

    @pytest.mark.parametrize(
        "image",
        [
            "not a data url",
            "data:text/html;base64," + base64.b64encode(b"<script>").decode("ascii"),
            "data:image/jpeg;base64,!!!not-base64!!!",
            _data_url(_img(fmt="PNG")),
            _data_url(_img(w=3000, h=100)),
        ],
        ids=["no-prefix", "html", "bad-base64", "png-bytes", "side-over-2048"],
    )
    def test_bad_image_is_400_without_model_call(self, image):
        backend = FakeBackend()
        _assert_error(_post(_client(backend), _body(image=image)), 400)
        assert backend.calls == 0

    @pytest.mark.parametrize(
        "box",
        [
            {"x1": 8, "y1": 6, "x2": 40},
            {**BOX, "z": 1},
            {**BOX, "x1": 8.5},
            {**BOX, "x1": True},
            {**BOX, "x1": "8"},
            {**BOX, "x1": -1},
            {**BOX, "x2": 8},
            {**BOX, "y2": 3},
            {**BOX, "x2": W + 1},
            {**BOX, "y2": H + 1},
            [8, 6, 40, 30],
            None,
        ],
        ids=[
            "missing",
            "extra",
            "float",
            "bool",
            "str",
            "negative",
            "zero-width",
            "inverted-y",
            "past-width",
            "past-height",
            "list",
            "null",
        ],
    )
    def test_bad_box_is_400_bad_box_without_model_call(self, box):
        backend = FakeBackend()
        _assert_error(_post(_client(backend), _body(box=box)), 400, "bad_box")
        assert backend.calls == 0

    @pytest.mark.parametrize(
        "record",
        [
            good_record(olfactory=""),
            good_record(onload=LEAK_MARKER),
            good_record(kinesthetic="You grip it.", visual="It glows."),
            good_record(item="x" * 101, kinesthetic="x" * 101),
            {k: v for k, v in good_record().items() if k != "visual"},
            good_record(visual=5),
            "a record",
        ],
        ids=[
            "empty-channel",
            "unknown-field",
            "item-not-named",
            "item-101",
            "missing-field",
            "non-string",
            "not-object",
        ],
    )
    def test_bad_record_is_400_without_model_call(self, record):
        backend = FakeBackend()
        resp = _post(_client(backend), _body(record=record))
        _assert_error(resp, 400, "bad_record")
        assert LEAK_MARKER not in resp.text
        assert backend.calls == 0

    def test_oversized_content_length_is_413(self):
        backend = FakeBackend()
        _assert_error(_post(_client(backend), b"{" + b" " * (24 * MB)), 413, "too_large")
        assert backend.calls == 0

    def test_streamed_body_past_cap_is_413(self):
        def chunks():
            yield b'{"image": "data:image/jpeg;base64,'
            for _ in range(24):
                yield b"A" * MB

        backend = FakeBackend()
        _assert_error(_post(_client(backend), chunks()), 413, "too_large")
        assert backend.calls == 0

    def test_foreign_host_is_refused(self):
        backend = FakeBackend()
        resp = _post(_client(backend, base_url="http://evil.example"), _body())
        assert resp.status_code == 400
        assert backend.calls == 0
