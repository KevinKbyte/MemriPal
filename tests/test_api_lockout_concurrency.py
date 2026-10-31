# Covers: MEM-034
"""Contract (MEM-034 hardening, security audit): failed-passcode lockout, per-route concurrency caps, and
the Cloud Run deploy flags.

- Lockout (live mode with MEMRIPAL_PASSCODE configured): MEMRIPAL_PASSCODE_MAX_FAILS wrong-passcode 401s
  from one client IP within MEMRIPAL_LOCKOUT_S seconds lock that IP: every passcode-gated route then answers
  429 {"error": "too_many_attempts"} with a Retry-After header (whole seconds, >= 1), even with the right
  passcode and before any model call, until the oldest counted failure is MEMRIPAL_LOCKOUT_S old (sliding;
  at exactly that age it has expired). Locked requests are not counted as new failures. Other IPs are
  unaffected. Both env vars: read once at create_app, non-integer or < 1 -> ValueError. Client IP and the
  injected clock (create_app(..., clock=...)) are the same as the rate limiter's (tests/test_api_ratelimit.py).
- Concurrency: POST /loci, /split, /associate, /recall/audio each hold at most MEMRIPAL_ROUTE_CONCURRENCY
  in-flight requests per app instance (the scenes.py bounded-slot pattern). A request that cannot get a slot
  within a bounded wait answers 503 {"error": "busy"} without calling the model or ASR. A slot is released on
  every path. Non-integer or < 1 -> ValueError.
- scripts/deploy_cloud_run.sh passes --concurrency=<int >= 1> and --timeout=<positive seconds> to
  gcloud run deploy.
"""

import base64
import io
import json
import re
import threading
import wave
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from memripal.app import create_app
from memripal.backend import BackendCallFailed
from memripal.meta_client import CallResult

REPO = Path(__file__).resolve().parents[1]
DEPLOY_SCRIPT = REPO / "scripts" / "deploy_cloud_run.sh"
LOOPBACK_URL = "http://127.0.0.1"
PASSCODE = "correct-horse-battery"
HEADER = "X-Memripal-Passcode"
JSON = "application/json"
JOIN_S = 10
ENV_VARS = (
    "MEMRIPAL_MODE",
    "META_API_KEY",
    "MEMRIPAL_PASSCODE",
    "MEMRIPAL_CALL_BUDGET",
    "MEMRIPAL_MAX_BODY_BYTES",
    "MEMRIPAL_ALLOWED_HOSTS",
    "MEMRIPAL_RECORD_KEY",
    "MEMRIPAL_RATE_PER_MIN",
    "MEMRIPAL_PASSCODE_MAX_FAILS",
    "MEMRIPAL_LOCKOUT_S",
    "MEMRIPAL_ROUTE_CONCURRENCY",
    "K_SERVICE",
)
NOTES = "First, our budget doubled this year. Second, the new library opens in May."
SPLIT_REPLY = {"points": [{"label": "budget", "source_quote": "our budget doubled this year"}]}


def _jpeg(w: int = 64, h: int = 48) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (90, 60, 30)).save(buf, "JPEG")
    return buf.getvalue()


PHOTO = _jpeg()
SPLIT_BODY = json.dumps(
    {"photo": base64.b64encode(PHOTO).decode("ascii"), "mode": "notes", "text": NOTES, "loci_count": 3}
).encode("utf-8")
ASSOC_BODY = json.dumps(
    {
        "image": "data:image/jpeg;base64," + base64.b64encode(PHOTO).decode("ascii"),
        "item": "milk",
        "locus": "left book",
    }
).encode("utf-8")


def _wav(frames: int = 1600) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"\x00" * 2 * frames)
    return buf.getvalue()


AUDIO_BODY = json.dumps({"audio": base64.b64encode(_wav()).decode("ascii"), "keywords": ["lamp"]}).encode()

# route -> (content type, body that reaches the model/ASR call)
ROUTE_BODIES = {
    "/loci": ("image/jpeg", PHOTO),
    "/split": (JSON, SPLIT_BODY),
    "/associate": (JSON, ASSOC_BODY),
    "/recall/audio": (JSON, AUDIO_BODY),
}


class FakeClock:
    def __init__(self, now: float = 1000.0):
        self.now = now

    def __call__(self) -> float:
        return self.now


class LiveStub:
    mode = "meta"

    def __init__(self):
        self.calls = 0

    def call(self, req):
        self.calls += 1
        return json.loads(json.dumps(SPLIT_REPLY))


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch, tmp_path):
    for name in ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("USERPROFILE", str(tmp_path / "home"))
    # Rate limiting is covered in test_api_ratelimit.py; keep it out of the way here.
    monkeypatch.setenv("MEMRIPAL_RATE_PER_MIN", "100000")


