# Covers: MEM-034
"""Contract for the S7 deploy-lite runtime guards (plan S7, D1, ADR 0004/0010). All knobs are env vars
read once at create_app() time:

- MEMRIPAL_ALLOWED_HOSTS: comma-separated hosts added to the loopback allowlist (Cloud Run host).
- MEMRIPAL_PASSCODE: live-mode passcode; surrounding whitespace (the Secret Manager trailing newline) is
  stripped, and a blank value counts as unset. Clients send it in the X-Memripal-Passcode header; the
  server compares with hmac.compare_digest.
- Gate: when the backend is live (backend.mode != "fixture") every model-calling route (/loci, /split,
  /associate, and /scenes or /recall/audio once they exist) answers 401 {"error": "passcode_required"}
  before reading the body or calling the model, unless the header matches. With no passcode configured,
  live requests on a loopback host pass (scripts/run_live.ps1 local use) and on any other host get 401
  (fail closed). Fixture mode is never gated; /healthz, / and /demo/* are never gated.
- MEMRIPAL_CALL_BUDGET: per-instance cap on live model calls (backend.call). A call past the cap never
  reaches the backend and the request answers 429 {"error": "budget_exhausted"}. Fixture calls are free
  and never counted. Non-integer or negative -> create_app raises ValueError; 0 refuses every live call.
- MEMRIPAL_MAX_BODY_BYTES: app-wide request body cap applied before any route cap; a Content-Length or a
  streamed body past it -> 413 {"error": "too_large"}. Non-integer or < 1 -> ValueError.
"""

import base64
import io
import json
import socket

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from memripal.app import create_app
from memripal.backend import PROMPT_ARGS

LOOPBACK_URL = "http://127.0.0.1"
PUBLIC_HOST = "memripal-abc123-uc.a.run.app"
PUBLIC_URL = f"https://{PUBLIC_HOST}"
PASSCODE = "correct-horse-battery"
HEADER = "X-Memripal-Passcode"
ENV_VARS = (
    "MEMRIPAL_MODE",
    "META_API_KEY",
    "MEMRIPAL_PASSCODE",
    "MEMRIPAL_CALL_BUDGET",
    "MEMRIPAL_MAX_BODY_BYTES",
    "MEMRIPAL_ALLOWED_HOSTS",
)
NOTES = "First, our budget doubled this year. Second, the new library opens in May."
SPLIT_REPLY = {"points": [{"label": "budget", "source_quote": "our budget doubled this year"}]}


def _jpeg(w: int = 64, h: int = 48) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (90, 60, 30)).save(buf, "JPEG")
    return buf.getvalue()


PHOTO = _jpeg()


def _record(req) -> dict:
    args = req.gen_params[PROMPT_ARGS]
    item, locus = args["item"], args["locus"]
    channels = ("kinesthetic", "auditory", "visual", "emotional", "conceptual", "olfactory", "gustatory")
    rec = {c: f"A vivid {item} moment." for c in channels}
    rec.update(
        item=item,
        locus=locus,
        spatial=f"It sits on the {locus}.",
        scene_prompt_details="giant, dramatic light",
        walk_cue="Look up.",
        reencode_hint="Hear it.",
        question="Why?",
        answer="Because.",
    )
    return rec


class LiveStub:
    """A live (non-fixture) ModelBackend stand-in: answers split and associate calls, counts calls."""

    mode = "meta"

    def __init__(self):
        self.calls = 0

    def call(self, req):
        self.calls += 1
        if req.prompt_template_id == "association":
            return _record(req)
        return json.loads(json.dumps(SPLIT_REPLY))


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch, tmp_path):
    for name in ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("USERPROFILE", str(tmp_path / "home"))


def _split_body() -> bytes:
    body = {"photo": base64.b64encode(PHOTO).decode("ascii"), "mode": "notes", "text": NOTES, "loci_count": 3}
    return json.dumps(body).encode("utf-8")


