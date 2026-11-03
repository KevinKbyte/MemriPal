# Covers: MEM-094
# Requirement: judges must have enough credit to use and judge the app, and our Meta bill must never
# pass the $150 credit (Meta's own spend limit only notifies; Kev's card is on file). So the server
# refuses Meta calls itself: memripal.meta_spend_guard.MetaSpendGuard(state_dir, cap_usd=None) keeps
# a persisted running estimate (spent_usd) of Meta spend, adding CALL_COST_USD[kind] per call for
# kind "chat" (Spark), "segment" (SAM) and "asr" (speech-to-text). charge(kind) refuses, with the typed
# MetaSpendCapReached (a BackendCallFailed, message naming the spend cap), any call whose estimate
# would take spent_usd over cap_usd; cap_usd defaults to env MEMRIPAL_META_SPEND_CAP_USD, else
# DEFAULT_CAP_USD = 135.0, and an unparseable, negative or non-finite env value is a ValueError. The
# estimate lives in a file under state_dir (created if missing; env MEMRIPAL_META_SPEND_DIR in
# select_backend), survives a restart, and an unreadable state file fails closed (refuses), never
# resets to zero. MetaClient(..., spend_guard=guard) charges before sending in chat_json, segment
# and transcribe (after transcribe's own input validation), so a refused call sends no HTTP request
# and a sent call counts even if it then fails (the paid request may have landed). Chat has a
# fallback: MetaBackend(..., chat_fallback=ChatProvider) answers a capped Spark call through the
# Baseten/Fireworks provider (cached under its provider key, never as a Meta entry, and not counted
# as Meta spend); select_backend("meta") wires the guard and picks the fallback from BASETEN_API_KEY,
# else FIREWORKS_API_KEY. Segment and ASR have no fallback and raise MetaSpendCapReached.
import dataclasses
import io
import json
import math
import wave
from pathlib import Path
from unittest import mock

import httpx
import pytest

from memripal.backend import BackendCallFailed, MetaBackend, ModelRequest, ResponseCache, select_backend
from memripal.chat_provider import ChatProvider
from memripal.meta_client import MetaClient
from memripal.meta_spend_guard import (
    CALL_COST_USD,
    DEFAULT_CAP_USD,
    SPEND_CAP_ENV,
    SPEND_DIR_ENV,
    MetaSpendCapReached,
    MetaSpendGuard,
)

# Built by concatenation so this file never matches the pre-commit secret scanner (MEM-004).
META_KEY = "fake" + "-meta-" + "s" * 24
BASETEN_KEY = "fake" + "-baseten-" + "b" * 24
FIREWORKS_KEY = "fake" + "-fireworks-" + "f" * 24
BASETEN_URL = "https://inference.baseten.co/v1"
BASETEN_MODEL = "meta-models/muse-spark-open-1026"
IMAGE = b"\xff\xd8\xff\xe0fake-processed-jpeg-bytes\xff\xd9"
DATA_URL = "data:image/jpeg;base64,AAAA"
PHRASES_SCHEMA = {
    "type": "object",
    "properties": {"phrases": {"type": "array", "items": {"type": "string"}}},
    "required": ["phrases"],
    "additionalProperties": False,
}
SAM_TEXT = "<|box;x1=1;y1=2;x2=3;y2=4;w=640;h=480;c=0.5|>"


def _wav() -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"\x00" * 3200)
    return buf.getvalue()


def _chat_body(content: dict) -> dict:
    return {"choices": [{"message": {"content": json.dumps(content)}}]}


class _Net:
    """Stands in for every network host (no network): records each request, answers by path."""

    def __init__(self, status: int = 200):
        self.status = status
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        request.read()
        self.requests.append(request)
        if self.status != 200:
            return httpx.Response(self.status, json={"error": {"code": "server_error"}})
        path = request.url.path
        if path.endswith("/chat/completions"):
            phrase = "meta" if request.url.host == "api.meta.ai" else request.url.host
            return httpx.Response(200, json=_chat_body({"phrases": [phrase]}))
        if path.endswith("/responses"):
            return httpx.Response(200, json={"output_text": SAM_TEXT})
        if path.endswith("/asr/transcribe"):
            return httpx.Response(200, json={"transcript": "hello"})
        return httpx.Response(404, json={"error": {"code": "not_found"}})

    def to_host(self, host: str) -> list[httpx.Request]:
        return [r for r in self.requests if r.url.host == host]


