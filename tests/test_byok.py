# Covers: MEM-122
# Requirement: bring your own key (BYOK), offered only once the Meta spend cap is hit (MEM-122).
# Kev, 2026-11-04: "it should tell user yes they can add their own key if they need to have it keep running,
# but should have a hard limit on it and to not reuse it afterwards (delete key after done)".
# - The key rides only in header X-Memripal-Meta-Key, only on the 5 model routes (/loci, /split, /associate,
#   /scenes, /recall/audio). The server builds a fresh per-request MetaBackend + MetaClient + its own
#   MetaSpendGuard under <spend dir>/byok/<HMAC(record key, key)> (MEMRIPAL_BYOK_SPEND_CAP_USD, default 5):
#   the shared backend, guard and ASR client are never touched; no Baseten fallback, no shared live cache
#   writes, no MEM-034 call budget; the rate limiter and passcode still apply.
# - Empty, whitespace, non-ASCII, repeated or >512-char keys get 400 bad_meta_key before any upstream call.
# - Upstream 401/403/404 for the key -> 502 byok_key_rejected and header X-Memripal-Byok: rejected:<model>;
#   the key's own limit -> 503 byok_limit_reached and X-Memripal-Byok: limit.
# - The key is never logged, cached, persisted, echoed, or sent to any host but Meta's API.
import base64
import hashlib
import io
import json
import logging
import re
import threading
import wave
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from test_associate_api import _body as associate_body
from test_associate_api import good_record
from test_record_sign import KEY, KEY_ENV
from test_scenes_api import WEBP_SMALL
from test_scenes_api import _body as scenes_body
from test_split_notes import GOOD_REPLY as SPLIT_REPLY
from test_split_notes import NOTES, PHOTO

import memripal.app as app_module
from memripal.app import create_app
from memripal.backend import MetaBackend
from memripal.chat_provider import ChatProvider
from memripal.meta_client import DEFAULT_BASE_URL, MetaClient
from memripal.meta_spend_guard import (
    SPEND_CAP_ENV,
    SPEND_DIR_ENV,
    STATE_FILE,
    MetaSpendCapReached,
    MetaSpendGuard,
)

LOOPBACK_URL = "http://127.0.0.1"
META_HOST = httpx.URL(DEFAULT_BASE_URL).host
KEY_HEADER = "X-Memripal-Meta-Key"
OUTCOME_HEADER = "X-Memripal-Byok"
# Built by concatenation so this file never matches the pre-commit secret scanner (MEM-004).
KEV_KEY = "fake" + "-kev-" + "k" * 24
USER_KEY = "fake" + "-user-" + "u7Q" * 10
OTHER_KEY = "fake" + "-other-" + "o" * 24
BASETEN_KEY = "fake" + "-baseten-" + "b" * 24
BYOK_ENV = "MEMRIPAL_BYOK_SPEND_CAP_USD"
CHAT_REPLIES = {"phrases": {"phrases": ["lamp", "chair", "book"]}, "association": good_record()}


def _wav() -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"\x00" * 3200)
    return buf.getvalue()


class _Net:
    """The whole network: records each request; answers by path, or `status` echoing the caller's key."""

    def __init__(self, status: int = 200, barrier: threading.Barrier | None = None):
        self.status = status
        self.barrier = barrier
        self.requests: list[httpx.Request] = []
        self._lock = threading.Lock()

    def __call__(self, request: httpx.Request) -> httpx.Response:
        request.read()
        with self._lock:
            self.requests.append(request)
        if self.barrier is not None:
            self.barrier.wait()
        if self.status != 200:
            # Like a real 401: the upstream message quotes the key it was sent.
            sent = request.headers.get("Authorization", "")
            body = {"error": {"code": "invalid_api_key", "message": f"Incorrect API key provided: {sent}"}}
            return httpx.Response(self.status, json=body, headers={"X-Echo": sent})
        path = request.url.path
        if path.endswith("/chat/completions"):
            name = json.loads(request.content)["response_format"]["json_schema"]["name"]
            content = CHAT_REPLIES.get(name, SPLIT_REPLY)
            return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(content)}}]})
        if path.endswith("/responses"):
            return httpx.Response(200, json={"output_text": ""})
        if path.endswith("/asr/transcribe"):
            return httpx.Response(200, json={"transcript": "hello"})
        if path.startswith("/v1/images/"):
            return httpx.Response(200, json={"data": [{"b64_json": base64.b64encode(WEBP_SMALL).decode()}]})
        return httpx.Response(404, json={"error": {"code": "not_found"}})

    def bearers(self) -> list[str]:
        return [r.headers.get("Authorization", "") for r in self.requests]


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch, tmp_path):
    for name in (
        SPEND_CAP_ENV,
        SPEND_DIR_ENV,
        BYOK_ENV,
        "MEMRIPAL_MODE",
        "META_API_KEY",
        "MEMRIPAL_PASSCODE",
        "MEMRIPAL_CALL_BUDGET",
        "MEMRIPAL_ACCESS_KEY",
        "MEMRIPAL_ALLOWED_HOSTS",
        "MEMRIPAL_RATE_PER_MIN",
    ):
        monkeypatch.delenv(name, raising=False)  # fmt: skip
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("USERPROFILE", str(tmp_path / "home"))
    monkeypatch.setenv(KEY_ENV, KEY)
    monkeypatch.setenv(SPEND_DIR_ENV, str(tmp_path / "spend"))
    # The shared live cache: BYOK answers must never land here.
    monkeypatch.setattr(app_module, "LIVE_CACHE_DIR", tmp_path / "live")