def _split(client, passcode, xff=None):
    headers = {"Content-Type": JSON, HEADER: passcode}
    if xff is not None:
        headers["X-Forwarded-For"] = xff
    return client.post("/split", content=SPLIT_BODY, headers=headers)


def _assert_locked(resp) -> int:
    assert resp.status_code == 429, resp.text[:300]
    assert resp.json() == {"error": "too_many_attempts"}
    retry = resp.headers.get("Retry-After")
    assert retry is not None and retry.isdigit() and int(retry) >= 1, retry
    return int(retry)


# Requirement: repeated wrong passcodes from one IP lock that IP out (429 too_many_attempts, even with the
# right passcode) for a sliding window, so the shared passcode cannot be brute-forced; other IPs keep working.
class TestPasscodeLockout:
    def _live(self, monkeypatch, clock, fails="3", window="300"):
        monkeypatch.setenv("MEMRIPAL_PASSCODE", PASSCODE)
        monkeypatch.setenv("MEMRIPAL_PASSCODE_MAX_FAILS", fails)
        monkeypatch.setenv("MEMRIPAL_LOCKOUT_S", window)
        stub = LiveStub()
        return stub, TestClient(create_app(backend=stub, clock=clock), base_url=LOOPBACK_URL)

    def test_max_fails_locks_out_even_the_right_passcode(self, monkeypatch):
        clock = FakeClock(1000.0)
        stub, client = self._live(monkeypatch, clock)
        for _ in range(3):
            assert _split(client, "wrong").status_code == 401
        clock.now = 1001.0
        _assert_locked(_split(client, PASSCODE))
        assert stub.calls == 0

    def test_fewer_than_max_fails_do_not_lock(self, monkeypatch):
        stub, client = self._live(monkeypatch, FakeClock())
        for _ in range(2):
            assert _split(client, "wrong").status_code == 401
        assert _split(client, PASSCODE).status_code == 200
        assert stub.calls == 1

    def test_lockout_lifts_when_the_window_passes(self, monkeypatch):
        clock = FakeClock(1000.0)
        stub, client = self._live(monkeypatch, clock)
        for _ in range(3):
            assert _split(client, "wrong").status_code == 401
        clock.now = 1100.0
        assert _assert_locked(_split(client, PASSCODE)) == 200
        clock.now = 1299.5
        assert _assert_locked(_split(client, PASSCODE)) == 1
        clock.now = 1300.0
        assert _split(client, PASSCODE).status_code == 200
        assert stub.calls == 1

    def test_failures_outside_the_window_do_not_add_up(self, monkeypatch):
        clock = FakeClock(1000.0)
        _, client = self._live(monkeypatch, clock)
        assert _split(client, "wrong").status_code == 401
        assert _split(client, "wrong").status_code == 401
        clock.now = 1300.0
        assert _split(client, "wrong").status_code == 401
        clock.now = 1301.0
        assert _split(client, PASSCODE).status_code == 200

    def test_locked_attempts_are_not_counted_as_new_failures(self, monkeypatch):
        clock = FakeClock(1000.0)
        _, client = self._live(monkeypatch, clock)
        for _ in range(3):
            assert _split(client, "wrong").status_code == 401
        clock.now = 1200.0
        for _ in range(5):
            _assert_locked(_split(client, "wrong"))
        clock.now = 1300.0
        assert _split(client, PASSCODE).status_code == 200

    def test_lockout_covers_every_passcode_gated_route(self, monkeypatch):
        _, client = self._live(monkeypatch, FakeClock())
        for _ in range(3):
            assert _split(client, "wrong").status_code == 401
        resp = client.post("/associate", content=ASSOC_BODY, headers={"Content-Type": JSON, HEADER: PASSCODE})
        _assert_locked(resp)

    def test_another_ip_with_the_right_passcode_still_works(self, monkeypatch):
        monkeypatch.setenv("K_SERVICE", "memripal")
        stub, client = self._live(monkeypatch, FakeClock())
        for _ in range(3):
            assert _split(client, "wrong", xff="203.0.113.9").status_code == 401
        _assert_locked(_split(client, PASSCODE, xff="203.0.113.9"))
        _assert_locked(_split(client, PASSCODE, xff="6.6.6.6, 203.0.113.9"))
        assert _split(client, PASSCODE, xff="198.51.100.7").status_code == 200
        assert stub.calls == 1

    def test_lockout_state_is_per_app_instance(self, monkeypatch):
        clock = FakeClock()
        _, first = self._live(monkeypatch, clock)
        for _ in range(3):
            assert _split(first, "wrong").status_code == 401
        second = TestClient(create_app(backend=LiveStub(), clock=clock), base_url=LOOPBACK_URL)
        assert _split(second, PASSCODE).status_code == 200

    @pytest.mark.parametrize("name", ["MEMRIPAL_PASSCODE_MAX_FAILS", "MEMRIPAL_LOCKOUT_S"])
    @pytest.mark.parametrize("bad", ["abc", "0", "-1", "1.5", ""])
    def test_malformed_lockout_env_fails_at_startup(self, monkeypatch, name, bad):
        monkeypatch.setenv(name, bad)
        with pytest.raises(ValueError):
            create_app(backend=LiveStub(), clock=FakeClock())