def _assoc_body() -> bytes:
    body = {"image": "data:image/jpeg;base64," + base64.b64encode(PHOTO).decode("ascii"), "item": "milk",
            "locus": "left book"}  # fmt: skip
    return json.dumps(body).encode("utf-8")


# (route, content type, valid body for a live call)
MODEL_ROUTES = [
    ("/loci", "image/jpeg", PHOTO),
    ("/split", "application/json", _split_body()),
    ("/associate", "application/json", _assoc_body()),
    ("/scenes", "application/json", b"{}"),
    ("/recall/audio", "audio/wav", b"RIFF"),
]


def _has_route(app, path: str) -> bool:
    return any(getattr(r, "path", None) == path for r in app.routes)


def _client(backend, base_url: str = LOOPBACK_URL, **kw) -> TestClient:
    return TestClient(create_app(backend=backend), base_url=base_url, **kw)


def _post(client, route, content_type, body, passcode=None):
    headers = {"Content-Type": content_type}
    if passcode is not None:
        headers[HEADER] = passcode
    return client.post(route, content=body, headers=headers)


def _assert_401(resp) -> None:
    assert resp.status_code == 401, resp.text[:300]
    assert resp.json() == {"error": "passcode_required"}
    assert PASSCODE not in resp.text


# Requirement: on the public deploy the Cloud Run host is accepted by the DNS-rebinding guard only when
# listed in MEMRIPAL_ALLOWED_HOSTS; any other non-loopback host is still refused.
class TestAllowedHosts:
    def test_listed_public_host_is_served(self, monkeypatch):
        monkeypatch.setenv("MEMRIPAL_ALLOWED_HOSTS", f"other.example, {PUBLIC_HOST}")
        resp = _client(LiveStub(), PUBLIC_URL).get("/healthz")
        assert resp.status_code == 200, resp.text[:200]

    def test_unlisted_public_host_is_still_refused(self, monkeypatch):
        monkeypatch.setenv("MEMRIPAL_ALLOWED_HOSTS", "other.example")
        resp = _client(LiveStub(), PUBLIC_URL).get("/healthz")
        assert resp.status_code == 400


# Requirement: live mode answers 401 passcode_required on every model-calling route without the correct
# passcode, before any model call, so the public URL can never spend credits without it.
class TestPasscodeGate:
    @pytest.mark.parametrize(
        ("route", "content_type", "body"), MODEL_ROUTES, ids=[r[0] for r in MODEL_ROUTES]
    )
    @pytest.mark.parametrize(
        "sent", [None, "", "wrong-passcode", PASSCODE.upper()], ids=["absent", "empty", "wrong", "case"]
    )
    def test_live_route_without_correct_passcode_is_401_and_calls_no_model(
        self, monkeypatch, route, content_type, body, sent
    ):
        monkeypatch.setenv("MEMRIPAL_PASSCODE", PASSCODE)
        stub = LiveStub()
        app = create_app(backend=stub)
        if not _has_route(app, route):
            pytest.skip(f"{route} is not on this branch yet")
        resp = _post(TestClient(app, base_url=LOOPBACK_URL), route, content_type, body, sent)
        _assert_401(resp)
        assert stub.calls == 0

    @pytest.mark.parametrize("route", ["/split", "/associate"])
    def test_correct_passcode_reaches_the_model(self, monkeypatch, route):
        monkeypatch.setenv("MEMRIPAL_PASSCODE", PASSCODE)
        stub = LiveStub()
        _, content_type, body = next(r for r in MODEL_ROUTES if r[0] == route)
        resp = _post(_client(stub), route, content_type, body, PASSCODE)
        assert resp.status_code == 200, resp.text[:300]
        assert stub.calls >= 1

    def test_secret_manager_trailing_newline_is_stripped(self, monkeypatch):
        monkeypatch.setenv("MEMRIPAL_PASSCODE", PASSCODE + "\n")
        stub = LiveStub()
        resp = _post(_client(stub), "/split", "application/json", _split_body(), PASSCODE)
        assert resp.status_code == 200, resp.text[:300]

    @pytest.mark.parametrize("configured", [None, "", "  \n"], ids=["unset", "empty", "blank"])
    def test_live_on_public_host_without_configured_passcode_fails_closed(self, monkeypatch, configured):
        monkeypatch.setenv("MEMRIPAL_ALLOWED_HOSTS", PUBLIC_HOST)
        if configured is not None:
            monkeypatch.setenv("MEMRIPAL_PASSCODE", configured)
        stub = LiveStub()
        resp = _post(_client(stub, PUBLIC_URL), "/split", "application/json", _split_body(), "")
        _assert_401(resp)
        assert stub.calls == 0

    def test_live_on_loopback_without_configured_passcode_stays_open(self):
        stub = LiveStub()
        resp = _post(_client(stub), "/split", "application/json", _split_body())
        assert resp.status_code == 200, resp.text[:300]

    @pytest.mark.parametrize("path", ["/healthz", "/", "/demo/photo.jpg"])
    def test_public_pages_are_never_gated(self, monkeypatch, path):
        monkeypatch.setenv("MEMRIPAL_PASSCODE", PASSCODE)
        monkeypatch.setenv("MEMRIPAL_ALLOWED_HOSTS", PUBLIC_HOST)
        resp = _client(LiveStub(), PUBLIC_URL).get(path)
        assert resp.status_code == 200, resp.text[:200]