def _app(tmp_path, net, *, shared_guard=None, chat_fallback=None, byok_net=None):
    """A live app whose shared backend and ASR client use Kev's key; BYOK clients reach `byok_net`."""
    transport = httpx.MockTransport(net)
    guard = shared_guard or MetaSpendGuard(tmp_path / "spend", cap_usd=100.0)
    kev = MetaClient(KEV_KEY, transport=transport, max_retries=0, spend_guard=guard)
    shared = MetaBackend(KEV_KEY, client=kev, chat_fallback=chat_fallback, cache_root=tmp_path / "live")
    asr = MetaClient(KEV_KEY, transport=transport, max_retries=0, spend_guard=guard)
    byok_transport = httpx.MockTransport(byok_net or net)
    return create_app(backend=shared, asr_client=asr, saved_roots=(), byok_transport=byok_transport)


def _split(client, headers=None):
    body = {"photo": base64.b64encode(PHOTO).decode(), "mode": "notes", "text": NOTES, "loci_count": 3}
    return client.post("/split", json=body, headers=headers or {})


def _loci(client, headers=None):
    return client.post("/loci", content=PHOTO, headers={"Content-Type": "image/jpeg", **(headers or {})})


def _associate(client, headers=None):
    return client.post("/associate", json=associate_body(), headers=headers or {})


def _scenes(client, headers=None):
    return client.post("/scenes", json=scenes_body(), headers=headers or {})


def _recall(client, headers=None):
    body = {"audio": base64.b64encode(_wav()).decode(), "keywords": ["lamp"]}
    return client.post("/recall/audio", json=body, headers=headers or {})


ROUTES = {"loci": _loci, "split": _split, "associate": _associate, "scenes": _scenes, "recall": _recall}


def _files_under(root: Path) -> list[Path]:
    return [p for p in root.rglob("*") if p.is_file()] if root.exists() else []


def _assert_no_key_under(root: Path, key: str) -> None:
    for path in _files_under(root):
        assert key not in str(path)
        assert key.encode() not in path.read_bytes(), path


class TestKeyValidation:
    def test_constants(self):
        from memripal import byok

        assert byok.HEADER == KEY_HEADER
        assert byok.OUTCOME_HEADER == OUTCOME_HEADER
        assert byok.CAP_ENV == BYOK_ENV
        assert byok.DEFAULT_CAP_USD == 5.0
        assert byok.MAX_KEY_CHARS == 512

    @pytest.mark.parametrize(
        "raw", ["", " ", "abc def", "abc\tdef", " abc", "abc ", "x" * 513, "kéy", "k\x00y", "k\x7fy"]
    )
    def test_bad_keys_rejected(self, raw):
        from memripal.byok import key_ok

        assert key_ok(raw) is False

    @pytest.mark.parametrize("raw", ["k", "x" * 512, USER_KEY, "LLM|abc.def-123_~!"])
    def test_good_keys_accepted(self, raw):
        from memripal.byok import key_ok

        assert key_ok(raw) is True


