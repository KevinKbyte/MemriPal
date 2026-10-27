"""Contract (MEM-021): POST /associate, mirroring the POST /loci idiom (MEM-015).

- Request: Content-Type application/json (else 415 {"error": "unsupported_media_type"}); body capped before
  and while reading (Content-Length or a streamed body past the cap -> 413 {"error": "too_large"}); body =
  exactly {"image": "data:image/jpeg;base64,<processed JPEG from POST /loci>", "item": str, "locus": str}.
- Caps re-checked: item 1..100 chars after strip (101 -> 400 {"error": "item_too_long"}); locus non-empty
  and short; malformed JSON, a non-object, a missing/unknown key or a non-string value -> 400 {"error":
  <code>}. The image is checked with `validate_processed` (never re-encoded, so replay keys hold);
  ImageRejected -> its status + code. No model call on any rejection.
- 200: exactly {"item", "locus", "status" ("valid" | "invalid"), "attempts", "record"}; an "invalid" result
  is still 200 (UI offers edit/regenerate) and never echoes an unknown reply field.
- FixtureMissing -> 404 {"error": "fixture_missing"}; BackendCallFailed -> 502 {"error": "upstream"}; other
  exceptions -> 500 {"error": "internal"}; error bodies carry no model or exception text. Host guard
  applies.
"""

import base64
import importlib
import io
import json

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from memripal.app import create_app
from memripal.backend import PROMPT_ARGS, BackendCallFailed, FixtureBackend, FixtureMissing, ResponseCache
from memripal.imaging import validate_processed

ITEM = "milk carton"
LOCUS = "left book"
LOOPBACK_URL = "http://127.0.0.1"
LEAK_MARKER = "MODEL-SAID-SECRET-TEXT"
MB = 1024 * 1024
RESPONSE_KEYS = {"item", "locus", "status", "attempts", "record"}


def _jpeg(w=64, h=48, fmt="JPEG") -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (120, 80, 40)).save(buf, fmt)
    return buf.getvalue()


JPEG = _jpeg()


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


def echo_record(req):
    args = req.gen_params[PROMPT_ARGS]
    return good_record(item=args["item"], locus=args["locus"])


class FakeBackend:
    """Answers every Spark call with `answer` (dict, callable(req) or exception); counts calls."""

    mode = "fake"

    def __init__(self, answer=echo_record):
        self.answer = answer
        self.calls = 0

    def call(self, req):
        self.calls += 1
        if isinstance(self.answer, Exception):
            raise self.answer
        return self.answer(req) if callable(self.answer) else json.loads(json.dumps(self.answer))


class _Recorder:
    mode = "fake"

    def __init__(self, inner, root):
        self.inner = inner
        self.cache = ResponseCache(root)

    def call(self, req):
        value = self.inner.call(req)
        self.cache.put(req.cache_key(), json.dumps(value).encode("utf-8"))
        return value


def _client(backend, base_url: str = LOOPBACK_URL) -> TestClient:
    return TestClient(create_app(backend=backend), base_url=base_url)


def _body(**over) -> dict:
    body = {"image": _data_url(), "item": ITEM, "locus": LOCUS}
    body.update(over)
    return body


def _post(client, body, content_type="application/json"):
    content = json.dumps(body) if isinstance(body, dict) else body
    return client.post("/associate", content=content, headers={"Content-Type": content_type})


def _assert_error(resp, status, code=None):
    assert resp.status_code == status, resp.text
    payload = resp.json()
    assert set(payload) == {"error"}
    assert isinstance(payload["error"], str) and payload["error"]
    if code is not None:
        assert payload["error"] == code


# Covers: MEM-021
# Requirement: POST /associate returns {item, locus, status, attempts, record} for one item/locus pair on
# the client-returned processed photo; a fixture replay hits the same key, so the photo is never re-encoded.
class TestAssociateSuccess:
    def test_exact_response_shape(self):
        backend = FakeBackend()
        resp = _post(_client(backend), _body())
        assert resp.status_code == 200, resp.text
        assert resp.headers["content-type"].startswith("application/json")
        payload = resp.json()
        assert set(payload) == RESPONSE_KEYS
        assert (payload["item"], payload["locus"], payload["status"]) == (ITEM, LOCUS, "valid")
        assert payload["attempts"] == 1
        assert payload["record"] == good_record()
        assert backend.calls == 1

    def test_fixture_replay_of_recorded_pair(self, tmp_path):
        assoc = importlib.import_module("memripal.associate")

        assoc.associate(_Recorder(FakeBackend(), tmp_path), validate_processed(JPEG), ITEM, LOCUS)
        resp = _post(_client(FixtureBackend(tmp_path)), _body())
        assert resp.status_code == 200, resp.text
        assert resp.json()["record"] == good_record()

    def test_item_of_exactly_100_chars_is_accepted(self):
        item = "x" * 100
        resp = _post(_client(FakeBackend()), _body(item=item))
        assert resp.status_code == 200, resp.text
        assert resp.json()["item"] == item


