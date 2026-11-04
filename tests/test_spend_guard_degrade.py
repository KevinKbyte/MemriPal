# Covers: MEM-121
# Requirement: the Meta spend guard (MEM-094) counts every Meta request and the app degrades instead of
# failing when the cap is reached (Kev, 2026-11-04: "when credit runs out the app keeps working on saved
# results and the backup chat provider for everyone").
# - Every Meta call kind charges: chat, segment, asr, image_edit, image_generate, including the ASR client
#   create_app builds from META_API_KEY and the two live scripts (probe_live, gen_room_fixtures).
# - Each attempt charges: a request retried after a 500 with max_retries=2 costs 3x its call estimate; a
#   retry the cap would refuse raises MetaSpendCapReached and sends nothing more.
# - memripal.spend_degrade.with_saved_results(backend, roots): on MetaSpendCapReached it replays the same
#   request from the first ResponseCache root holding it (live cache, then fixture replay); a miss re-raises.
#   create_app(saved_roots=...) wraps a live backend with it (default: the live cache, then REPLAY_DIR).
# - Each live model route under the cap returns the saved answer or the cap code (503
#   meta_spend_cap_reached; /scenes: tier 3 with reason meta_spend_cap_reached), never a generic 502.
# - The response names the cap in header X-Memripal-Spend-Cap: "saved" (served from saved results),
#   "backup" (chat answered by the backup provider), "capped" (refused, nothing saved); most severe wins.
import base64
import importlib.util
import io
import json
import wave
from pathlib import Path
from unittest import mock

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image
from test_associate_api import _body as associate_body
from test_associate_api import echo_record
from test_record_sign import KEY, KEY_ENV
from test_scenes_api import WEBP_SMALL
from test_scenes_api import _body as scenes_body
from test_split_notes import GOOD_REPLY as SPLIT_REPLY
from test_split_notes import NOTES, PHOTO

from memripal.app import REPLAY_DIR, create_app
from memripal.backend import BackendCallFailed, FixtureBackend, MetaBackend, ModelRequest, ResponseCache
from memripal.chat_provider import ChatProvider
from memripal.meta_client import MetaClient
from memripal.meta_spend_guard import (
    CALL_COST_USD,
    CAP_ERROR_CODE,
    IMAGE_CALL_COST_USD,
    SPEND_CAP_ENV,
    SPEND_DIR_ENV,
    MetaSpendCapReached,
    MetaSpendGuard,
)

REPO = Path(__file__).resolve().parents[1]
DEMO_PHOTO = REPO / "fixtures" / "demo" / "photo.jpg"
LOOPBACK_URL = "http://127.0.0.1"
SPEND_HEADER = "X-Memripal-Spend-Cap"
# Built by concatenation so this file never matches the pre-commit secret scanner (MEM-004).
META_KEY = "fake" + "-meta-" + "m" * 24
BASETEN_KEY = "fake" + "-baseten-" + "b" * 24
COSTS = CALL_COST_USD | IMAGE_CALL_COST_USD
DATA_URL = "data:image/jpeg;base64,AAAA"
SCHEMA = {"type": "object", "properties": {}, "additionalProperties": True}


def _wav() -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"\x00" * 3200)
    return buf.getvalue()


def _jpeg(w: int = 640, h: int = 480) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (90, 60, 30)).save(buf, "JPEG")
    return buf.getvalue()


class _Net:
    """Every network host (no network): records each request, answers `status` or a canned reply by path."""

    def __init__(self, status: int = 200, chat_content: dict | None = None):
        self.status = status
        self.chat_content = chat_content if chat_content is not None else {"ok": True}
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        request.read()
        self.requests.append(request)
        if self.status != 200:
            return httpx.Response(self.status, json={"error": {"code": "server_error"}})
        path = request.url.path
        if path.endswith("/chat/completions"):
            return httpx.Response(
                200, json={"choices": [{"message": {"content": json.dumps(self.chat_content)}}]}
            )
        if path.endswith("/responses"):
            return httpx.Response(200, json={"output_text": ""})
        if path.endswith("/asr/transcribe"):
            return httpx.Response(200, json={"transcript": "hello"})
        if path.startswith("/v1/images/"):
            return httpx.Response(200, json={"data": [{"b64_json": base64.b64encode(WEBP_SMALL).decode()}]})
        return httpx.Response(404, json={"error": {"code": "not_found"}})

    def to_host(self, host: str) -> list[httpx.Request]:
        return [r for r in self.requests if r.url.host == host]