# Requirement: the public demo loop needs no passcode, no key and no network: fixture mode on the
# public host serves the committed demo photo and replays its loci offline.
class TestPublicFixtureDemoLoop:
    def test_demo_loop_on_public_host_without_passcode_key_or_network(self, monkeypatch):
        monkeypatch.setenv("MEMRIPAL_PASSCODE", PASSCODE)
        monkeypatch.setenv("MEMRIPAL_ALLOWED_HOSTS", PUBLIC_HOST)

        attempts = []

        def no_network(sock, address, *args, **kwargs):
            attempts.append(address)
            raise AssertionError(f"fixture demo loop must not open a network connection: {address!r}")

        # The event loop starts first (Windows ProactorEventLoop builds its self-pipe with a loopback
        # socketpair connect); only then is every connect blocked for the request path.
        with _client(None, PUBLIC_URL) as client:
            monkeypatch.setattr(socket.socket, "connect", no_network)
            probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            try:
                probe.settimeout(0.05)
                with pytest.raises(AssertionError):
                    probe.connect(("192.0.2.1", 80))
            finally:
                probe.close()
            attempts.clear()
            assert client.get("/healthz").json()["mode"] == "fixture"
            photo = client.get("/demo/photo.jpg")
            assert photo.status_code == 200, photo.text[:200]
            resp = client.post("/loci", content=photo.content, headers={"Content-Type": "image/jpeg"})
            assert resp.status_code == 200, resp.text[:300]
            assert len(resp.json()["loci"]) >= 10
        assert attempts == []


