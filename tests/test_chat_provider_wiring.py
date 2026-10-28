import json
import logging
from pathlib import Path
from unittest import mock

import httpx
import pytest

from memripal.backend import (
    BackendCallFailed,
    FixtureBackend,
    MissingApiKey,
    ModelRequest,
    ResponseCache,
    select_backend,
)

# Built by concatenation so this file never matches the pre-commit secret scanner (MEM-004).
META_KEY = "fake" + "-meta-" + "k" * 24
BASETEN_KEY = "fake" + "-baseten-" + "b" * 24
FIREWORKS_KEY = "fake" + "-fireworks-" + "f" * 24
LOCAL_URL = "http://127.0.0.1:8081/v1"
LOCAL_MODEL = "muse-spark-open-local-test"
IMAGE = b"\xff\xd8\xff\xe0fake-processed-jpeg-bytes\xff\xd9"
PHRASES_SCHEMA = {
    "type": "object",
    "properties": {"phrases": {"type": "array", "items": {"type": "string"}}},
    "required": ["phrases"],
    "additionalProperties": False,
}
META_CHAT_URL = "https://api.meta.ai/v1/chat/completions"
META_SAM_TEXT = "<|box;x1=1;y1=2;x2=3;y2=4;w=640;h=480;c=0.5|>"

# provider -> (chat URL, model id in the payload, key env var, fake key); verified live 2026-10-27.
KEYED = {
    "baseten": (
        "https://inference.baseten.co/v1/chat/completions",
        "meta-models/muse-spark-open-1026",
        "BASETEN_API_KEY",
        BASETEN_KEY,
    ),
    "fireworks": (
        "https://api.fireworks.ai/inference/v1/chat/completions",
        "accounts/fireworks/models/muse-spark-open",
        "FIREWORKS_API_KEY",
        FIREWORKS_KEY,
    ),
}
ALL_KEYS = (META_KEY, BASETEN_KEY, FIREWORKS_KEY)