def _client(guard, net, max_retries: int = 0) -> MetaClient:
    return MetaClient(
        META_KEY,
        transport=httpx.MockTransport(net),
        max_retries=max_retries,
        sleep=lambda _s: None,
        spend_guard=guard,
    )


def _call(client: MetaClient, kind: str):
    if kind == "chat":
        return client.chat_json(prompt="p", schema=SCHEMA, schema_name="x")
    if kind == "segment":
        return client.segment(image_data_url=DATA_URL, phrase="book")
    if kind == "asr":
        return client.transcribe(_wav())
    if kind == "image_edit":
        return client.image_edit(image_data_url=DATA_URL, prompt="p")
    return client.image_generate(prompt="p")


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch, tmp_path):
    for name in (
        SPEND_CAP_ENV,
        SPEND_DIR_ENV,
        "MEMRIPAL_MODE",
        "META_API_KEY",
        "MEMRIPAL_PASSCODE",
        "MEMRIPAL_CALL_BUDGET",
        "MEMRIPAL_ACCESS_KEY",
        "BASETEN_API_KEY",
        "FIREWORKS_API_KEY",
    ):
        monkeypatch.delenv(name, raising=False)  # fmt: skip
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("USERPROFILE", str(tmp_path / "home"))
    monkeypatch.setenv(KEY_ENV, KEY)


@pytest.fixture
def patched_net():
    fake = _Net()
    # Every httpx.Client built without an explicit transport routes here, whoever builds it.
    with mock.patch.object(
        httpx.HTTPTransport, "handle_request", autospec=True, side_effect=lambda _self, request: fake(request)
    ):
        yield fake


class TestEveryCallKindCharges:
    @pytest.mark.parametrize("kind", sorted(COSTS))
    def test_kind_adds_its_estimate(self, tmp_path, kind):
        net = _Net()
        guard = MetaSpendGuard(tmp_path / "spend", cap_usd=100.0)

        assert _call(_client(guard, net), kind).ok

        assert len(net.requests) == 1
        assert guard.spent_usd == pytest.approx(COSTS[kind])

    @pytest.mark.parametrize("kind", sorted(COSTS))
    def test_capped_kind_sends_nothing(self, tmp_path, kind):
        net = _Net()
        with pytest.raises(MetaSpendCapReached):
            _call(_client(MetaSpendGuard(tmp_path / "spend", cap_usd=0.0), net), kind)
        assert net.requests == []

    def test_asr_client_built_by_create_app_charges(self, monkeypatch, tmp_path, patched_net):
        state = tmp_path / "spend"
        monkeypatch.setenv("META_API_KEY", META_KEY)
        monkeypatch.setenv(SPEND_DIR_ENV, str(state))
        monkeypatch.setenv(SPEND_CAP_ENV, "100")
        app = create_app(backend=_Raising(AssertionError("no model call")), saved_roots=())

        body = {"audio": base64.b64encode(_wav()).decode(), "keywords": ["lamp"]}
        resp = TestClient(app, base_url=LOOPBACK_URL).post("/recall/audio", json=body)

        assert resp.status_code == 200, resp.text
        assert MetaSpendGuard(state, cap_usd=100.0).spent_usd == pytest.approx(CALL_COST_USD["asr"])

    def test_gen_room_fixtures_client_is_guarded(self, monkeypatch, tmp_path):
        monkeypatch.setenv("META_API_KEY", META_KEY)
        built: list[dict] = []

        def factory(*args, **kwargs):
            built.append(kwargs)
            raise SystemExit(0)  # stop before any call

        mod = _load_script("gen_room_fixtures")
        with pytest.raises(SystemExit):
            mod.main(["--out", str(tmp_path / "rooms")], make_client=factory)
        assert isinstance(built[0].get("spend_guard"), MetaSpendGuard)

    def test_probe_live_client_is_guarded(self, monkeypatch, tmp_path):
        import memripal.meta_client
        import memripal.probe

        monkeypatch.setenv("META_API_KEY", META_KEY)
        built: list[dict] = []
        monkeypatch.setattr(
            memripal.meta_client, "MetaClient", lambda key, **kw: built.append(kw) or object()
        )
        monkeypatch.setattr(memripal.probe, "run_probe", lambda *a, **kw: {"kept_count": 0, "checks": {}})
        photo = tmp_path / "p.jpg"
        photo.write_bytes(PHOTO)

        assert _load_script("probe_live").main(["--photo", str(photo), "--out", str(tmp_path / "out")]) == 0
        assert isinstance(built[0].get("spend_guard"), MetaSpendGuard)


