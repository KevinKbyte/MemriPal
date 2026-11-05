# Covers: MEM-140
# Requirement: the browser asks the server for a Spark-picked landmark emoji via
# POST /landmark-emoji (router from routes_landmark_emoji.make_landmark_emoji_router(ask,
# passcode_error), exercised on a standalone FastAPI app, and mounted by memripal.app.create_app
# like routes_station). The body is JSON {name: str 1..120, category?: str <= 60, tags?: object
# of <= 20 str -> str}; anything else (malformed JSON, non-object, wrong types, over-long, too
# many tags) is 400 JSON {"error": <code>} with no model call. `ask(prompt: str) -> str` is the
# chat-provider seam (None = no provider): the prompt names the landmark and asks for one
# best-fit emoji. A reply that, whitespace-stripped, is exactly one emoji (FE0F / ZWJ sequences
# ok) -> 200 {"emoji": reply}; no provider, a provider failure or any other reply -> 200
# {"emoji": null}, never a 500. The passcode check runs before the body is read or the provider
# is called.
import os

import pytest
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from memripal.app import create_app

VS16 = "\N{VARIATION SELECTOR-16}"
ZWJ = "\N{ZERO WIDTH JOINER}"
MUSEUM = "\U0001f3db" + VS16
COOK = "\U0001f468" + ZWJ + "\U0001f373"
LOOPBACK_URL = "http://127.0.0.1"


class FakeAsk:
    """Chat-provider seam: records each prompt; returns `reply` or raises it if it is an exception."""

    def __init__(self, reply=MUSEUM):
        self.reply = reply
        self.prompts: list[str] = []

    def __call__(self, prompt: str) -> str:
        self.prompts.append(prompt)
        if isinstance(self.reply, Exception):
            raise self.reply
        return self.reply


def _open(request):
    return None


def _client(ask, passcode_error=_open) -> TestClient:
    from memripal.routes_landmark_emoji import make_landmark_emoji_router

    app = FastAPI()
    app.include_router(make_landmark_emoji_router(ask, passcode_error))
    return TestClient(app, raise_server_exceptions=False)


def _post(client, body):
    return client.post("/landmark-emoji", json=body)


# Covers: MEM-140
class TestLandmarkEmojiReply:
    def test_single_emoji_reply_returns_200_with_it_and_prompt_names_landmark(self):
        ask = FakeAsk(MUSEUM)
        body = {"name": "MIT Museum", "category": "museum", "tags": {"tourism": "museum_hall"}}
        resp = _post(_client(ask), body)
        assert resp.status_code == 200, resp.text
        assert resp.json() == {"emoji": MUSEUM}
        assert len(ask.prompts) == 1
        prompt = ask.prompts[0]
        assert isinstance(prompt, str)
        assert "MIT Museum" in prompt
        assert "museum_hall" in prompt
        assert "emoji" in prompt.lower()

    @pytest.mark.parametrize("reply", [f"  {MUSEUM}\n", "\U0001f3db", COOK], ids=["padded", "bare", "zwj"])
    def test_one_emoji_variants_accepted(self, reply):
        resp = _post(_client(FakeAsk(reply)), {"name": "MIT Museum"})
        assert resp.status_code == 200, resp.text
        assert resp.json() == {"emoji": reply.strip()}

    @pytest.mark.parametrize(
        "reply",
        ["museum", MUSEUM * 2, "", "   ", f"Here: {MUSEUM}", "7", None, 42],
        ids=["text", "two", "empty", "blank", "prefixed", "digit", "none", "int"],
    )
    def test_bad_reply_returns_null(self, reply):
        resp = _post(_client(FakeAsk(reply)), {"name": "MIT Museum"})
        assert resp.status_code == 200, resp.text
        assert resp.json() == {"emoji": None}

    def test_provider_failure_returns_null_not_500(self):
        resp = _post(_client(FakeAsk(RuntimeError("upstream down"))), {"name": "MIT Museum"})
        assert resp.status_code == 200, resp.text
        assert resp.json() == {"emoji": None}

    def test_no_provider_returns_null(self):
        resp = _post(_client(None), {"name": "MIT Museum"})
        assert resp.status_code == 200, resp.text
        assert resp.json() == {"emoji": None}


# Covers: MEM-140
class TestLandmarkEmojiValidation:
    def test_boundaries_accepted(self):
        ask = FakeAsk()
        tags = {f"k{i}": "v" for i in range(20)}
        resp = _post(_client(ask), {"name": "n" * 120, "category": "c" * 60, "tags": tags})
        assert resp.status_code == 200, resp.text

    @pytest.mark.parametrize(
        "body",
        [
            {},
            {"name": ""},
            {"name": "n" * 121},
            {"name": 42},
            {"name": "ok", "category": "c" * 61},
            {"name": "ok", "category": 7},
            {"name": "ok", "tags": {f"k{i}": "v" for i in range(21)}},
            {"name": "ok", "tags": {"amenity": 5}},
            {"name": "ok", "tags": ["cafe"]},
            ["MIT Museum"],
            "MIT Museum",
        ],
        ids=[
            "no-name",
            "empty-name",
            "long-name",
            "int-name",
            "long-category",
            "int-category",
            "too-many-tags",
            "int-tag-value",
            "list-tags",
            "list-body",
            "string-body",
        ],
    )
    def test_invalid_body_is_400_json_without_model_call(self, body):
        ask = FakeAsk()
        resp = _post(_client(ask), body)
        assert resp.status_code == 400, resp.text
        assert isinstance(resp.json().get("error"), str)
        assert ask.prompts == []

    def test_malformed_json_is_400(self):
        ask = FakeAsk()
        resp = _client(ask).post(
            "/landmark-emoji", content=b"{not json", headers={"Content-Type": "application/json"}
        )
        assert resp.status_code == 400, resp.text
        assert isinstance(resp.json().get("error"), str)
        assert ask.prompts == []

    def test_passcode_error_short_circuits_before_provider(self):
        ask = FakeAsk()

        def refuse(request):
            return JSONResponse({"error": "passcode_required"}, status_code=401)

        resp = _post(_client(ask, refuse), {"name": "MIT Museum"})
        assert resp.status_code == 401
        assert resp.json() == {"error": "passcode_required"}
        assert ask.prompts == []


@pytest.fixture
def _clean_env(monkeypatch, tmp_path):
    for name in list(os.environ):
        if name.startswith("MEMRIPAL_"):
            monkeypatch.delenv(name)
    for name in ("META_API_KEY", "BASETEN_API_KEY", "FIREWORKS_API_KEY", "K_SERVICE"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("USERPROFILE", str(tmp_path / "home"))


# Covers: MEM-140
@pytest.mark.usefixtures("_clean_env")
class TestLandmarkEmojiMountedOnApp:
    def _client(self):
        from test_station_api import FakeBackend

        app = create_app(backend=FakeBackend())
        return TestClient(app, base_url=LOOPBACK_URL, raise_server_exceptions=False)

    def test_route_is_mounted_and_offline_returns_null(self):
        resp = _post(self._client(), {"name": "MIT Museum"})
        assert resp.status_code == 200, resp.text
        assert resp.json() == {"emoji": None}

    def test_mounted_route_validates_body(self):
        resp = _post(self._client(), {"name": ""})
        assert resp.status_code == 400, resp.text
        assert isinstance(resp.json().get("error"), str)