class _Net:
    """Stands in for every real network transport (no network): records each request."""

    def __init__(self):
        self.requests: list[httpx.Request] = []
        # Replaceable per test: return a Response or raise an httpx transport error.
        self.chat_answer = lambda: httpx.Response(
            200, json={"choices": [{"message": {"content": json.dumps({"phrases": ["book"]})}}]}
        )

    def __call__(self, request: httpx.Request) -> httpx.Response:
        request.read()
        self.requests.append(request)
        if request.url.path.endswith("/chat/completions"):
            return self.chat_answer()
        if request.url.path.endswith("/responses"):
            return httpx.Response(200, json={"output_text": META_SAM_TEXT})
        return httpx.Response(404, json={"error": {"code": "not_found"}})

    def chats(self) -> list[httpx.Request]:
        return [r for r in self.requests if r.url.path.endswith("/chat/completions")]

    def segments(self) -> list[httpx.Request]:
        return [r for r in self.requests if r.url.path.endswith("/responses")]


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch, tmp_path):
    for name in (
        "MEMRIPAL_MODE",
        "META_API_KEY",
        "MEMRIPAL_CHAT_PROVIDER",
        "BASETEN_API_KEY",
        "FIREWORKS_API_KEY",
        "MEMRIPAL_LOCAL_CHAT_URL",
        "MEMRIPAL_LOCAL_CHAT_MODEL",
        "MEMRIPAL_SEG_PROVIDER",
        "MEMRIPAL_MODAL_SEG_URL",
        "MODAL_SEG_TOKEN",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("USERPROFILE", str(tmp_path / "home"))


@pytest.fixture
def net():
    fake = _Net()
    # Every httpx.Client built without an explicit transport routes here, whoever builds it.
    with mock.patch.object(
        httpx.HTTPTransport,
        "handle_request",
        autospec=True,
        side_effect=lambda _self, request: fake(request),
    ):
        yield fake


def _spark_request() -> ModelRequest:
    return ModelRequest(
        method="spark_json",
        image_jpeg=IMAGE,
        subject="phrases",
        attempt=0,
        model="muse-spark-1.3",
        prompt_template_id="phrase",
        gen_params={"max_completion_tokens": 1024},
        schema=PHRASES_SCHEMA,
    )


def _segment_request() -> ModelRequest:
    return ModelRequest(
        method="segment",
        image_jpeg=IMAGE,
        subject="book",
        attempt=0,
        model="sam-3.1",
        prompt_template_id="sam-phrase",
        gen_params={},
        schema=None,
    )


def _provider_env(monkeypatch, provider: str) -> None:
    monkeypatch.setenv("META_API_KEY", META_KEY)
    monkeypatch.setenv("MEMRIPAL_CHAT_PROVIDER", provider)
    if provider in KEYED:
        _, _, key_env, key = KEYED[provider]
        monkeypatch.setenv(key_env, key)
    if provider == "local":
        monkeypatch.setenv("MEMRIPAL_LOCAL_CHAT_URL", LOCAL_URL)
        monkeypatch.setenv("MEMRIPAL_LOCAL_CHAT_MODEL", LOCAL_MODEL)


def _meta_payload(monkeypatch, tmp_path, net) -> dict:
    """The payload the default (meta) provider sends for _spark_request()."""
    monkeypatch.setenv("META_API_KEY", META_KEY)
    select_backend("meta", tmp_path / "meta-ref").call(_spark_request())
    payload = json.loads(net.chats()[-1].content)
    net.requests.clear()
    return payload


def _headers_text(request: httpx.Request) -> str:
    return " ".join(request.headers.values())


def _files_under(path: Path) -> list[Path]:
    return sorted(p for p in path.rglob("*") if p.is_file()) if path.exists() else []


# Covers: MEM-026
# Requirement: with MEMRIPAL_CHAT_PROVIDER unset or "meta", Spark chat stays exactly as before:
# one POST to https://api.meta.ai/v1/chat/completions with model muse-spark-1.3 and the Meta
# bearer key.
class TestDefaultChatProviderUnchanged:
    @pytest.mark.parametrize("provider", [None, "meta"], ids=["unset", "meta"])
    def test_chat_goes_to_meta_with_spark_model(self, monkeypatch, tmp_path, net, provider):
        monkeypatch.setenv("META_API_KEY", META_KEY)
        if provider is not None:
            monkeypatch.setenv("MEMRIPAL_CHAT_PROVIDER", provider)

        assert select_backend("meta", tmp_path).call(_spark_request()) == {"phrases": ["book"]}

        (chat,) = net.chats()
        assert str(chat.url) == META_CHAT_URL
        assert chat.headers["Authorization"] == "Bearer " + META_KEY
        assert json.loads(chat.content)["model"] == "muse-spark-1.3"


# Covers: MEM-026
# Requirement: with MEMRIPAL_CHAT_PROVIDER=baseten or fireworks, Spark chat goes to that
# provider's OpenAI-compatible /chat/completions with its own bearer key (BASETEN_API_KEY,
# FIREWORKS_API_KEY) and its own model id, never muse-spark-1.3 and never the Meta key; the
# payload is otherwise identical to the Meta one (max_completion_tokens, strict json_schema
# response_format, messages). "local" posts to MEMRIPAL_LOCAL_CHAT_URL (default
# http://localhost:11434/v1, Ollama) + /chat/completions with model MEMRIPAL_LOCAL_CHAT_MODEL and
# no Authorization header. SAM segmentation stays on Meta under every chat provider.
class TestChatProviderRouting:
    @pytest.mark.parametrize("provider", sorted(KEYED))
    def test_keyed_provider_gets_chat_with_its_key_and_model(self, monkeypatch, tmp_path, net, provider):
        meta_payload = _meta_payload(monkeypatch, tmp_path, net)
        url, model, _, key = KEYED[provider]
        _provider_env(monkeypatch, provider)

        assert select_backend("meta", tmp_path).call(_spark_request()) == {"phrases": ["book"]}

        (chat,) = net.chats()
        assert str(chat.url) == url
        assert chat.headers["Authorization"] == "Bearer " + key
        assert META_KEY not in _headers_text(chat)
        assert json.loads(chat.content) == {**meta_payload, "model": model}

    def test_local_provider_gets_chat_without_auth(self, monkeypatch, tmp_path, net):
        meta_payload = _meta_payload(monkeypatch, tmp_path, net)
        _provider_env(monkeypatch, "local")

        assert select_backend("meta", tmp_path).call(_spark_request()) == {"phrases": ["book"]}

        (chat,) = net.chats()
        assert str(chat.url) == LOCAL_URL + "/chat/completions"
        assert "Authorization" not in chat.headers
        assert META_KEY not in _headers_text(chat)
        assert json.loads(chat.content) == {**meta_payload, "model": LOCAL_MODEL}

    def test_local_url_trailing_slash_does_not_double(self, monkeypatch, tmp_path, net):
        _provider_env(monkeypatch, "local")
        monkeypatch.setenv("MEMRIPAL_LOCAL_CHAT_URL", LOCAL_URL + "/")

        select_backend("meta", tmp_path).call(_spark_request())

        (chat,) = net.chats()
        assert str(chat.url) == LOCAL_URL + "/chat/completions"

    def test_local_url_defaults_to_ollama_on_localhost(self, monkeypatch, tmp_path, net):
        _provider_env(monkeypatch, "local")
        monkeypatch.delenv("MEMRIPAL_LOCAL_CHAT_URL")

        select_backend("meta", tmp_path).call(_spark_request())

        (chat,) = net.chats()
        assert str(chat.url) == "http://localhost:11434/v1/chat/completions"

    @pytest.mark.parametrize("provider", ["baseten", "fireworks", "local"])
    def test_segmentation_stays_on_meta(self, monkeypatch, tmp_path, net, provider):
        _provider_env(monkeypatch, provider)

        assert select_backend("meta", tmp_path).call(_segment_request()) == META_SAM_TEXT

        (seg,) = net.segments()
        assert str(seg.url) == "https://api.meta.ai/v1/responses"
        assert seg.headers["Authorization"] == "Bearer " + META_KEY
        assert len(net.requests) == 1


# Covers: MEM-026
# Requirement: the chat provider is validated when the live backend starts: an unknown
# MEMRIPAL_CHAT_PROVIDER fails meta-mode startup with a ValueError naming the allowed set;
# baseten/fireworks without (or with an empty) BASETEN_API_KEY/FIREWORKS_API_KEY fail with
# MissingApiKey naming that env var; "local" needs no key but needs MEMRIPAL_LOCAL_CHAT_MODEL
# (ValueError naming it); META_API_KEY stays required because SAM stays on Meta. No startup
# error ever contains any key.
class TestChatProviderStartup:
    @pytest.mark.parametrize("provider", ["openai", "", "META", "Baseten"])
    def test_unknown_provider_fails_meta_startup(self, monkeypatch, tmp_path, provider):
        monkeypatch.setenv("META_API_KEY", META_KEY)
        monkeypatch.setenv("MEMRIPAL_CHAT_PROVIDER", provider)
        with pytest.raises(ValueError) as excinfo:
            select_backend("meta", tmp_path)
        message = str(excinfo.value)
        for name in ("meta", "baseten", "fireworks", "local"):
            assert name in message
        assert META_KEY not in message

    @pytest.mark.parametrize("provider", sorted(KEYED))
    @pytest.mark.parametrize("value", [None, ""], ids=["unset", "empty"])
    def test_keyed_provider_without_key_raises_missing_api_key(self, monkeypatch, tmp_path, provider, value):
        _provider_env(monkeypatch, provider)
        key_env = KEYED[provider][2]
        if value is None:
            monkeypatch.delenv(key_env)
        else:
            monkeypatch.setenv(key_env, value)
        with pytest.raises(MissingApiKey) as excinfo:
            select_backend("meta", tmp_path)
        assert key_env in str(excinfo.value)
        assert META_KEY not in str(excinfo.value)

    def test_local_needs_no_key(self, monkeypatch, tmp_path):
        _provider_env(monkeypatch, "local")
        assert select_backend("meta", tmp_path).mode == "meta"

    def test_local_without_model_fails_startup(self, monkeypatch, tmp_path):
        _provider_env(monkeypatch, "local")
        monkeypatch.delenv("MEMRIPAL_LOCAL_CHAT_MODEL")
        with pytest.raises(ValueError) as excinfo:
            select_backend("meta", tmp_path)
        assert "MEMRIPAL_LOCAL_CHAT_MODEL" in str(excinfo.value)
        assert META_KEY not in str(excinfo.value)

    @pytest.mark.parametrize("provider", ["baseten", "fireworks", "local"])
    def test_non_meta_chat_still_requires_meta_key(self, monkeypatch, tmp_path, provider):
        _provider_env(monkeypatch, provider)
        monkeypatch.delenv("META_API_KEY")
        with pytest.raises(MissingApiKey) as excinfo:
            select_backend("meta", tmp_path)
        for key in ALL_KEYS:
            assert key not in str(excinfo.value)


# Covers: MEM-026
# Requirement: no provider key ever surfaces: the live backend's repr/str hold no key, and a
# failed provider chat call (an error status whose body echoes the key, or a transport error
# whose text holds it) raises BackendCallFailed whose message holds no key and no response body,
# and logs no key.
class TestChatProviderSecrets:
    @pytest.mark.parametrize("provider", sorted(KEYED))
    def test_backend_repr_and_str_hold_no_key(self, monkeypatch, tmp_path, provider):
        _provider_env(monkeypatch, provider)
        backend = select_backend("meta", tmp_path)
        for text in (repr(backend), str(backend)):
            for key in ALL_KEYS:
                assert key not in text

    @pytest.mark.parametrize("provider", sorted(KEYED))
    @pytest.mark.parametrize("failure", ["http-401", "connect-error"])
    def test_failed_chat_call_leaks_no_key(self, monkeypatch, tmp_path, net, caplog, provider, failure):
        _provider_env(monkeypatch, provider)
        key = KEYED[provider][3]
        echo = "bad key " + key + " for " + META_KEY
        if failure == "http-401":
            net.chat_answer = lambda: httpx.Response(401, json={"error": {"message": echo, "code": None}})
        else:

            def _raise():
                raise httpx.ConnectError(echo)

            net.chat_answer = _raise
        backend = select_backend("meta", tmp_path)

        with caplog.at_level(logging.DEBUG), pytest.raises(BackendCallFailed) as excinfo:
            backend.call(_spark_request())

        assert len(net.chats()) >= 1
        assert str(net.chats()[0].url) == KEYED[provider][0]
        message = str(excinfo.value)
        assert "bad key" not in message
        for secret in ALL_KEYS:
            assert secret not in message
            assert secret not in caplog.text


# Covers: MEM-026
# Requirement: fixture mode (MEMRIPAL_MODE=fixture, the default) never reads the chat provider
# settings: a bogus provider, a keyed provider without its key, or "local" without its model
# still yields the offline FixtureBackend.
class TestFixtureModeIgnoresChatProvider:
    @pytest.mark.parametrize("provider", ["bogus", "baseten", "fireworks", "local"])
    @pytest.mark.parametrize("mode", ["fixture", None], ids=["explicit", "default"])
    def test_fixture_mode_ignores_chat_provider(self, monkeypatch, tmp_path, provider, mode):
        monkeypatch.setenv("MEMRIPAL_CHAT_PROVIDER", provider)
        assert isinstance(select_backend(mode, tmp_path), FixtureBackend)


# Covers: MEM-026
# Requirement: a non-meta chat answer is never written to the live cache under the Meta request
# key (provider-distinct key, as for Modal SAM in ADR 0018), so it can never be replayed as a
# Meta Spark answer; exactly one spark_json entry is written per call.
class TestChatProviderCache:
    @pytest.mark.parametrize("provider", ["baseten", "fireworks", "local"])
    def test_non_meta_answer_not_cached_under_meta_key(self, monkeypatch, tmp_path, net, provider):
        _provider_env(monkeypatch, provider)
        live = tmp_path / "live"
        backend = select_backend("meta", tmp_path / "fx" / "fixtures", live)
        req = _spark_request()

        backend.call(req)

        assert not ResponseCache(live).path_for(req.cache_key()).exists()
        assert len(_files_under(live / "spark_json")) == 1
