# Covers: MEM-034
"""Contract (MEM-034 hardening, security audit): per-client-IP rate limit on every POST API route.

- Routes: POST /loci, /split, /associate, /scenes, /recall/audio and /place share ONE sliding-window bucket
  per client IP. GET routes (/healthz, /, /demo/*, /static/*) are never limited. Fixture mode is limited too
  (the public deploy runs in fixture mode).
- MEMRIPAL_RATE_PER_MIN: requests allowed per IP in any 60 s window; default 30. Read once at create_app;
  non-integer or < 1 -> ValueError at startup.
- Window: a request at time t counts until t + 60 (at exactly t + 60 it has expired). A refused request is
  not recorded, so hammering does not extend the window.
- Over the limit: 429 {"error": "rate_limited"} with a Retry-After header = whole seconds (rounded up, >= 1)
  until the oldest counted request expires. Refused before the passcode check, the body read, the model,
  the place provider or the call budget.
- create_app(..., clock=<callable returning seconds as float>) injects a monotonic clock; default
  time.monotonic. Limiter state lives in the app instance: two create_app() apps never share counts.
- Client IP: when K_SERVICE is set (Cloud Run), the RIGHTMOST X-Forwarded-For entry (the one Google's front
  end appends; leftmost entries are client-supplied); no X-Forwarded-For -> request.client.host. When
  K_SERVICE is unset, X-Forwarded-For is ignored and request.client.host is the key.
"""

import base64
import io
import json

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from memripal import ratelimit as rl
from memripal.app import create_app

LOOPBACK_URL = "http://127.0.0.1"
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
PLACE_BODY = json.dumps({"lat": 51.5007, "lon": -0.1246}).encode("utf-8")
JSON = "application/json"


def _jpeg(w: int = 64, h: int = 48) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (90, 60, 30)).save(buf, "JPEG")
    return buf.getvalue()


SPLIT_BODY = json.dumps(
    {"photo": base64.b64encode(_jpeg()).decode("ascii"), "mode": "notes", "text": NOTES, "loci_count": 3}
).encode("utf-8")


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


class PlaceStub:
    def __init__(self):
        self.lookups = 0

    def lookup(self, lat, lon):
        self.lookups += 1
        return []


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch, tmp_path):
    for name in ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("USERPROFILE", str(tmp_path / "home"))


def _app(clock, backend=None, place=None, monkeypatch=None, rate=None):
    if rate is not None:
        monkeypatch.setenv("MEMRIPAL_RATE_PER_MIN", str(rate))
    return create_app(backend=backend or LiveStub(), place_provider=place or PlaceStub(), clock=clock)


def _client(app) -> TestClient:
    return TestClient(app, base_url=LOOPBACK_URL)


def _place(client, xff: str | None = None):
    headers = {"Content-Type": JSON}
    if xff is not None:
        headers["X-Forwarded-For"] = xff
    return client.post("/place", content=PLACE_BODY, headers=headers)


def _assert_429(resp) -> int:
    assert resp.status_code == 429, resp.text[:300]
    assert resp.json() == {"error": "rate_limited"}
    retry = resp.headers.get("Retry-After")
    assert retry is not None and retry.isdigit() and int(retry) >= 1, retry
    return int(retry)