# Requirement: a per-instance call budget (MEMRIPAL_CALL_BUDGET) refuses live model calls past the cap
# with 429 budget_exhausted, never charges fixture replays, and rejects a malformed cap at startup.
class TestCallBudget:
    def _authed(self, monkeypatch, budget: str):
        monkeypatch.setenv("MEMRIPAL_PASSCODE", PASSCODE)
        monkeypatch.setenv("MEMRIPAL_CALL_BUDGET", budget)
        stub = LiveStub()
        return stub, _client(stub)

    def test_calls_past_the_cap_are_refused_with_429(self, monkeypatch):
        stub, client = self._authed(monkeypatch, "2")
        for _ in range(2):
            assert _post(client, "/split", "application/json", _split_body(), PASSCODE).status_code == 200
        resp = _post(client, "/split", "application/json", _split_body(), PASSCODE)
        assert resp.status_code == 429, resp.text[:300]
        assert resp.json() == {"error": "budget_exhausted"}
        assert stub.calls == 2

    def test_budget_is_shared_across_routes(self, monkeypatch):
        stub, client = self._authed(monkeypatch, "1")
        assert _post(client, "/split", "application/json", _split_body(), PASSCODE).status_code == 200
        resp = _post(client, "/associate", "application/json", _assoc_body(), PASSCODE)
        assert resp.status_code == 429, resp.text[:300]
        assert resp.json() == {"error": "budget_exhausted"}
        assert stub.calls == 1

    def test_zero_budget_refuses_every_live_call(self, monkeypatch):
        stub, client = self._authed(monkeypatch, "0")
        resp = _post(client, "/split", "application/json", _split_body(), PASSCODE)
        assert resp.status_code == 429, resp.text[:300]
        assert stub.calls == 0

    def test_unauthenticated_requests_do_not_consume_budget(self, monkeypatch):
        stub, client = self._authed(monkeypatch, "1")
        for _ in range(3):
            _assert_401(_post(client, "/split", "application/json", _split_body()))
        assert _post(client, "/split", "application/json", _split_body(), PASSCODE).status_code == 200
        assert stub.calls == 1

    def test_fixture_replays_are_never_charged(self, monkeypatch):
        monkeypatch.setenv("MEMRIPAL_CALL_BUDGET", "1")
        client = _client(None)
        photo = client.get("/demo/photo.jpg").content
        for _ in range(2):
            resp = client.post("/loci", content=photo, headers={"Content-Type": "image/jpeg"})
            assert resp.status_code == 200, resp.text[:300]

    @pytest.mark.parametrize("bad", ["abc", "-1", "1.5", ""])
    def test_malformed_budget_fails_at_startup(self, monkeypatch, bad):
        monkeypatch.setenv("MEMRIPAL_CALL_BUDGET", bad)
        with pytest.raises(ValueError):
            create_app(backend=LiveStub())


# Requirement: an app-wide body cap (MEMRIPAL_MAX_BODY_BYTES) refuses any request body past it with 413
# too_large before a route reads it, whether declared by Content-Length or streamed.
class TestGlobalBodyCap:
    def test_declared_length_past_cap_is_413_even_under_route_cap(self, monkeypatch):
        monkeypatch.setenv("MEMRIPAL_MAX_BODY_BYTES", "1024")
        client = _client(None)
        photo = client.get("/demo/photo.jpg").content
        assert len(photo) > 1024
        resp = client.post("/loci", content=photo, headers={"Content-Type": "image/jpeg"})
        assert resp.status_code == 413, resp.text[:300]
        assert resp.json() == {"error": "too_large"}

    def test_streamed_body_past_cap_is_413(self, monkeypatch):
        monkeypatch.setenv("MEMRIPAL_MAX_BODY_BYTES", "1024")
        stub = LiveStub()

        def chunks():
            for _ in range(8):
                yield b"x" * 512

        resp = _client(stub).post("/split", content=chunks(), headers={"Content-Type": "application/json"})
        assert resp.status_code == 413, resp.text[:300]
        assert stub.calls == 0

    def test_body_under_cap_is_served(self, monkeypatch):
        monkeypatch.setenv("MEMRIPAL_MAX_BODY_BYTES", str(64 * 1024))
        resp = _post(_client(LiveStub()), "/split", "application/json", _split_body())
        assert resp.status_code == 200, resp.text[:300]

    @pytest.mark.parametrize("bad", ["abc", "0", "-5", ""])
    def test_malformed_cap_fails_at_startup(self, monkeypatch, bad):
        monkeypatch.setenv("MEMRIPAL_MAX_BODY_BYTES", bad)
        with pytest.raises(ValueError):
            create_app(backend=LiveStub())
