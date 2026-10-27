"""Contract (MEM-025, ADR 0022): POST /associate accepts an optional confirmed place.

- Body: exactly {image, item, locus} as today, or {image, item, locus, place} where place is exactly
  {"title": non-blank str of <= 255 chars, "extract": str of <= 400 chars} (a typed place may have an
  empty extract). A title over 255 or an extract over 400 chars -> 400 {"error": "place_too_long"}; any
  other bad place (non-object, missing or unknown key such as coords, non-string, blank title) -> 400.
  No model call on any rejection.
- With place: `gen_params[PROMPT_ARGS]` carries it, so it is part of the cache key, and a place template
  ("use only PLACE FACTS") is appended after today's prompt, like ASSOCIATION_RETRY.
- Without place: prompt args, prompt text and cache key are byte-identical to before MEM-025, so every
  recorded association fixture still replays.
"""

import base64
import importlib
import io
import json

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from memripal.app import create_app
from memripal.backend import PROMPT_ARGS, MetaBackend
from memripal.imaging import Processed
from memripal.meta_client import MetaClient

ITEM = "milk carton"
LOCUS = "left book"
LOOPBACK_URL = "http://127.0.0.1"
FAKE_KEY = "fake-test-key-0123456789abcdefXYZ"
EXTRACT = "Big Ben is the nickname for the Great Bell of the Great Clock of Westminster."
PLACE = {"title": "Big Ben", "extract": EXTRACT}
# associate(backend, PROCESSED, ITEM, LOCUS)'s first request key on main f09638a, before MEM-025.
PRE_PLACE_DIGEST = "b52e8c3e127d4def46b67c149344352bd8eb57b5526ad54e196a8317c00f9c0c"
FIXED_IMAGE = b"\xff\xd8\xff\xe0fake-processed-jpeg-bytes\xff\xd9"
PROCESSED = Processed(jpeg=FIXED_IMAGE, width=1000, height=800, sha="0" * 64)


def _jpeg(w=64, h=48) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (120, 80, 40)).save(buf, "JPEG")
    return buf.getvalue()


JPEG = _jpeg()


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


class RecordingBackend:
    """Answers every Spark call with a valid record; keeps each ModelRequest."""

    mode = "fake"

    def __init__(self):
        self.requests = []

    def call(self, req):
        self.requests.append(req)
        args = req.gen_params[PROMPT_ARGS]
        return good_record(item=args["item"], locus=args["locus"])


class _ChatApi:
    """httpx.MockTransport handler standing in for Meta chat completions (no network)."""

    def __init__(self):
        self.payloads = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.payloads.append(json.loads(request.content))
        content = json.dumps(good_record())
        return httpx.Response(200, json={"choices": [{"message": {"content": content}}]})

    def prompts(self):
        return [p["messages"][0]["content"][0]["text"] for p in self.payloads]


def _live(api):
    client = MetaClient(FAKE_KEY, transport=httpx.MockTransport(api), sleep=lambda s: None, rand=lambda: 0.0)
    return MetaBackend(FAKE_KEY, client=client)


def _body(**over) -> dict:
    body = {
        "image": "data:image/jpeg;base64," + base64.b64encode(JPEG).decode("ascii"),
        "item": ITEM,
        "locus": LOCUS,
    }
    body.update(over)
    return body


def _post(backend, body):
    client = TestClient(create_app(backend=backend), base_url=LOOPBACK_URL)
    content = json.dumps(body) if isinstance(body, dict) else body
    return client.post("/associate", content=content, headers={"Content-Type": "application/json"})


@pytest.fixture
def assoc():
    return importlib.import_module("memripal.associate")