# Requirement: one client IP gets at most MEMRIPAL_RATE_PER_MIN POST API requests per sliding minute;
# past it the request is refused with 429 rate_limited plus Retry-After, before any upstream or budget use.
class TestRateLimit:
    def test_requests_past_the_limit_are_429_with_retry_after(self, monkeypatch):
        place = PlaceStub()
        client = _client(_app(FakeClock(), place=place, monkeypatch=monkeypatch, rate=3))
        for _ in range(3):
            assert _place(client).status_code == 200
        _assert_429(_place(client))
        assert place.lookups == 3

    def test_default_limit_is_30_per_minute(self):
        client = _client(_app(FakeClock()))
        for i in range(30):
            assert _place(client).status_code == 200, f"request {i + 1}"
        _assert_429(_place(client))

    def test_limited_request_spends_no_model_call_or_budget(self, monkeypatch):
        monkeypatch.setenv("MEMRIPAL_CALL_BUDGET", "5")
        stub = LiveStub()
        client = _client(_app(FakeClock(), backend=stub, monkeypatch=monkeypatch, rate=1))
        assert client.post("/split", content=SPLIT_BODY, headers={"Content-Type": JSON}).status_code == 200
        _assert_429(client.post("/split", content=SPLIT_BODY, headers={"Content-Type": JSON}))
        assert stub.calls == 1

    def test_limit_is_checked_before_the_passcode(self, monkeypatch):
        monkeypatch.setenv("MEMRIPAL_PASSCODE", "right")
        monkeypatch.setenv("MEMRIPAL_PASSCODE_MAX_FAILS", "1000")
        stub = LiveStub()
        client = _client(_app(FakeClock(), backend=stub, monkeypatch=monkeypatch, rate=1))
        headers = {"Content-Type": JSON, "X-Memripal-Passcode": "right"}
        assert client.post("/split", content=SPLIT_BODY, headers=headers).status_code == 200
        _assert_429(client.post("/split", content=b"{}", headers={"Content-Type": JSON}))

    @pytest.mark.parametrize("route", ["/loci", "/split", "/associate", "/scenes", "/recall/audio", "/place"])
    def test_every_post_api_route_is_limited(self, monkeypatch, route):
        client = _client(_app(FakeClock(), monkeypatch=monkeypatch, rate=1))
        assert _place(client).status_code == 200
        _assert_429(client.post(route, content=b"{}", headers={"Content-Type": JSON}))

    def test_bucket_is_shared_across_routes(self, monkeypatch):
        stub = LiveStub()
        client = _client(_app(FakeClock(), backend=stub, monkeypatch=monkeypatch, rate=2))
        assert _place(client).status_code == 200
        assert client.post("/split", content=SPLIT_BODY, headers={"Content-Type": JSON}).status_code == 200
        _assert_429(client.post("/split", content=SPLIT_BODY, headers={"Content-Type": JSON}))
        assert stub.calls == 1

    def test_fixture_mode_is_limited_too(self, monkeypatch):
        monkeypatch.setenv("MEMRIPAL_RATE_PER_MIN", "1")
        client = _client(create_app(backend=None, place_provider=PlaceStub(), clock=FakeClock()))
        assert _place(client).status_code == 200
        _assert_429(_place(client))

    @pytest.mark.parametrize("path", ["/healthz", "/", "/demo/photo.jpg"])
    def test_get_routes_are_never_limited(self, monkeypatch, path):
        client = _client(_app(FakeClock(), monkeypatch=monkeypatch, rate=1))
        assert _place(client).status_code == 200
        _assert_429(_place(client))
        for _ in range(3):
            assert client.get(path).status_code == 200

    def test_gets_do_not_consume_the_post_budget(self, monkeypatch):
        client = _client(_app(FakeClock(), monkeypatch=monkeypatch, rate=1))
        for _ in range(5):
            assert client.get("/healthz").status_code == 200
        assert _place(client).status_code == 200

    @pytest.mark.parametrize("bad", ["abc", "0", "-1", "1.5", ""])
    def test_malformed_rate_fails_at_startup(self, monkeypatch, bad):
        monkeypatch.setenv("MEMRIPAL_RATE_PER_MIN", bad)
        with pytest.raises(ValueError):
            create_app(backend=LiveStub(), place_provider=PlaceStub(), clock=FakeClock())


# Requirement: the limit is a sliding 60 s window: a request stops counting exactly 60 s after it was made,
# refused requests never extend the window, and Retry-After tells the client how long until a slot frees.
class TestSlidingWindow:
    def test_window_boundary_and_retry_after(self, monkeypatch):
        clock = FakeClock(1000.0)
        client = _client(_app(clock, monkeypatch=monkeypatch, rate=2))
        assert _place(client).status_code == 200
        assert _place(client).status_code == 200
        clock.now = 1030.0
        assert _assert_429(_place(client)) == 30
        clock.now = 1059.5
        assert _assert_429(_place(client)) == 1
        clock.now = 1060.0
        assert _place(client).status_code == 200

    def test_window_slides_per_request(self, monkeypatch):
        clock = FakeClock(1000.0)
        client = _client(_app(clock, monkeypatch=monkeypatch, rate=2))
        assert _place(client).status_code == 200
        clock.now = 1040.0
        assert _place(client).status_code == 200
        clock.now = 1050.0
        assert _assert_429(_place(client)) == 10
        clock.now = 1060.0
        assert _place(client).status_code == 200
        _assert_429(_place(client))
        clock.now = 1100.0
        assert _place(client).status_code == 200

    def test_refused_requests_do_not_extend_the_window(self, monkeypatch):
        clock = FakeClock(1000.0)
        client = _client(_app(clock, monkeypatch=monkeypatch, rate=1))
        assert _place(client).status_code == 200
        for t in (1010.0, 1030.0, 1059.0):
            clock.now = t
            _assert_429(_place(client))
        clock.now = 1060.0
        assert _place(client).status_code == 200


