# Covers: MEM-106
# Covers: MEM-107
# Requirement: Spark chat served by an open-weights provider (MEMRIPAL_CHAT_PROVIDER=baseten,
# fireworks or local) falls back to Meta's hosted Spark whenever the provider call fails (5xx,
# transport timeout, or a schema-invalid reply): the same request is re-sent to Meta with
# muse-spark-1.3 and cached under the Meta request key, a WARNING names the provider and the
# exception class only (never a key or body), and after a provider failure Spark goes straight to
# Meta for 120 s before the provider is tried again. Segmentation never falls back. Each served
# Spark call logs INFO "spark chat served by <provider|meta>". A request whose Spark call fell back
# and then succeeded on Meta carries the X-Memripal-Chat-Fallback: <provider> response header;
# other requests never do.
import importlib
import io
import json
import logging
import os
from typing import Annotated
from unittest import mock

import httpx
import pytest
from fastapi import FastAPI, Query
from fastapi.testclient import TestClient
from test_chat_provider_wiring import (
    ALL_KEYS,
    KEYED,
    LOCAL_MODEL,
    LOCAL_URL,
    META_CHAT_URL,
    META_KEY,
    _Net,
    _provider_env,
    _segment_request,
    _spark_request,
)
from test_station_api import GOOD_REPLY, UPLOAD

from memripal.backend import BackendCallFailed, MetaBackend, ResponseCache, select_backend
from memripal.chat_provider import ChatProvider
from memripal.meta_client import MetaClient

HEADER = "X-Memripal-Chat-Fallback"
LOOPBACK_URL = "http://127.0.0.1"
META_HOST = "api.meta.ai"
PROVIDER_ANSWER = {"phrases": ["provider-book"]}
META_ANSWER = {"phrases": ["meta-book"]}
SKIP_S = 120
# provider -> (base URL, model id, key or None for keyless local).
PROVIDERS = {
    "baseten": (
        KEYED["baseten"][0].removesuffix("/chat/completions"),
        KEYED["baseten"][1],
        KEYED["baseten"][3],
    ),
    "fireworks": (
        KEYED["fireworks"][0].removesuffix("/chat/completions"),
        KEYED["fireworks"][1],
        KEYED["fireworks"][3],
    ),
    "local": (LOCAL_URL, LOCAL_MODEL, None),
}
FAILURES = ("provider-500", "transport-timeout", "schema-invalid")
# The exception class a failure surfaces as after chat_json's CallResult is checked.
FAILURE_CLASS = {
    "provider-500": "BackendCallFailed",
    "transport-timeout": "BackendTimeout",
    "schema-invalid": "BackendReplyInvalid",
}


def _chat(content: dict):
    return lambda: httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(content)}}]})


def _status(code: int, message: str = "upstream down"):
    return lambda: httpx.Response(code, json={"error": {"message": message, "code": "upstream_down"}})


def _raise(exc: Exception):
    def _answer():
        raise exc

    return _answer


def _failure(name: str, echo: str = "upstream down"):
    if name == "provider-500":
        return _status(500, echo)
    if name == "transport-timeout":
        return _raise(httpx.ReadTimeout(echo))
    return _chat({"wrong_field": echo})