# Covers: MEM-025
# Requirement: a confirmed place reaches the association prompt: its extract and title are in the prompt
# Meta sees, after today's prompt and under a "use only PLACE FACTS" instruction, and the place is part of
# the cache key, so a different place never replays a cached association.
class TestAssociateWithPlace:
    def test_prompt_carries_the_place_extract_after_todays_prompt(self, assoc):
        api = _ChatApi()
        resp = _post(_live(api), _body(place=PLACE))
        assert resp.status_code == 200, resp.text
        [prompt] = api.prompts()
        assert prompt.startswith(assoc.ASSOCIATION_PROMPT.format(item=ITEM, locus=LOCUS))
        assert EXTRACT in prompt
        assert "Big Ben" in prompt
        assert "PLACE FACTS" in prompt

    def test_place_rides_in_prompt_args(self):
        backend = RecordingBackend()
        assert _post(backend, _body(place=PLACE)).status_code == 200
        [req] = backend.requests
        args = req.gen_params[PROMPT_ARGS]
        assert args["item"] == ITEM and args["locus"] == LOCUS
        assert EXTRACT in json.dumps(args)

    def test_place_changes_the_cache_key(self):
        backend = RecordingBackend()
        _post(backend, _body())
        _post(backend, _body(place=PLACE))
        _post(backend, _body(place={"title": "Big Ben", "extract": "A different fact about the bell."}))
        plain, with_place, other_place = (r.cache_key().digest() for r in backend.requests)
        assert with_place != plain
        assert other_place != with_place

    def test_same_place_gives_the_same_key(self):
        backend = RecordingBackend()
        _post(backend, _body(place=PLACE))
        _post(backend, _body(place=dict(PLACE)))
        a, b = backend.requests
        assert a.cache_key().digest() == b.cache_key().digest()

    def test_typed_place_with_empty_extract_is_accepted(self):
        api = _ChatApi()
        resp = _post(_live(api), _body(place={"title": "Grandma's kitchen", "extract": ""}))
        assert resp.status_code == 200, resp.text
        [prompt] = api.prompts()
        assert "Grandma's kitchen" in prompt

    def test_extract_of_exactly_400_chars_is_accepted(self):
        backend = RecordingBackend()
        resp = _post(backend, _body(place={"title": "Big Ben", "extract": "x" * 400}))
        assert resp.status_code == 200, resp.text
        assert len(backend.requests) == 1

    def test_title_of_exactly_255_chars_is_accepted(self):
        backend = RecordingBackend()
        resp = _post(backend, _body(place={"title": "t" * 255, "extract": EXTRACT}))
        assert resp.status_code == 200, resp.text
        assert len(backend.requests) == 1


# Covers: MEM-025
# Requirement: without a place, /associate is unchanged: prompt args are exactly {item, locus}, the prompt
# Meta sees is today's text, and the request key is byte-identical to before MEM-025, so recorded fixtures
# keep replaying.
class TestAssociateWithoutPlaceUnchanged:
    def test_prompt_args_are_exactly_item_and_locus(self):
        backend = RecordingBackend()
        assert _post(backend, _body()).status_code == 200
        [req] = backend.requests
        assert req.gen_params[PROMPT_ARGS] == {"item": ITEM, "locus": LOCUS}

    def test_prompt_text_is_todays(self, assoc):
        api = _ChatApi()
        assert _post(_live(api), _body()).status_code == 200
        [prompt] = api.prompts()
        assert prompt == assoc.ASSOCIATION_PROMPT.format(item=ITEM, locus=LOCUS)
        assert "PLACE FACTS" not in prompt

    def test_request_key_is_byte_identical_to_before(self, assoc):
        backend = RecordingBackend()
        assoc.associate(backend, PROCESSED, ITEM, LOCUS)
        assert backend.requests[0].cache_key().digest() == PRE_PLACE_DIGEST


# Covers: MEM-025
# Requirement: the place is validated at the boundary before any model call: a title over 255 chars or an
# extract over 400 chars is 400 place_too_long, and a malformed place (wrong type, missing or extra key
# such as raw coords, non-string or blank title) is 400, so coords can never ride /associate to Meta.
class TestAssociatePlaceRejections:
    def test_extract_over_400_chars_is_400_place_too_long(self):
        backend = RecordingBackend()
        resp = _post(backend, _body(place={"title": "Big Ben", "extract": "x" * 401}))
        assert resp.status_code == 400, resp.text
        assert resp.json() == {"error": "place_too_long"}
        assert backend.requests == []

    def test_title_over_255_chars_is_400_place_too_long(self):
        backend = RecordingBackend()
        resp = _post(backend, _body(place={"title": "t" * 256, "extract": EXTRACT}))
        assert resp.status_code == 400, resp.text
        assert resp.json() == {"error": "place_too_long"}
        assert backend.requests == []

    @pytest.mark.parametrize(
        "place",
        [
            "Big Ben",
            ["Big Ben", EXTRACT],
            {"title": "Big Ben"},
            {"extract": EXTRACT},
            {**PLACE, "lat": 51.5007, "lon": -0.1246},
            {"title": 5, "extract": EXTRACT},
            {"title": "Big Ben", "extract": None},
            {"title": "   ", "extract": EXTRACT},
        ],
        ids=[
            "string",
            "list",
            "missing-extract",
            "missing-title",
            "coords",
            "title-int",
            "extract-null",
            "title-blank",
        ],
    )
    def test_bad_place_is_400_without_model_call(self, place):
        backend = RecordingBackend()
        resp = _post(backend, _body(place=place))
        assert resp.status_code == 400, resp.text
        assert set(resp.json()) == {"error"}
        assert backend.requests == []