# Requirement: limiter state belongs to one app instance, so separate create_app() apps (and tests) never
# share or leak counts.
class TestInstanceIsolation:
    def test_two_apps_do_not_share_counts(self, monkeypatch):
        monkeypatch.setenv("MEMRIPAL_RATE_PER_MIN", "1")
        clock = FakeClock()
        first = _client(create_app(backend=LiveStub(), place_provider=PlaceStub(), clock=clock))
        second = _client(create_app(backend=LiveStub(), place_provider=PlaceStub(), clock=clock))
        assert _place(first).status_code == 200
        _assert_429(_place(first))
        assert _place(second).status_code == 200


# Requirement: the client IP behind Cloud Run is the rightmost X-Forwarded-For entry, so a spoofed leftmost
# value cannot evade the limit; off Cloud Run X-Forwarded-For is ignored entirely.
class TestClientIp:
    def test_spoofed_leftmost_xff_does_not_evade_on_cloud_run(self, monkeypatch):
        monkeypatch.setenv("K_SERVICE", "memripal")
        client = _client(_app(FakeClock(), monkeypatch=monkeypatch, rate=1))
        assert _place(client, "1.1.1.1, 203.0.113.9").status_code == 200
        _assert_429(_place(client, "2.2.2.2, 203.0.113.9"))
        _assert_429(_place(client, "203.0.113.9"))

    def test_distinct_rightmost_ips_get_separate_buckets_on_cloud_run(self, monkeypatch):
        monkeypatch.setenv("K_SERVICE", "memripal")
        client = _client(_app(FakeClock(), monkeypatch=monkeypatch, rate=1))
        assert _place(client, "203.0.113.9").status_code == 200
        _assert_429(_place(client, "203.0.113.9"))
        assert _place(client, "198.51.100.7").status_code == 200
        assert _place(client, "203.0.113.9, 198.51.100.8").status_code == 200

    def test_cloud_run_without_xff_falls_back_to_peer_address(self, monkeypatch):
        monkeypatch.setenv("K_SERVICE", "memripal")
        client = _client(_app(FakeClock(), monkeypatch=monkeypatch, rate=1))
        assert _place(client).status_code == 200
        _assert_429(_place(client))
        assert _place(client, "198.51.100.7").status_code == 200

    def test_xff_is_ignored_off_cloud_run(self, monkeypatch):
        client = _client(_app(FakeClock(), monkeypatch=monkeypatch, rate=1))
        assert _place(client, "203.0.113.9").status_code == 200
        _assert_429(_place(client, "198.51.100.7"))
        _assert_429(_place(client))


# Requirement: behind Cloud Run an IPv6 client is keyed by its /64 prefix (one subscriber typically owns a
# whole /64), so rotating the low 64 bits cannot mint fresh rate buckets; distinct /64s and IPv4 addresses
# keep separate buckets.
class TestIpv6Prefix:
    def test_same_ipv6_64_shares_one_bucket(self, monkeypatch):
        monkeypatch.setenv("K_SERVICE", "memripal")
        client = _client(_app(FakeClock(), monkeypatch=monkeypatch, rate=1))
        assert _place(client, "2001:db8::1").status_code == 200
        _assert_429(_place(client, "2001:db8::ffff"))
        _assert_429(_place(client, "198.51.100.7, 2001:db8:0:0:abcd:ef01:2345:6789"))

    def test_different_ipv6_64s_get_separate_buckets(self, monkeypatch):
        monkeypatch.setenv("K_SERVICE", "memripal")
        client = _client(_app(FakeClock(), monkeypatch=monkeypatch, rate=1))
        assert _place(client, "2001:db8::1").status_code == 200
        _assert_429(_place(client, "2001:db8::1"))
        assert _place(client, "2001:db8:0:1::1").status_code == 200

    def test_ipv4_is_still_keyed_per_address(self, monkeypatch):
        monkeypatch.setenv("K_SERVICE", "memripal")
        client = _client(_app(FakeClock(), monkeypatch=monkeypatch, rate=1))
        assert _place(client, "203.0.113.9").status_code == 200
        _assert_429(_place(client, "203.0.113.9"))
        assert _place(client, "203.0.113.10").status_code == 200