class BlockingBackend:
    """Live backend whose model call parks until released, then fails; counts calls."""

    mode = "meta"

    def __init__(self):
        self.entered = threading.Event()
        self.release = threading.Event()
        self.calls = 0
        self._lock = threading.Lock()

    def call(self, req):
        with self._lock:
            self.calls += 1
        self.entered.set()
        self.release.wait(JOIN_S)
        raise BackendCallFailed("released")

    def transcribe(self, wav_bytes, *, keywords=None, **kw):
        with self._lock:
            self.calls += 1
        self.entered.set()
        self.release.wait(JOIN_S)
        return CallResult(ok=False, status=500, body=b"down", error="500 http_error", attempts=1, latency_s=0)


# Requirement: each paid route caps its in-flight requests (MEMRIPAL_ROUTE_CONCURRENCY), so a burst cannot
# pile unbounded upstream calls onto one instance; a request past the cap is refused 503 busy with no model
# or ASR call, and the slot frees once the in-flight request finishes.
class TestRouteConcurrency:
    @pytest.mark.parametrize("route", list(ROUTE_BODIES))
    def test_request_past_the_cap_is_503_busy_and_slot_is_released(self, monkeypatch, route):
        monkeypatch.setenv("MEMRIPAL_ROUTE_CONCURRENCY", "1")
        blocker = BlockingBackend()
        app = create_app(backend=blocker, asr_client=blocker, clock=FakeClock())
        content_type, body = ROUTE_BODIES[route]
        headers = {"Content-Type": content_type}
        with TestClient(app, base_url=LOOPBACK_URL) as client, ThreadPoolExecutor(max_workers=1) as pool:
            try:
                first = pool.submit(client.post, route, content=body, headers=headers)
                assert blocker.entered.wait(JOIN_S), "first request never reached the model"
                busy = client.post(route, content=body, headers=headers)
                assert busy.status_code == 503, busy.text[:300]
                assert busy.json() == {"error": "busy"}
                assert blocker.calls == 1
            finally:
                blocker.release.set()
            assert first.result(JOIN_S).status_code != 503
            again = client.post(route, content=body, headers=headers)
            assert again.status_code != 503, again.text[:300]
            assert blocker.calls == 2

    @pytest.mark.parametrize("bad", ["abc", "0", "-1", "1.5", ""])
    def test_malformed_concurrency_env_fails_at_startup(self, monkeypatch, bad):
        monkeypatch.setenv("MEMRIPAL_ROUTE_CONCURRENCY", bad)
        with pytest.raises(ValueError):
            create_app(backend=LiveStub(), clock=FakeClock())


def _deploy_command() -> str:
    text = DEPLOY_SCRIPT.read_text(encoding="utf-8")
    joined = re.sub(r"\\\r?\n", " ", text)
    commands = [line for line in joined.splitlines() if "gcloud run deploy" in line]
    assert len(commands) == 1, commands
    return commands[0]


# Requirement: the Cloud Run deploy caps per-instance request concurrency and request duration, so one
# instance cannot be flooded with unbounded parallel or hanging requests.
class TestDeployFlags:
    def test_deploy_sets_concurrency(self):
        match = re.search(r"--concurrency[= ](\d+)\b", _deploy_command())
        assert match is not None, "gcloud run deploy lacks --concurrency"
        assert int(match.group(1)) >= 1

    def test_deploy_sets_timeout(self):
        match = re.search(r"--timeout[= ](\d+)(s|m)?\b", _deploy_command())
        assert match is not None, "gcloud run deploy lacks --timeout"
        assert int(match.group(1)) >= 1