def _meta_client(guard: MetaSpendGuard | None, net: _Net) -> MetaClient:
    return MetaClient(META_KEY, transport=httpx.MockTransport(net), max_retries=0, spend_guard=guard)


def _call(client: MetaClient, kind: str):
    if kind == "chat":
        return client.chat_json(prompt="p", schema=PHRASES_SCHEMA, schema_name="phrases")
    if kind == "segment":
        return client.segment(image_data_url=DATA_URL, phrase="book")
    return client.transcribe(_wav())


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


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch, tmp_path):
    for name in (
        SPEND_CAP_ENV,
        SPEND_DIR_ENV,
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


KINDS = ("chat", "segment", "asr")


class TestSpendGuardContract:
    def test_names_and_defaults(self):
        assert SPEND_CAP_ENV == "MEMRIPAL_META_SPEND_CAP_USD"
        assert SPEND_DIR_ENV == "MEMRIPAL_META_SPEND_DIR"
        assert DEFAULT_CAP_USD == 135.0
        assert set(CALL_COST_USD) == set(KINDS)
        assert all(math.isfinite(c) and c > 0 for c in CALL_COST_USD.values())

    def test_refusal_is_a_typed_backend_failure(self):
        assert issubclass(MetaSpendCapReached, BackendCallFailed)

    def test_fresh_guard_starts_at_zero_under_the_default_cap(self, tmp_path):
        guard = MetaSpendGuard(tmp_path / "spend")
        assert guard.spent_usd == 0
        assert guard.cap_usd == DEFAULT_CAP_USD


class TestCapConfigurable:
    def test_env_sets_the_cap(self, monkeypatch, tmp_path):
        monkeypatch.setenv(SPEND_CAP_ENV, "42.5")
        assert MetaSpendGuard(tmp_path / "spend").cap_usd == 42.5

    def test_explicit_cap_wins_over_env(self, monkeypatch, tmp_path):
        monkeypatch.setenv(SPEND_CAP_ENV, "42.5")
        assert MetaSpendGuard(tmp_path / "spend", cap_usd=7.0).cap_usd == 7.0

    @pytest.mark.parametrize("bad", ["abc", "", "-1", "nan", "inf"])
    def test_bad_env_cap_fails_at_construction(self, monkeypatch, tmp_path, bad):
        monkeypatch.setenv(SPEND_CAP_ENV, bad)
        with pytest.raises(ValueError):
            MetaSpendGuard(tmp_path / "spend")

    def test_zero_cap_refuses_every_kind(self, monkeypatch, tmp_path):
        monkeypatch.setenv(SPEND_CAP_ENV, "0")
        guard = MetaSpendGuard(tmp_path / "spend")
        for kind in KINDS:
            with pytest.raises(MetaSpendCapReached):
                guard.charge(kind)
        assert guard.spent_usd == 0


class TestCapBlocks:
    @pytest.mark.parametrize("kind", KINDS)
    def test_call_that_would_pass_the_cap_is_refused(self, tmp_path, kind):
        cost = CALL_COST_USD[kind]
        guard = MetaSpendGuard(tmp_path / "spend", cap_usd=cost * 2.5)
        guard.charge(kind)
        guard.charge(kind)
        with pytest.raises(MetaSpendCapReached) as exc:
            guard.charge(kind)
        assert "spend cap" in str(exc.value).lower()
        assert guard.spent_usd == pytest.approx(cost * 2)

    def test_refused_call_never_adds_to_the_estimate(self, tmp_path):
        guard = MetaSpendGuard(tmp_path / "spend", cap_usd=CALL_COST_USD["chat"] * 1.5)
        guard.charge("chat")
        for _ in range(3):
            with pytest.raises(MetaSpendCapReached):
                guard.charge("chat")
        assert guard.spent_usd == pytest.approx(CALL_COST_USD["chat"])


class TestRestartKeepsEstimate:
    def test_new_guard_on_same_dir_sees_prior_spend(self, tmp_path):
        state = tmp_path / "spend"
        first = MetaSpendGuard(state, cap_usd=100.0)
        first.charge("chat")
        first.charge("segment")

        restarted = MetaSpendGuard(state, cap_usd=100.0)

        expected = CALL_COST_USD["chat"] + CALL_COST_USD["segment"]
        assert restarted.spent_usd == pytest.approx(expected)

    def test_cap_reached_before_restart_still_refuses_after(self, tmp_path):
        state = tmp_path / "spend"
        cap = CALL_COST_USD["segment"] * 1.5
        MetaSpendGuard(state, cap_usd=cap).charge("segment")

        with pytest.raises(MetaSpendCapReached):
            MetaSpendGuard(state, cap_usd=cap).charge("segment")

    def test_missing_nested_state_dir_is_created(self, tmp_path):
        state = tmp_path / "a" / "b" / "spend"
        MetaSpendGuard(state, cap_usd=100.0).charge("asr")
        assert MetaSpendGuard(state, cap_usd=100.0).spent_usd == pytest.approx(CALL_COST_USD["asr"])

    def test_separate_dirs_keep_separate_estimates(self, tmp_path):
        MetaSpendGuard(tmp_path / "one", cap_usd=100.0).charge("chat")
        assert MetaSpendGuard(tmp_path / "two", cap_usd=100.0).spent_usd == 0

    def test_corrupt_state_fails_closed(self, tmp_path):
        state = tmp_path / "spend"
        MetaSpendGuard(state, cap_usd=100.0).charge("chat")
        files = [p for p in state.rglob("*") if p.is_file()]
        assert files, "the estimate must be persisted under state_dir"
        for path in files:
            path.write_bytes(b"\x00not a spend record{")

        with pytest.raises(MetaSpendCapReached):
            MetaSpendGuard(state, cap_usd=100.0).charge("chat")


class TestMetaClientUnderCap:
    @pytest.mark.parametrize("kind", KINDS)
    def test_call_passes_and_adds_its_estimate(self, tmp_path, kind):
        net = _Net()
        guard = MetaSpendGuard(tmp_path / "spend", cap_usd=100.0)

        result = _call(_meta_client(guard, net), kind)

        assert result.ok
        assert len(net.requests) == 1
        assert guard.spent_usd == pytest.approx(CALL_COST_USD[kind])

    def test_estimates_accumulate_across_kinds(self, tmp_path):
        net = _Net()
        guard = MetaSpendGuard(tmp_path / "spend", cap_usd=100.0)
        client = _meta_client(guard, net)
        for kind in KINDS:
            _call(client, kind)
        assert guard.spent_usd == pytest.approx(sum(CALL_COST_USD[k] for k in KINDS))

    def test_failed_meta_call_still_counts(self, tmp_path):
        net = _Net(status=500)
        guard = MetaSpendGuard(tmp_path / "spend", cap_usd=100.0)

        result = _call(_meta_client(guard, net), "segment")

        assert not result.ok
        assert guard.spent_usd == pytest.approx(CALL_COST_USD["segment"])

    def test_rejected_audio_is_not_charged(self, tmp_path):
        net = _Net()
        guard = MetaSpendGuard(tmp_path / "spend", cap_usd=100.0)
        with pytest.raises(ValueError):
            _meta_client(guard, net).transcribe(b"not a wav")
        assert guard.spent_usd == 0
        assert net.requests == []

    def test_client_without_guard_is_unchanged(self):
        net = _Net()
        assert _call(_meta_client(None, net), "chat").ok
        assert len(net.requests) == 1


class TestMetaClientCapped:
    @pytest.mark.parametrize("kind", KINDS)
    def test_capped_call_raises_and_sends_nothing(self, tmp_path, kind):
        net = _Net()
        guard = MetaSpendGuard(tmp_path / "spend", cap_usd=0.0)

        with pytest.raises(MetaSpendCapReached) as exc:
            _call(_meta_client(guard, net), kind)

        assert net.requests == []
        assert META_KEY not in str(exc.value)

    def test_backend_segment_has_no_fallback(self, tmp_path):
        net = _Net()
        guard = MetaSpendGuard(tmp_path / "spend", cap_usd=0.0)
        fallback = ChatProvider(
            "baseten",
            MetaClient(BASETEN_KEY, base_url=BASETEN_URL, transport=httpx.MockTransport(net)),
            BASETEN_MODEL,
        )
        backend = MetaBackend(META_KEY, client=_meta_client(guard, net), chat_fallback=fallback)

        with pytest.raises(MetaSpendCapReached):
            backend.call(_segment_request())
        assert net.requests == []


class TestChatFallsBackWhenCapped:
    def _backend(self, tmp_path, net, cap: float) -> tuple[MetaBackend, MetaSpendGuard]:
        guard = MetaSpendGuard(tmp_path / "spend", cap_usd=cap)
        fallback = ChatProvider(
            "baseten",
            MetaClient(BASETEN_KEY, base_url=BASETEN_URL, transport=httpx.MockTransport(net)),
            BASETEN_MODEL,
        )
        backend = MetaBackend(
            META_KEY, cache_root=tmp_path / "live", client=_meta_client(guard, net), chat_fallback=fallback
        )
        return backend, guard

    def test_capped_chat_answers_through_the_fallback(self, tmp_path):
        net = _Net()
        backend, guard = self._backend(tmp_path, net, cap=0.0)

        assert backend.call(_spark_request()) == {"phrases": ["inference.baseten.co"]}

        assert net.to_host("api.meta.ai") == []
        (sent,) = net.to_host("inference.baseten.co")
        assert sent.headers["Authorization"] == "Bearer " + BASETEN_KEY
        assert json.loads(sent.content)["model"] == BASETEN_MODEL
        assert guard.spent_usd == 0

    def test_fallback_answer_is_cached_under_the_provider_key(self, tmp_path):
        net = _Net()
        backend, _ = self._backend(tmp_path, net, cap=0.0)
        req = _spark_request()

        backend.call(req)

        cache = ResponseCache(tmp_path / "live")
        assert cache.get(req.cache_key()) is None
        provider_req = dataclasses.replace(req, model="baseten/" + BASETEN_MODEL)
        assert cache.get(provider_req.cache_key()) is not None

    def test_under_cap_chat_stays_on_meta(self, tmp_path):
        net = _Net()
        backend, guard = self._backend(tmp_path, net, cap=100.0)

        assert backend.call(_spark_request()) == {"phrases": ["meta"]}

        assert net.to_host("inference.baseten.co") == []
        assert guard.spent_usd == pytest.approx(CALL_COST_USD["chat"])

    def test_capped_chat_without_fallback_raises(self, tmp_path):
        net = _Net()
        guard = MetaSpendGuard(tmp_path / "spend", cap_usd=0.0)
        backend = MetaBackend(META_KEY, client=_meta_client(guard, net))

        with pytest.raises(MetaSpendCapReached):
            backend.call(_spark_request())
        assert net.requests == []


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


def _live_env(monkeypatch, tmp_path: Path, cap: str) -> Path:
    state = tmp_path / "spend"
    monkeypatch.setenv("META_API_KEY", META_KEY)
    monkeypatch.setenv(SPEND_DIR_ENV, str(state))
    monkeypatch.setenv(SPEND_CAP_ENV, cap)
    return state


class TestSelectBackendWiresTheGuard:
    def test_meta_calls_are_counted_in_the_env_state_dir(self, monkeypatch, tmp_path, net):
        state = _live_env(monkeypatch, tmp_path, "100")

        select_backend("meta", tmp_path / "fixtures").call(_segment_request())

        assert MetaSpendGuard(state, cap_usd=100.0).spent_usd == pytest.approx(CALL_COST_USD["segment"])

    def test_capped_chat_falls_back_to_baseten(self, monkeypatch, tmp_path, net):
        _live_env(monkeypatch, tmp_path, "0")
        monkeypatch.setenv("BASETEN_API_KEY", BASETEN_KEY)
        monkeypatch.setenv("FIREWORKS_API_KEY", FIREWORKS_KEY)

        answer = select_backend("meta", tmp_path / "fixtures").call(_spark_request())

        assert answer == {"phrases": ["inference.baseten.co"]}
        assert net.to_host("api.meta.ai") == []

    def test_capped_chat_falls_back_to_fireworks_when_only_its_key_is_set(self, monkeypatch, tmp_path, net):
        _live_env(monkeypatch, tmp_path, "0")
        monkeypatch.setenv("FIREWORKS_API_KEY", FIREWORKS_KEY)

        answer = select_backend("meta", tmp_path / "fixtures").call(_spark_request())

        assert answer == {"phrases": ["api.fireworks.ai"]}
        assert net.to_host("api.meta.ai") == []

    def test_capped_segment_refuses_through_select_backend(self, monkeypatch, tmp_path, net):
        _live_env(monkeypatch, tmp_path, "0")
        monkeypatch.setenv("BASETEN_API_KEY", BASETEN_KEY)

        with pytest.raises(MetaSpendCapReached):
            select_backend("meta", tmp_path / "fixtures").call(_segment_request())
        assert net.requests == []