# Criterion 2: a malformed key is refused before any upstream call, and never falls back to Kev's key.
class TestBadKeyHeader:
    @pytest.mark.parametrize("route", sorted(ROUTES))
    @pytest.mark.parametrize("raw", ["", "   ", "a b", "x" * 513, "kéy".encode("latin-1")])
    def test_400_and_no_request_at_all(self, tmp_path, route, raw):
        net = _Net()
        client = TestClient(_app(tmp_path, net), base_url=LOOPBACK_URL)

        resp = ROUTES[route](client, {KEY_HEADER: raw})

        assert resp.status_code == 400, resp.text
        assert resp.json() == {"error": "bad_meta_key"}
        assert resp.headers.get(OUTCOME_HEADER) == "invalid"
        assert net.requests == []
        assert f"Bearer {KEV_KEY}" not in net.bearers()

    def test_repeated_header_is_refused(self, tmp_path):
        net = _Net()
        client = TestClient(_app(tmp_path, net), base_url=LOOPBACK_URL)
        resp = client.post(
            "/split",
            json={"photo": base64.b64encode(PHOTO).decode(), "mode": "notes", "text": NOTES, "loci_count": 3},
            headers=[(KEY_HEADER, USER_KEY), (KEY_HEADER, OTHER_KEY)],
        )
        assert resp.status_code == 400
        assert net.requests == []

    def test_passcode_still_comes_first(self, tmp_path, monkeypatch):
        monkeypatch.setenv("MEMRIPAL_PASSCODE", "open-sesame")
        net = _Net()
        resp = _split(TestClient(_app(tmp_path, net), base_url=LOOPBACK_URL), {KEY_HEADER: USER_KEY})
        assert resp.status_code == 401
        assert net.requests == []


# Criterion 1: concurrent requests each carry their own Bearer; the shared singleton is never re-keyed.
class TestPerRequestKey:
    def test_concurrent_byok_and_shared_each_carry_own_bearer(self, tmp_path):
        net = _Net(barrier=threading.Barrier(2, timeout=10))
        app = _app(tmp_path, net)
        results: dict[str, httpx.Response] = {}

        def run(name, headers):
            with TestClient(app, base_url=LOOPBACK_URL) as client:
                results[name] = _split(client, headers)

        threads = [
            threading.Thread(target=run, args=("byok", {KEY_HEADER: USER_KEY})),
            threading.Thread(target=run, args=("shared", None)),
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=20)

        assert results["byok"].status_code == 200, results["byok"].text
        assert results["shared"].status_code == 200, results["shared"].text
        assert sorted(net.bearers()) == sorted([f"Bearer {USER_KEY}", f"Bearer {KEV_KEY}"])
        assert {r.url.host for r in net.requests} == {META_HOST}

    @pytest.mark.parametrize("route", ["loci", "split", "associate", "scenes", "recall"])
    def test_each_model_route_uses_the_key_on_meta_only(self, tmp_path, route):
        net = _Net()
        resp = ROUTES[route](TestClient(_app(tmp_path, net), base_url=LOOPBACK_URL), {KEY_HEADER: USER_KEY})

        assert resp.status_code == 200, resp.text
        assert net.requests, "the route made no upstream call"
        assert set(net.bearers()) == {f"Bearer {USER_KEY}"}
        assert {r.url.host for r in net.requests} == {META_HOST}
        assert OUTCOME_HEADER not in resp.headers

    def test_byok_never_uses_the_backup_chat_provider(self, tmp_path):
        net = _Net()
        baseten = _Net()
        fallback = ChatProvider(
            "baseten", MetaClient(BASETEN_KEY, transport=httpx.MockTransport(baseten)), "some-model"
        )
        capped = MetaSpendGuard(tmp_path / "shared-spend", cap_usd=0.0)
        app = _app(tmp_path, net, shared_guard=capped, chat_fallback=fallback)

        resp = _split(TestClient(app, base_url=LOOPBACK_URL), {KEY_HEADER: USER_KEY})

        assert resp.status_code == 200, resp.text
        assert baseten.requests == []
        assert set(net.bearers()) == {f"Bearer {USER_KEY}"}
        # The shared guard was never charged by the BYOK request.
        assert capped.spent_usd == 0.0

    def test_byok_skips_the_call_budget(self, tmp_path, monkeypatch):
        monkeypatch.setenv("MEMRIPAL_CALL_BUDGET", "0")
        net = _Net()
        client = TestClient(_app(tmp_path, net), base_url=LOOPBACK_URL)

        assert _split(client).status_code == 429
        assert _recall(client).status_code == 429
        assert _split(client, {KEY_HEADER: USER_KEY}).status_code == 200
        assert _recall(client, {KEY_HEADER: USER_KEY}).status_code == 200

    def test_byok_keeps_the_rate_limiter(self, tmp_path, monkeypatch):
        monkeypatch.setenv("MEMRIPAL_RATE_PER_MIN", "1")
        net = _Net()
        client = TestClient(_app(tmp_path, net), base_url=LOOPBACK_URL)

        assert _split(client, {KEY_HEADER: USER_KEY}).status_code == 200
        assert _split(client, {KEY_HEADER: USER_KEY}).status_code == 429

    def test_byok_answers_never_reach_the_shared_live_cache(self, tmp_path):
        net = _Net()
        resp = _split(TestClient(_app(tmp_path, net), base_url=LOOPBACK_URL), {KEY_HEADER: USER_KEY})
        assert resp.status_code == 200
        assert _files_under(tmp_path / "live") == []

    def test_spend_state_lives_under_an_hmac_named_dir(self, tmp_path):
        net = _Net()
        for key in (USER_KEY, USER_KEY, OTHER_KEY):
            client = TestClient(_app(tmp_path, net), base_url=LOOPBACK_URL)
            assert _split(client, {KEY_HEADER: key}).status_code == 200
        dirs = sorted(p.name for p in (tmp_path / "spend" / "byok").iterdir())
        assert len(dirs) == 2  # stable per key across app instances, distinct across keys
        for name in dirs:
            assert re.fullmatch(r"[0-9a-f]{64}", name)
            assert name != hashlib.sha256(USER_KEY.encode()).hexdigest()  # keyed, not a bare hash