def _load_script(name: str):
    spec = importlib.util.spec_from_file_location(f"{name}_under_test_121", REPO / "scripts" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TestRetriesChargePerAttempt:
    @pytest.mark.parametrize("kind", ["chat", "segment", "asr"])
    def test_500_with_two_retries_costs_three_calls(self, tmp_path, kind):
        net = _Net(status=500)
        guard = MetaSpendGuard(tmp_path / "spend", cap_usd=100.0)

        result = _call(_client(guard, net, max_retries=2), kind)

        assert not result.ok
        assert len(net.requests) == 3
        assert guard.spent_usd == pytest.approx(3 * COSTS[kind])

    def test_retry_past_the_cap_is_refused_unsent(self, tmp_path):
        net = _Net(status=500)
        guard = MetaSpendGuard(tmp_path / "spend", cap_usd=CALL_COST_USD["segment"] * 2.5)

        with pytest.raises(MetaSpendCapReached):
            _call(_client(guard, net, max_retries=2), "segment")

        assert len(net.requests) == 2
        assert guard.spent_usd == pytest.approx(2 * CALL_COST_USD["segment"])

    @pytest.mark.parametrize("kind", ["image_edit", "image_generate"])
    def test_unretried_image_calls_charge_once(self, tmp_path, kind):
        net = _Net(status=500)
        guard = MetaSpendGuard(tmp_path / "spend", cap_usd=100.0)
        _call(_client(guard, net, max_retries=2), kind)
        assert len(net.requests) == 1
        assert guard.spent_usd == pytest.approx(COSTS[kind])


def _spark_request(subject: str = "phrases") -> ModelRequest:
    return ModelRequest(
        method="spark_json",
        image_jpeg=PHOTO,
        subject=subject,
        attempt=0,
        model="muse-spark-1.3",
        prompt_template_id="phrase",
        gen_params={},
        schema=None,
    )


class _Raising:
    """A live backend whose every call raises `exc`; counts calls."""

    mode = "meta"

    def __init__(self, exc: BaseException):
        self.exc = exc
        self.calls = 0

    def call(self, req):
        self.calls += 1
        raise self.exc


class TestWithSavedResults:
    def _wrapped(self, roots, exc=None):
        from memripal.spend_degrade import with_saved_results

        return with_saved_results(_Raising(exc or MetaSpendCapReached("cap")), roots)

    def test_capped_call_replays_the_first_root_holding_it(self, tmp_path):
        req = _spark_request()
        ResponseCache(tmp_path / "second").put(req.cache_key(), b'{"from": "second"}')
        ResponseCache(tmp_path / "third").put(req.cache_key(), b'{"from": "third"}')

        backend = self._wrapped([tmp_path / "first", tmp_path / "second", tmp_path / "third"])

        assert backend.call(req) == {"from": "second"}
        assert backend.mode == "meta"

    @pytest.mark.parametrize(
        ("method", "stored", "expected"),
        [("segment", b"<|box|>", "<|box|>"), ("image_edit", WEBP_SMALL, WEBP_SMALL)],
    )
    def test_each_method_decodes_like_fixture_replay(self, tmp_path, method, stored, expected):
        req = ModelRequest(method, PHOTO, "s", 0, "m", "t", {}, None)
        ResponseCache(tmp_path).put(req.cache_key(), stored)
        assert self._wrapped([tmp_path]).call(req) == expected

    def test_miss_reraises_the_cap(self, tmp_path):
        with pytest.raises(MetaSpendCapReached):
            self._wrapped([tmp_path]).call(_spark_request())

    def test_other_failures_are_not_masked(self, tmp_path):
        req = _spark_request()
        ResponseCache(tmp_path).put(req.cache_key(), b"{}")
        with pytest.raises(BackendCallFailed) as exc:
            self._wrapped([tmp_path], BackendCallFailed("500 server_error")).call(req)
        assert not isinstance(exc.value, MetaSpendCapReached)


def _capped_backend(tmp_path, net, chat_fallback=None) -> MetaBackend:
    guard = MetaSpendGuard(tmp_path / "spend", cap_usd=0.0)
    return MetaBackend(META_KEY, client=_client(guard, net), chat_fallback=chat_fallback)


def _loci(client, photo=None):
    return client.post("/loci", content=photo or _jpeg(), headers={"Content-Type": "image/jpeg"})


def _split(client):
    body = {"photo": base64.b64encode(PHOTO).decode(), "mode": "notes", "text": NOTES, "loci_count": 3}
    return client.post("/split", json=body)


def _associate(client):
    return client.post("/associate", json=associate_body())


def _scenes(client):
    return client.post("/scenes", json=scenes_body())


def _station(client):
    return client.post("/station", content=_jpeg(), headers={"Content-Type": "image/jpeg"})


def _recall(client):
    return client.post(
        "/recall/audio", json={"audio": base64.b64encode(_wav()).decode(), "keywords": ["lamp"]}
    )


ROUTES = {"loci": _loci, "split": _split, "associate": _associate, "station": _station, "recall": _recall}


class TestCappedRoutesNameTheCap:
    def _app(self, tmp_path, net):
        asr = _client(MetaSpendGuard(tmp_path / "spend", cap_usd=0.0), net)
        app = create_app(
            backend=_capped_backend(tmp_path, net), asr_client=asr, saved_roots=[tmp_path / "none"]
        )
        return TestClient(app, base_url=LOOPBACK_URL)

    @pytest.mark.parametrize("route", sorted(ROUTES))
    def test_route_returns_the_cap_code_never_502(self, tmp_path, route):
        net = _Net()

        resp = ROUTES[route](self._app(tmp_path, net))

        assert resp.status_code == 503, resp.text
        assert resp.json() == {"error": CAP_ERROR_CODE}
        assert resp.headers.get(SPEND_HEADER) == "capped"
        assert net.requests == []

    def test_scenes_tier3_names_the_cap(self, tmp_path):
        net = _Net()

        resp = _scenes(self._app(tmp_path, net))

        assert resp.status_code == 200, resp.text
        assert resp.json() == {"tier": 3, "reason": CAP_ERROR_CODE}
        assert resp.headers.get(SPEND_HEADER) == "capped"
        assert net.requests == []


class _Recorder:
    """Live stand-in: answers via `answer(req)`, storing the raw reply under its key like write-through."""

    mode = "meta"

    def __init__(self, answer, root):
        self.answer = answer
        self.cache = ResponseCache(root)

    def call(self, req):
        value = self.answer(req)
        body = value if isinstance(value, bytes) else json.dumps(value).encode("utf-8")
        self.cache.put(req.cache_key(), body)
        return value


class TestCappedRoutesServeSavedResults:
    @pytest.mark.parametrize(
        ("route", "answer"),
        [
            (_split, lambda req: SPLIT_REPLY),
            (_associate, echo_record),
            (_scenes, lambda req: WEBP_SMALL),
        ],
    )
    def test_saved_answer_is_served_under_the_cap(self, tmp_path, route, answer):
        saved = tmp_path / "live"
        recorded = route(
            TestClient(create_app(backend=_Recorder(answer, saved), saved_roots=()), base_url=LOOPBACK_URL)
        )
        assert recorded.status_code == 200, recorded.text
        net = _Net()
        app = create_app(backend=_capped_backend(tmp_path, net), saved_roots=[tmp_path / "empty", saved])

        resp = route(TestClient(app, base_url=LOOPBACK_URL))

        assert resp.status_code == 200, resp.text
        assert resp.json() == recorded.json()
        assert resp.headers.get(SPEND_HEADER) == "saved"
        assert net.requests == []

    def test_demo_loci_replay_from_the_fixture_tree(self, tmp_path):
        demo = DEMO_PHOTO.read_bytes()
        expected = _loci(
            TestClient(create_app(backend=FixtureBackend(REPLAY_DIR)), base_url=LOOPBACK_URL), demo
        )
        assert expected.status_code == 200, expected.text
        net = _Net()
        app = create_app(backend=_capped_backend(tmp_path, net), saved_roots=[tmp_path / "live", REPLAY_DIR])

        resp = _loci(TestClient(app, base_url=LOOPBACK_URL), demo)

        assert resp.status_code == 200, resp.text
        assert resp.json() == expected.json()
        assert resp.headers.get(SPEND_HEADER) == "saved"
        assert net.requests == []


class TestCappedChatUsesTheBackup:
    def test_split_answers_via_baseten_and_says_so(self, tmp_path):
        net = _Net(chat_content=SPLIT_REPLY)
        fallback = ChatProvider(
            "baseten",
            MetaClient(
                BASETEN_KEY, base_url="https://inference.baseten.co/v1", transport=httpx.MockTransport(net)
            ),
            "meta-models/muse-spark-open-1026",
        )
        app = create_app(backend=_capped_backend(tmp_path, net, fallback), saved_roots=())

        resp = _split(TestClient(app, base_url=LOOPBACK_URL))

        assert resp.status_code == 200, resp.text
        assert resp.headers.get(SPEND_HEADER) == "backup"
        assert net.to_host("api.meta.ai") == []
        assert len(net.to_host("inference.baseten.co")) == 1


class TestNoCapPathUnchanged:
    def test_under_cap_route_carries_no_spend_header(self, tmp_path):
        saved = tmp_path / "live"
        resp = _split(
            TestClient(create_app(backend=_Recorder(lambda r: SPLIT_REPLY, saved)), base_url=LOOPBACK_URL)
        )
        assert resp.status_code == 200
        assert SPEND_HEADER not in resp.headers

    def test_fixture_mode_is_not_wrapped(self):
        app = create_app(backend=FixtureBackend(REPLAY_DIR))
        assert TestClient(app, base_url=LOOPBACK_URL).get("/healthz").json()["mode"] == "fixture"


class TestSpendCapHeaderMiddleware:
    def test_most_severe_state_wins_and_outside_a_request_is_a_noop(self):
        from fastapi import FastAPI
        from fastapi.responses import PlainTextResponse

        from memripal import spend_degrade as sd

        assert sd.HEADER == SPEND_HEADER
        sd.note_spend_cap("capped")  # outside any request: dropped, never leaks into the next one
        app = FastAPI()
        app.add_middleware(sd.SpendCapHeader)

        @app.get("/{states}")
        def noted(states: str):
            for state in filter(None, states.split(",")):
                sd.note_spend_cap(state)
            return PlainTextResponse("ok")

        client = TestClient(app)
        assert client.get("/backup,saved").headers[SPEND_HEADER] == "saved"
        assert client.get("/saved,capped,backup").headers[SPEND_HEADER] == "capped"
        assert client.get("/backup").headers[SPEND_HEADER] == "backup"
        assert SPEND_HEADER not in client.get("/,").headers