# Covers: MEM-021
# Requirement: three invalid replies still answer 200 with status "invalid" after 3 model calls (the UI
# offers edit/regenerate), and a hostile unknown reply field never reaches the client.
class TestAssociateInvalid:
    def test_three_bad_replies_give_invalid(self):
        backend = FakeBackend(good_record(olfactory=""))
        resp = _post(_client(backend), _body())
        assert resp.status_code == 200, resp.text
        payload = resp.json()
        assert set(payload) == RESPONSE_KEYS
        assert (payload["status"], payload["attempts"]) == ("invalid", 3)
        assert backend.calls == 3

    def test_hostile_unknown_field_is_not_echoed(self):
        backend = FakeBackend(good_record(onload=LEAK_MARKER))
        resp = _post(_client(backend), _body())
        assert resp.status_code == 200, resp.text
        assert resp.json()["status"] == "invalid"
        assert LEAK_MARKER not in resp.text
        assert "onload" not in resp.text


# Covers: MEM-021
# Requirement: request input is validated at the boundary before any model call: JSON content type,
# body-size cap, exact {image, item, locus} string shape, item <= 100 chars, non-empty short locus, and a
# processed JPEG image (validate_processed codes); every rejection is {"error": code} only.
class TestAssociateRejections:
    def test_wrong_content_type_is_415(self):
        backend = FakeBackend()
        resp = _post(_client(backend), json.dumps(_body()), content_type="text/plain")
        _assert_error(resp, 415, "unsupported_media_type")
        assert backend.calls == 0

    def test_item_over_100_chars_is_400_item_too_long(self):
        backend = FakeBackend()
        _assert_error(_post(_client(backend), _body(item="x" * 101)), 400, "item_too_long")
        assert backend.calls == 0

    @pytest.mark.parametrize(
        "body",
        [
            "{not json",
            "[]",
            '"just a string"',
            json.dumps({"item": ITEM, "locus": LOCUS}),
            json.dumps({"image": _data_url(), "item": ITEM}),
            json.dumps(_body(extra="x")),
            json.dumps(_body(item=5)),
            json.dumps(_body(item=None)),
            json.dumps(_body(locus=["left book"])),
            json.dumps(_body(item="")),
            json.dumps(_body(item="    ")),
            json.dumps(_body(locus="")),
            json.dumps(_body(locus="x" * 1000)),
        ],
        ids=[
            "malformed",
            "array",
            "string",
            "missing-image",
            "missing-locus",
            "unknown-key",
            "item-int",
            "item-null",
            "locus-list",
            "item-empty",
            "item-blank",
            "locus-empty",
            "locus-1000",
        ],
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
            "data:image/jpeg;base64,",
            _data_url(_jpeg(fmt="PNG")),
            _data_url(_jpeg(w=3000, h=100)),
        ],
        ids=["no-prefix", "html", "bad-base64", "empty", "png-bytes", "side-over-2048"],
    )
    def test_bad_image_is_400_without_model_call(self, image):
        backend = FakeBackend()
        _assert_error(_post(_client(backend), _body(image=image)), 400)
        assert backend.calls == 0

    def test_png_bytes_map_to_validate_processed_code(self):
        _assert_error(
            _post(_client(FakeBackend()), _body(image=_data_url(_jpeg(fmt="PNG")))), 400, "not_jpeg"
        )

    def test_oversized_content_length_is_413(self):
        backend = FakeBackend()
        resp = _post(_client(backend), b"{" + b" " * (24 * MB))
        _assert_error(resp, 413, "too_large")
        assert backend.calls == 0

    def test_streamed_body_past_cap_is_413(self):
        def chunks():
            yield b'{"image": "data:image/jpeg;base64,'
            for _ in range(24):
                yield b"A" * MB

        backend = FakeBackend()
        _assert_error(_post(_client(backend), chunks()), 413, "too_large")
        assert backend.calls == 0


# Covers: MEM-021
# Requirement: failures answer a fixed code and no model/exception text: missing fixture 404, upstream
# failure 502, anything else 500; the loopback Host guard covers /associate too.
class TestAssociateFailures:
    def test_fixture_missing_is_404(self):
        _assert_error(
            _post(_client(FakeBackend(FixtureMissing(LEAK_MARKER))), _body()), 404, "fixture_missing"
        )

    def test_upstream_failure_is_502_without_model_text(self):
        resp = _post(_client(FakeBackend(BackendCallFailed(LEAK_MARKER))), _body())
        _assert_error(resp, 502, "upstream")
        assert LEAK_MARKER not in resp.text

    def test_unexpected_exception_is_500_without_text(self):
        resp = _post(_client(FakeBackend(RuntimeError(LEAK_MARKER))), _body())
        _assert_error(resp, 500, "internal")
        assert LEAK_MARKER not in resp.text

    def test_foreign_host_is_refused(self):
        backend = FakeBackend()
        resp = _post(_client(backend, base_url="http://evil.example"), _body())
        assert resp.status_code == 400
        assert backend.calls == 0