# Criterion 3: an upstream 401 that echoes the key leaks it nowhere.
class TestKeyNeverLeaks:
    @pytest.mark.parametrize("route", sorted(ROUTES))
    @pytest.mark.parametrize("status", [401, 403, 404])
    def test_rejected_key_names_the_model_and_leaks_nothing(
        self, tmp_path, monkeypatch, caplog, route, status
    ):
        seen_requests = []
        real_call = MetaBackend.call
        monkeypatch.setattr(
            MetaBackend, "call", lambda self, req: seen_requests.append(req) or real_call(self, req)
        )
        caplog.set_level(logging.DEBUG)
        net = _Net(status=status)

        resp = ROUTES[route](TestClient(_app(tmp_path, net), base_url=LOOPBACK_URL), {KEY_HEADER: USER_KEY})

        assert net.requests, "no upstream call was made"
        assert set(net.bearers()) == {f"Bearer {USER_KEY}"}
        outcome = resp.headers.get(OUTCOME_HEADER, "")
        assert re.fullmatch(r"rejected:[a-z0-9][a-z0-9.\-]{0,63}", outcome), outcome
        if route != "scenes":  # /scenes always answers 200 with a tier
            assert resp.status_code == 502, resp.text
            assert resp.json() == {"error": "byok_key_rejected"}
        for text in (resp.text, json.dumps(dict(resp.headers)), caplog.text):
            assert USER_KEY not in text
        _assert_no_key_under(tmp_path / "live", USER_KEY)
        _assert_no_key_under(tmp_path / "spend", USER_KEY)
        for req in seen_requests:
            assert USER_KEY not in json.dumps(req.gen_params, default=str)
            assert USER_KEY not in repr(req)

    def test_header_names_the_model_the_key_cannot_use(self, tmp_path):
        net = _Net(status=401)
        resp = _split(TestClient(_app(tmp_path, net), base_url=LOOPBACK_URL), {KEY_HEADER: USER_KEY})
        assert resp.headers[OUTCOME_HEADER] == "rejected:muse-spark-1.3"
        resp = _recall(TestClient(_app(tmp_path, net), base_url=LOOPBACK_URL), {KEY_HEADER: USER_KEY})
        assert resp.headers[OUTCOME_HEADER] == "rejected:muse-voice-transcribe-1.0"

    def test_client_and_backend_reprs_hide_the_key(self):
        from memripal.byok import open_session

        session = open_session(USER_KEY, secret=KEY.encode(), spend_root=Path("unused"), cap_usd=5.0)
        try:
            for obj in (session, session.backend, session.asr_client, session.outcome):
                assert USER_KEY not in repr(obj)
                assert USER_KEY not in str(obj)
        finally:
            session.close()


