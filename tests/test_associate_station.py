# Covers: MEM-087
"""Contract (MEM-087, ADR 0048 "Station context in the prompt" (a) + Decision): POST /associate for a
Memorize placement carries a station block and never shows the sentinel photo to the model.

- Body: {image, item, locus, station} where station is exactly {"name", "profile", "taps"} (the route
  station's name, its profile map and its quick-tap map). Any other station key -> 400, no model call.
- With station: `gen_params[PROMPT_ARGS]["station"]` equals the block as sent (outside the templates
  digest, like ASSOCIATION_PLACE; it still keys the cache via prompt args), and
  `gen_params[SEND_IMAGE]` is False: the photo-less demo station's sentinel JPEG (the client sends
  fixtures/demo/photo.jpg bytes, static/assets/demo_photo.json) never reaches the model. On the live
  backend the chat payload has no image part and the station name, profile and taps reach the prompt.
- Without station: no "station" prompt arg and no SEND_IMAGE key, so the photo is still sent and
  pre-MEM-087 request keys stay byte-identical.
"""

import base64
import json
from pathlib import Path

import httpx
from fastapi.testclient import TestClient

from memripal.app import create_app
from memripal.backend import PROMPT_ARGS, SEND_IMAGE, MetaBackend
from memripal.meta_client import MetaClient

REPO_ROOT = Path(__file__).resolve().parents[1]
SENTINEL_JPEG = (REPO_ROOT / "fixtures" / "demo" / "photo.jpg").read_bytes()
LOOPBACK_URL = "http://127.0.0.1"
FAKE_KEY = "fake-test-key-0123456789abcdefXYZ"
ITEM = "Retrieval practice"
LOCUS = "Kendall fountain"
STATION = {
    "name": LOCUS,
    "profile": {"visual": "granite basin", "spatial": "left of the T exit", "conceptual": "water cycle"},
    "taps": {"sound": "splashing", "smell": "wet stone", "feel": "cool spray", "mood": "calm"},
}


def good_record(item=ITEM, locus=LOCUS):
    return {
        "item": item,
        "locus": locus,
        "kinesthetic": f"You grip {item} cards with both hands.",
        "auditory": "Water splashes like applause.",
        "visual": f"The {locus} glows under the lights.",
        "emotional": "You feel sharp and ready.",
        "conceptual": "Recalling strengthens memory.",
        "olfactory": "Wet stone smell fills the air.",
        "gustatory": "",
        "spatial": "The cards float on the basin.",
        "scene_prompt_details": "fountain, flash cards, evening light",
        "walk_cue": "Look at the basin.",
        "reencode_hint": "Hear the splash as applause.",
        "question": "Why does testing yourself beat rereading?",
        "answer": "Effortful recall strengthens retrieval paths.",
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


def _live(api, tmp_path):
    client = MetaClient(FAKE_KEY, transport=httpx.MockTransport(api), sleep=lambda s: None, rand=lambda: 0.0)
    return MetaBackend(FAKE_KEY, cache_root=tmp_path, client=client)


def _body(**over) -> dict:
    body = {
        "image": "data:image/jpeg;base64," + base64.b64encode(SENTINEL_JPEG).decode("ascii"),
        "item": ITEM,
        "locus": LOCUS,
    }
    body.update(over)
    return body


def _post(backend, body):
    client = TestClient(create_app(backend=backend), base_url=LOOPBACK_URL)
    return client.post("/associate", content=json.dumps(body), headers={"Content-Type": "application/json"})


def _content_parts(payload: dict) -> list:
    return [part for message in payload["messages"] for part in message["content"]]


# Requirement: a Memorize placement sends its route station as a {name, profile, taps} block; the
# block rides in the prompt args exactly as sent and the request is marked SEND_IMAGE False, so the
# photo-less station's sentinel JPEG is never shown to the model.
class TestStationBlockRequest:
    def test_station_block_rides_in_prompt_args_exactly(self):
        backend = RecordingBackend()
        resp = _post(backend, _body(station=STATION))
        assert resp.status_code == 200, resp.text[:300]
        assert resp.json()["status"] == "valid"
        [req] = backend.requests
        assert req.gen_params[PROMPT_ARGS]["station"] == STATION

    def test_station_request_is_marked_send_image_false(self):
        backend = RecordingBackend()
        resp = _post(backend, _body(station=STATION))
        assert resp.status_code == 200, resp.text[:300]
        [req] = backend.requests
        assert req.gen_params.get(SEND_IMAGE) is False

    def test_station_with_an_unknown_key_is_refused_before_any_model_call(self):
        backend = RecordingBackend()
        resp = _post(backend, _body(station={**STATION, "photo": "data:image/jpeg;base64,AAAA"}))
        assert resp.status_code == 400, resp.text[:300]
        assert backend.requests == []

    def test_without_station_no_station_arg_and_no_send_image_key(self):
        backend = RecordingBackend()
        resp = _post(backend, _body())
        assert resp.status_code == 200, resp.text[:300]
        [req] = backend.requests
        assert "station" not in req.gen_params[PROMPT_ARGS]
        assert SEND_IMAGE not in req.gen_params


# Requirement: on the live backend a station placement sends no image part at all, and the station's
# name, profile and taps reach the prompt the model reads; a placement without a station still sends
# the photo.
class TestStationBlockLivePayload:
    def test_live_payload_has_no_image_and_carries_the_station(self, tmp_path):
        api = _ChatApi()
        resp = _post(_live(api, tmp_path), _body(station=STATION))
        assert resp.status_code == 200, resp.text[:300]
        [payload] = api.payloads
        parts = _content_parts(payload)
        assert [p for p in parts if p.get("type") == "image_url"] == []
        prompt = " ".join(p["text"] for p in parts if p.get("type") == "text")
        for text in [STATION["name"], *STATION["profile"].values(), *STATION["taps"].values()]:
            assert text in prompt, text

    def test_live_payload_without_station_still_sends_the_photo(self, tmp_path):
        api = _ChatApi()
        resp = _post(_live(api, tmp_path), _body())
        assert resp.status_code == 200, resp.text[:300]
        [payload] = api.payloads
        images = [p for p in _content_parts(payload) if p.get("type") == "image_url"]
        assert len(images) == 1
        assert images[0]["image_url"]["url"].startswith("data:image/jpeg;base64,")