# Requirement: on a dual-stack bind an IPv4 client arrives as an IPv4-mapped IPv6 address (::ffff:a.b.c.d);
# it is keyed as its plain IPv4 address, never by the shared ::/64, so one IPv4 attacker cannot rate-limit or
# lock out every other IPv4 user.
class TestIpv4MappedIpv6:
    def test_mapped_address_keys_as_plain_ipv4(self):
        assert rl.client_key("::ffff:1.2.3.4") == "1.2.3.4"
        assert rl.client_key("::ffff:1.2.3.4") == rl.client_key("1.2.3.4")
        assert rl.client_key("::ffff:1.2.3.4") != rl.client_key("::ffff:1.2.3.5")

    def test_distinct_mapped_peers_get_separate_rate_buckets(self, monkeypatch):
        app = _app(FakeClock(), monkeypatch=monkeypatch, rate=1)
        first = TestClient(app, base_url=LOOPBACK_URL, client=("::ffff:1.2.3.4", 50000))
        second = TestClient(app, base_url=LOOPBACK_URL, client=("::ffff:1.2.3.5", 50000))
        assert _place(first).status_code == 200
        _assert_429(_place(first))
        assert _place(second).status_code == 200

    def test_lockout_of_one_mapped_peer_does_not_lock_out_another(self, monkeypatch):
        monkeypatch.setenv("MEMRIPAL_PASSCODE", "right")
        monkeypatch.setenv("MEMRIPAL_PASSCODE_MAX_FAILS", "3")
        stub = LiveStub()
        app = create_app(backend=stub, place_provider=PlaceStub(), clock=FakeClock())
        attacker = TestClient(app, base_url=LOOPBACK_URL, client=("::ffff:1.2.3.4", 50000))
        victim = TestClient(app, base_url=LOOPBACK_URL, client=("::ffff:1.2.3.5", 50000))

        def split(client, passcode):
            headers = {"Content-Type": JSON, "X-Memripal-Passcode": passcode}
            return client.post("/split", content=SPLIT_BODY, headers=headers)

        for _ in range(3):
            assert split(attacker, "wrong").status_code == 401
        locked = split(attacker, "right")
        assert locked.status_code == 429, locked.text[:300]
        assert locked.json() == {"error": "too_many_attempts"}
        resp = split(victim, "right")
        assert resp.status_code == 200, resp.text[:300]
        assert stub.calls == 1


# Requirement: limiter state for clients that have gone quiet is dropped once their window has passed, so
# many one-off client IPs cannot grow the in-memory state without bound.
class TestStaleSweep:
    """Seam: len(SlidingWindow) is the number of keys it currently tracks. record() sweeps keys whose events
    have all expired; the sweep may be amortized but runs at least once per window_s of clock time. The
    passcode lockout uses the same SlidingWindow (window_s = MEMRIPAL_LOCKOUT_S), so this covers it too."""

    def test_expired_keys_are_swept_on_a_later_record(self):
        clock = FakeClock(1000.0)
        window = rl.SlidingWindow(limit=1, window_s=60, clock=clock)
        for i in range(500):
            window.record(f"10.0.{i // 256}.{i % 256}")
        assert len(window) == 500
        clock.now = 1061.0
        window.record("192.0.2.1")
        assert len(window) == 1

    def test_tracked_state_does_not_grow_across_windows(self):
        clock = FakeClock(1000.0)
        window = rl.SlidingWindow(limit=1, window_s=300, clock=clock)
        for round_no in range(5):
            for i in range(200):
                window.record(f"r{round_no}-{i}")
            assert len(window) <= 200, round_no
            clock.now += 301.0

    def test_keys_still_inside_their_window_are_kept(self):
        clock = FakeClock(1000.0)
        window = rl.SlidingWindow(limit=1, window_s=300, clock=clock)
        window.record("203.0.113.9")
        clock.now = 1299.0
        window.record("198.51.100.7")
        assert len(window) == 2
        assert window.retry_after("203.0.113.9") == 1