# Criterion 4: the key's own hard limit holds across guards and stores no part of the key.
class TestByokLimit:
    def test_same_key_under_a_new_guard_stays_capped(self, tmp_path):
        from memripal.byok import byok_guard

        secret = KEY.encode()
        guard = byok_guard(USER_KEY, secret=secret, spend_root=tmp_path / "spend", cap_usd=0.05)
        guard.charge("chat")
        guard.charge("chat")
        with pytest.raises(MetaSpendCapReached):
            guard.charge("chat")

        again = byok_guard(USER_KEY, secret=secret, spend_root=tmp_path / "spend", cap_usd=0.05)
        with pytest.raises(MetaSpendCapReached):
            again.charge("chat")

        other = byok_guard(OTHER_KEY, secret=secret, spend_root=tmp_path / "spend", cap_usd=0.05)
        other.charge("chat")  # a different key has its own limit

        states = [p for p in _files_under(tmp_path / "spend") if p.name == STATE_FILE]
        assert len(states) == 2
        for path in states:
            content = path.read_text("ascii")
            rel = str(path.relative_to(tmp_path))
            for i in range(len(USER_KEY) - 5):
                window = USER_KEY[i : i + 6]
                assert window not in content
                assert window not in rel

    def test_cap_defaults_to_five_dollars_and_reads_the_env(self, tmp_path, monkeypatch):
        from memripal.byok import byok_guard, cap_from_env

        assert cap_from_env() == 5.0
        monkeypatch.setenv(BYOK_ENV, "0.5")
        assert cap_from_env() == 0.5
        monkeypatch.setenv(BYOK_ENV, "-1")
        with pytest.raises(ValueError):
            cap_from_env()
        guard = byok_guard(USER_KEY, secret=b"s", spend_root=tmp_path, cap_usd=5.0)
        assert guard.cap_usd == 5.0

    def test_route_at_the_limit_says_limit_and_sends_nothing(self, tmp_path, monkeypatch):
        monkeypatch.setenv(BYOK_ENV, "0")
        net = _Net()
        shared_guard = MetaSpendGuard(tmp_path / "spend", cap_usd=100.0)
        client = TestClient(_app(tmp_path, net, shared_guard=shared_guard), base_url=LOOPBACK_URL)

        for route in ("split", "recall"):
            resp = ROUTES[route](client, {KEY_HEADER: USER_KEY})
            assert resp.status_code == 503, resp.text
            assert resp.json() == {"error": "byok_limit_reached"}
            assert resp.headers[OUTCOME_HEADER] == "limit"
            # The shared toast state is about Kev's credit, not this key's limit.
            assert "X-Memripal-Spend-Cap" not in resp.headers
        resp = _scenes(client, {KEY_HEADER: USER_KEY})
        assert resp.headers[OUTCOME_HEADER] == "limit"
        assert net.requests == []
        assert shared_guard.spent_usd == 0.0


# Criterion 5: without the header nothing changes.
class TestNoKeyPathUnchanged:
    @pytest.mark.parametrize("route", sorted(ROUTES))
    def test_no_header_uses_kevs_key_and_shared_cache(self, tmp_path, route):
        net = _Net()
        resp = ROUTES[route](TestClient(_app(tmp_path, net), base_url=LOOPBACK_URL))

        assert resp.status_code == 200, resp.text
        assert set(net.bearers()) == {f"Bearer {KEV_KEY}"}
        assert OUTCOME_HEADER not in resp.headers
        assert not (tmp_path / "spend" / "byok").exists()

    def test_fixture_mode_ignores_the_header(self, tmp_path):
        client = TestClient(create_app(saved_roots=()), base_url=LOOPBACK_URL)
        resp = _split(client, {KEY_HEADER: USER_KEY})
        assert resp.status_code != 400
        assert OUTCOME_HEADER not in resp.headers


class TestCors:
    def test_capacitor_may_send_the_key_and_read_the_outcome(self):
        from memripal import cors

        assert KEY_HEADER in cors.ALLOWED_HEADERS
        from fastapi import FastAPI

        app = FastAPI()
        cors.add_cors(app)
        mw = next(m for m in app.user_middleware if "CORS" in m.cls.__name__)
        assert OUTCOME_HEADER in mw.kwargs["expose_headers"]