class _Router(_Net):
    """_Net split by host: provider chat, Meta chat, and Meta SAM each answer independently."""

    def __init__(self):
        super().__init__()
        self.provider_answer = _chat(PROVIDER_ANSWER)
        self.meta_answer = _chat(META_ANSWER)
        self.sam_answer = lambda: httpx.Response(200, json={"output_text": ""})

    def __call__(self, request: httpx.Request) -> httpx.Response:
        request.read()
        self.requests.append(request)
        if request.url.path.endswith("/chat/completions"):
            return (self.meta_answer if request.url.host == META_HOST else self.provider_answer)()
        if request.url.path.endswith("/responses"):
            return self.sam_answer()
        return httpx.Response(404, json={"error": {"code": "not_found"}})

    def provider_chats(self) -> list[httpx.Request]:
        return [r for r in self.chats() if r.url.host != META_HOST]

    def meta_chats(self) -> list[httpx.Request]:
        return [r for r in self.chats() if r.url.host == META_HOST]


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch, tmp_path):
    for name in list(os.environ):
        if name.startswith("MEMRIPAL_"):
            monkeypatch.delenv(name)
    for name in ("META_API_KEY", "BASETEN_API_KEY", "FIREWORKS_API_KEY", "K_SERVICE"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("USERPROFILE", str(tmp_path / "home"))


@pytest.fixture
def net():
    return _Router()


@pytest.fixture
def patched_net():
    """Routes every default-transport httpx.Client (env-built clients) to a _Router."""
    fake = _Router()
    with mock.patch.object(
        httpx.HTTPTransport, "handle_request", autospec=True, side_effect=lambda _self, request: fake(request)
    ):
        yield fake


def _backend(net: _Router, provider: str = "baseten", *, cache_root=None, **kwargs) -> MetaBackend:
    base, model, key = PROVIDERS[provider]
    transport = httpx.MockTransport(net)
    chat = ChatProvider(provider, MetaClient(key, base_url=base, transport=transport, max_retries=0), model)
    meta = MetaClient(META_KEY, transport=transport, max_retries=0)
    return MetaBackend(META_KEY, cache_root=cache_root, client=meta, chat=chat, **kwargs)


def _meta_only_backend(net: _Router) -> MetaBackend:
    meta = MetaClient(META_KEY, transport=httpx.MockTransport(net), max_retries=0)
    return MetaBackend(META_KEY, client=meta)


def _messages(caplog, level: int) -> list[str]:
    return [r.getMessage() for r in caplog.records if r.levelno == level]


# Covers: MEM-106
# Requirement: a provider 5xx, transport timeout, or schema-invalid reply on a spark_json call is
# retried once on Meta (META_CHAT_URL, model muse-spark-1.3, Meta bearer key) and the Meta answer
# is returned and cached under the Meta request key; a served provider answer makes no Meta call;
# when Meta also fails the call raises BackendCallFailed as before.
class TestSparkFallsBackToMeta:
    @pytest.mark.parametrize("provider", sorted(PROVIDERS))
    @pytest.mark.parametrize("failure", FAILURES)
    def test_provider_failure_is_served_by_meta_under_meta_key(self, net, tmp_path, provider, failure):
        net.provider_answer = _failure(failure)
        live = tmp_path / "live"
        req = _spark_request()

        assert _backend(net, provider, cache_root=live).call(req) == META_ANSWER

        assert len(net.provider_chats()) == 1
        (meta,) = net.meta_chats()
        assert str(meta.url) == META_CHAT_URL
        assert meta.headers["Authorization"] == "Bearer " + META_KEY
        assert json.loads(meta.content)["model"] == "muse-spark-1.3"
        entry = ResponseCache(live).path_for(req.cache_key())
        assert entry.is_file()
        assert json.loads(entry.read_bytes()) == META_ANSWER

    @pytest.mark.parametrize("provider", sorted(PROVIDERS))
    def test_provider_ok_makes_no_meta_call(self, net, provider):
        assert _backend(net, provider).call(_spark_request()) == PROVIDER_ANSWER
        assert len(net.provider_chats()) == 1
        assert net.meta_chats() == []

    def test_meta_failure_after_fallback_raises(self, net):
        net.provider_answer = _status(500)
        net.meta_answer = _status(502)
        with pytest.raises(BackendCallFailed):
            _backend(net).call(_spark_request())
        assert len(net.provider_chats()) == 1
        assert len(net.meta_chats()) == 1

    def test_env_wired_provider_500_is_tried_once_then_meta(self, monkeypatch, tmp_path, patched_net):
        _provider_env(monkeypatch, "baseten")
        patched_net.provider_answer = _status(500)

        assert select_backend("meta", tmp_path).call(_spark_request()) == META_ANSWER

        assert len(patched_net.provider_chats()) == 1
        assert len(patched_net.meta_chats()) == 1


# Covers: MEM-106
# Requirement: the fallback WARNING reads "spark chat: <provider> failed (<exception class>),
# falling back to meta" and never contains any API key or the provider's response body.
class TestFallbackWarning:
    @pytest.mark.parametrize("provider", sorted(KEYED))
    @pytest.mark.parametrize("failure", FAILURES)
    def test_warning_names_provider_and_class_only(self, net, caplog, provider, failure):
        echo = "bad key " + PROVIDERS[provider][2] + " for " + META_KEY
        net.provider_answer = _failure(failure, echo)

        with caplog.at_level(logging.DEBUG):
            assert _backend(net, provider).call(_spark_request()) == META_ANSWER

        expected = f"spark chat: {provider} failed ({FAILURE_CLASS[failure]}), falling back to meta"
        assert expected in _messages(caplog, logging.WARNING)
        assert "bad key" not in caplog.text
        for secret in ALL_KEYS:
            assert secret not in caplog.text


# Covers: MEM-106
# Requirement: every successful spark_json call logs INFO "spark chat served by <name>": the
# provider name when the provider answered, "meta" after a fallback, and "meta" on a Meta-only
# backend too.
class TestServedByLog:
    @pytest.mark.parametrize("provider", sorted(PROVIDERS))
    def test_provider_served(self, net, caplog, provider):
        with caplog.at_level(logging.INFO, logger="memripal"):
            _backend(net, provider).call(_spark_request())
        assert f"spark chat served by {provider}" in _messages(caplog, logging.INFO)
        assert "spark chat served by meta" not in _messages(caplog, logging.INFO)

    def test_fallback_served_by_meta(self, net, caplog):
        net.provider_answer = _status(500)
        with caplog.at_level(logging.INFO, logger="memripal"):
            _backend(net).call(_spark_request())
        assert "spark chat served by meta" in _messages(caplog, logging.INFO)
        assert "spark chat served by baseten" not in _messages(caplog, logging.INFO)

    def test_meta_only_backend_served_by_meta(self, net, caplog):
        with caplog.at_level(logging.INFO, logger="memripal"):
            assert _meta_only_backend(net).call(_spark_request()) == META_ANSWER
        assert "spark chat served by meta" in _messages(caplog, logging.INFO)


# Covers: MEM-106
# Requirement: after a provider failure, spark_json calls within the next 120 s (injected
# monotonic clock) go straight to Meta without touching the provider; after 120 s the provider is
# tried again.
class TestChatBreaker:
    def test_skips_provider_within_window_and_retries_after(self, net):
        now = [1000.0]
        backend = _backend(net, clock=lambda: now[0])
        net.provider_answer = _status(500)
        assert backend.call(_spark_request()) == META_ANSWER
        assert len(net.provider_chats()) == 1

        net.provider_answer = _chat(PROVIDER_ANSWER)
        now[0] = 1000.0 + SKIP_S - 1
        assert backend.call(_spark_request()) == META_ANSWER
        assert len(net.provider_chats()) == 1
        assert len(net.meta_chats()) == 2

        now[0] = 1000.0 + SKIP_S + 1
        assert backend.call(_spark_request()) == PROVIDER_ANSWER
        assert len(net.provider_chats()) == 2
        assert len(net.meta_chats()) == 2


# Covers: MEM-106
# Requirement: segmentation never falls back or touches the chat provider: a failed Meta SAM call
# raises BackendCallFailed with no chat request and no fallback warning.
class TestSegmentNeverFallsBack:
    def test_segment_failure_raises_without_chat(self, net, caplog):
        net.sam_answer = _status(502)
        with caplog.at_level(logging.DEBUG), pytest.raises(BackendCallFailed):
            _backend(net).call(_segment_request())
        assert net.chats() == []
        assert "falling back" not in caplog.text


# Covers: MEM-106
# Requirement: the per-instance call budget charges one unit per backend call, even when that call
# fell back to Meta.
class TestBudgetChargesOneUnitWithFallback:
    def test_fallback_call_costs_one_unit(self, net):
        from memripal.app import _BudgetedBackend
        from memripal.bodies import BudgetExhausted

        net.provider_answer = _status(500)
        budgeted = _BudgetedBackend(_backend(net), 1)
        assert budgeted.call(_spark_request()) == META_ANSWER
        sent = len(net.requests)
        with pytest.raises(BudgetExhausted):
            budgeted.call(_spark_request())
        assert len(net.requests) == sent


# Covers: MEM-106
# Requirement: provider clients are bounded so a dead provider fails fast: chat_provider exposes
# PROVIDER_TIMEOUT = httpx.Timeout(30.0, connect=5.0) and PROVIDER_RETRIES = 0, and every provider
# MetaClient built from the env gets exactly those.
class TestProviderClientBounds:
    def test_constants(self):
        chat_provider = importlib.import_module("memripal.chat_provider")
        assert chat_provider.PROVIDER_TIMEOUT == httpx.Timeout(30.0, connect=5.0)
        assert chat_provider.PROVIDER_RETRIES == 0

    @pytest.mark.parametrize("provider", sorted(PROVIDERS))
    def test_env_built_provider_client_gets_bounds(self, monkeypatch, provider):
        from memripal.chat_provider import chat_provider_from_env

        _provider_env(monkeypatch, provider)
        with mock.patch("memripal.chat_provider.MetaClient", wraps=MetaClient) as spy:
            chat_provider_from_env(provider)
        assert spy.call_count == 1
        assert spy.call_args.kwargs["timeout"] == httpx.Timeout(30.0, connect=5.0)
        assert spy.call_args.kwargs["max_retries"] == 0


@pytest.fixture
def memripal_logger():
    importlib.import_module("memripal.app")
    lg = logging.getLogger("memripal")
    saved = (lg.handlers[:], lg.level)
    lg.handlers.clear()
    yield lg
    lg.handlers[:] = saved[0]
    lg.setLevel(saved[1])


# Covers: MEM-106
# Requirement: create_app makes the INFO "served by" / WARNING fallback lines visible: it adds one
# INFO StreamHandler to the "memripal" logger when that logger has no handler, sets the logger to
# INFO, never adds a second handler on a second create_app, never touches the root logger, and
# leaves an existing handler alone.
class TestMemripalLogHandler:
    def test_one_info_handler_across_two_create_app(self, memripal_logger):
        from memripal.app import create_app

        root_before = logging.getLogger().handlers[:]
        create_app()
        create_app()
        handlers = memripal_logger.handlers
        assert len(handlers) == 1
        assert isinstance(handlers[0], logging.StreamHandler)
        assert handlers[0].level <= logging.INFO
        assert memripal_logger.level == logging.INFO
        assert logging.getLogger().handlers == root_before

    def test_existing_handler_kept_and_none_added(self, memripal_logger):
        from memripal.app import create_app

        existing = logging.StreamHandler(io.StringIO())
        memripal_logger.addHandler(existing)
        create_app()
        assert memripal_logger.handlers == [existing]


def _cf():
    return importlib.import_module("memripal.chat_fallback")


def _mini_app(cf) -> FastAPI:
    app = FastAPI()

    # Sync route: runs in the threadpool like the real spark routes.
    @app.get("/note")
    def note(p: Annotated[list[str], Query()] = None) -> dict:
        for provider in p or []:
            cf.note_chat_fallback(provider)
        return {"ok": True}

    app.add_middleware(cf.ChatFallbackHeader)
    return app


# Covers: MEM-107
# Requirement: memripal.chat_fallback.HEADER is "X-Memripal-Chat-Fallback"; ChatFallbackHeader
# gives each HTTP request a fresh fallback list, sets HEADER to the first provider noted during
# that request, and sets nothing when none was noted; note_chat_fallback outside a request is a
# no-op that never leaks into a later request.
class TestChatFallbackHeaderMiddleware:
    def test_header_constant(self):
        assert _cf().HEADER == HEADER

    def test_noted_request_carries_header(self):
        resp = TestClient(_mini_app(_cf())).get("/note", params={"p": "baseten"})
        assert resp.status_code == 200
        assert resp.headers[HEADER] == "baseten"

    def test_first_noted_provider_wins(self):
        resp = TestClient(_mini_app(_cf())).get("/note", params={"p": ["fireworks", "baseten"]})
        assert resp.headers[HEADER] == "fireworks"

    def test_unnoted_request_has_no_header_even_after_a_noted_one(self):
        with TestClient(_mini_app(_cf())) as client:
            assert client.get("/note", params={"p": "local"}).headers[HEADER] == "local"
            assert HEADER not in client.get("/note").headers

    def test_note_outside_request_is_noop(self):
        cf = _cf()
        assert cf.note_chat_fallback("baseten") is None
        assert HEADER not in TestClient(_mini_app(cf)).get("/note").headers


def _station_app(net: _Router, provider: str = "baseten", clock=None):
    from memripal.app import create_app

    net.provider_answer = _chat(GOOD_REPLY)
    net.meta_answer = _chat(GOOD_REPLY)
    kwargs = {} if clock is None else {"clock": clock}
    backend = _backend(net, provider, **kwargs)
    return TestClient(create_app(backend=backend), base_url=LOOPBACK_URL)


def _post_station(client):
    return client.post("/station", content=UPLOAD, headers={"Content-Type": "image/jpeg"})


# Covers: MEM-107
# Requirement: on the live app (create_app, POST /station running Spark), a request whose Spark
# call fell back and succeeded on Meta answers 200 with X-Memripal-Chat-Fallback: <provider>; a
# breaker-skipped request (straight to Meta) carries it too; a provider-served request does not,
# nor does the first request served by the provider again after the window; a request whose Meta
# fallback also failed answers 502 without it.
class TestHeaderOnLiveSparkRoute:
    def test_provider_served_has_no_header(self, net):
        resp = _post_station(_station_app(net))
        assert resp.status_code == 200, resp.text
        assert HEADER not in resp.headers
        assert net.meta_chats() == []

    @pytest.mark.parametrize("provider", sorted(PROVIDERS))
    def test_fallback_sets_header_then_clears_after_window(self, net, provider):
        now = [500.0]
        client = _station_app(net, provider, clock=lambda: now[0])
        net.provider_answer = _status(500)

        first = _post_station(client)
        assert first.status_code == 200, first.text
        assert first.headers[HEADER] == provider

        now[0] += SKIP_S - 1
        skipped = _post_station(client)
        assert skipped.status_code == 200, skipped.text
        assert skipped.headers[HEADER] == provider
        assert len(net.provider_chats()) == 1

        net.provider_answer = _chat(GOOD_REPLY)
        now[0] += 2
        served = _post_station(client)
        assert served.status_code == 200, served.text
        assert HEADER not in served.headers
        assert len(net.provider_chats()) == 2

    def test_meta_failure_after_fallback_is_502_without_header(self, net):
        client = _station_app(net)
        net.provider_answer = _status(500)
        net.meta_answer = _status(502)
        resp = _post_station(client)
        assert resp.status_code == 502, resp.text
        assert resp.json() == {"error": "upstream"}
        assert HEADER not in resp.headers
        assert len(net.meta_chats()) == 1


# Covers: MEM-107
# Requirement: cors.add_cors exposes X-Memripal-Chat-Fallback to the cross-origin Capacitor shell,
# so the client can read it.
class TestCorsExposesFallbackHeader:
    def test_expose_headers_contains_header(self):
        from memripal.cors import add_cors

        app = FastAPI()

        @app.get("/healthz")
        def healthz() -> dict:
            return {"ok": True}

        add_cors(app)
        client = TestClient(app, base_url=LOOPBACK_URL)
        resp = client.get("/healthz", headers={"Origin": "https://localhost"})
        exposed = {
            h.strip().lower() for h in resp.headers.get("access-control-expose-headers", "").split(",")
        }
        assert HEADER.lower() in exposed
