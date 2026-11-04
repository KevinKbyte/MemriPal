# Covers: MEM-102
# Requirement: behind the external HTTPS load balancer Cloud Run sees X-Forwarded-For as
# "<client-supplied...>, <real client>, <LB>", so MEMRIPAL_TRUSTED_PROXY_HOPS (int >= 1, default 1) picks the
# Nth-from-right entry when X-Forwarded-For is trusted (entries[-hops], or entries[0] when there are fewer
# than hops entries); an invalid, < 1 or non-integer value behaves as 1. Rate limits then key on the real
# client, so clients behind one LB never share a bucket and a spoofed leading entry never escapes a limit.
import hashlib
import hmac
import json

import pytest
from fastapi.testclient import TestClient

from memripal import ratelimit as rl
from memripal.app import create_app

HOPS = "MEMRIPAL_TRUSTED_PROXY_HOPS"
PEER = "10.9.8.7"
KEY = "judges-key-0123456789abcdef"
PUBLIC_HOST = "memripal-abc123-uc.a.run.app"
PLACE_BODY = json.dumps({"lat": 51.5007, "lon": -0.1246}).encode("utf-8")
ENV_VARS = (
    "MEMRIPAL_MODE",
    "META_API_KEY",
    "MEMRIPAL_PASSCODE",
    "MEMRIPAL_ALLOWED_HOSTS",
    "K_SERVICE",
    "MEMRIPAL_ACCESS_KEY",
    "MEMRIPAL_ACCESS_MAX_FAILS",
    "MEMRIPAL_LOCKOUT_S",
    "MEMRIPAL_MAX_BODY_BYTES",
    "MEMRIPAL_RATE_PER_MIN",
    "MEMRIPAL_ROUTE_CONCURRENCY",
    HOPS,
    "MEMRIPAL_CALL_BUDGET",
)


class FakeClock:
    def __init__(self, now: float = 1000.0):
        self.now = now

    def __call__(self) -> float:
        return self.now


class PlaceStub:
    def lookup(self, lat, lon):
        return []


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch, tmp_path):
    for name in ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("USERPROFILE", str(tmp_path / "home"))


def _scope(*xff_values: str) -> dict:
    headers = [(b"x-forwarded-for", v.encode("latin-1")) for v in xff_values]
    return {"type": "http", "headers": headers, "client": (PEER, 50000)}


class TestClientIpHops:
    @pytest.mark.parametrize(
        ("hops", "xff", "expected"),
        [
            ("2", "1.1.1.1, 198.51.100.7, 35.191.0.1", "198.51.100.7"),
            ("3", "1.1.1.1, 198.51.100.7, 35.191.0.1", "1.1.1.1"),
            ("2", "198.51.100.7,35.191.0.1", "198.51.100.7"),
            ("2", "1.1.1.1, , 198.51.100.7 ,35.191.0.1", "198.51.100.7"),
            ("3", "198.51.100.7, 35.191.0.1", "198.51.100.7"),
            ("5", "198.51.100.7, 35.191.0.1", "198.51.100.7"),
        ],
        ids=[
            "hops2",
            "hops3-exact-length",
            "hops2-no-spaces",
            "hops2-empty-entries",
            "short-list-leftmost",
            "far-short-list-leftmost",
        ],  # fmt: skip
    )
    def test_trusted_xff_picks_nth_from_right(self, monkeypatch, hops, xff, expected):
        monkeypatch.setenv(HOPS, hops)
        assert rl.client_ip(_scope(xff), True) == expected

    def test_hops_count_across_repeated_xff_headers(self, monkeypatch):
        monkeypatch.setenv(HOPS, "2")
        assert rl.client_ip(_scope("1.1.1.1", "198.51.100.7, 35.191.0.1"), True) == "198.51.100.7"

    def test_picked_ipv6_entry_is_keyed_by_its_64(self, monkeypatch):
        monkeypatch.setenv(HOPS, "2")
        assert rl.client_ip(_scope("2001:db8:1:2::5, 35.191.0.1"), True) == "2001:db8:1:2::/64"

    def test_single_entry_with_hops_2_is_that_entry(self, monkeypatch):
        monkeypatch.setenv(HOPS, "2")
        assert rl.client_ip(_scope("203.0.113.9"), True) == "203.0.113.9"

    def test_default_is_rightmost_entry(self):
        assert rl.client_ip(_scope("1.1.1.1, 198.51.100.7, 35.191.0.1"), True) == "35.191.0.1"

    @pytest.mark.parametrize("bad", ["0", "-1", "-3", "abc", "", "  ", "1.5", "2x"])
    def test_invalid_hops_behaves_as_one(self, monkeypatch, bad):
        monkeypatch.setenv(HOPS, bad)
        assert rl.client_ip(_scope("1.1.1.1, 198.51.100.7, 35.191.0.1"), True) == "35.191.0.1"

    def test_untrusted_xff_ignores_hops_and_uses_peer(self, monkeypatch):
        monkeypatch.setenv(HOPS, "2")
        assert rl.client_ip(_scope("1.1.1.1, 198.51.100.7, 35.191.0.1"), False) == PEER

    def test_trusted_without_xff_uses_peer(self, monkeypatch):
        monkeypatch.setenv(HOPS, "2")
        assert rl.client_ip(_scope(), True) == PEER


def _cookie() -> dict[str, str]:
    value = hmac.new(KEY.encode("utf-8"), b"memripal-access-v1", hashlib.sha256).hexdigest()
    return {"Cookie": f"memripal_access={value}"}


def _edge_client(monkeypatch, hops: str = "2") -> TestClient:
    env = {
        "K_SERVICE": "memripal",
        "MEMRIPAL_ACCESS_KEY": KEY,
        "MEMRIPAL_ALLOWED_HOSTS": PUBLIC_HOST,
        "MEMRIPAL_RATE_PER_MIN": "1",
        HOPS: hops,
    }
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    app = create_app(backend=None, place_provider=PlaceStub(), clock=FakeClock())
    return TestClient(app, base_url=f"https://{PUBLIC_HOST}", follow_redirects=False)


def _place(client: TestClient, xff: str):
    headers = {"Content-Type": "application/json", "X-Forwarded-For": xff, **_cookie()}
    return client.post("/place", content=PLACE_BODY, headers=headers)


def _assert_429(resp) -> None:
    assert resp.status_code == 429, resp.text[:300]
    assert resp.json() == {"error": "rate_limited"}


class TestRateLimitBehindLoadBalancer:
    def test_real_clients_behind_one_lb_get_separate_buckets(self, monkeypatch):
        client = _edge_client(monkeypatch)
        assert _place(client, "198.51.100.7, 35.191.0.1").status_code == 200
        resp = _place(client, "203.0.113.9, 35.191.0.1")
        assert resp.status_code == 200, resp.text[:300]

    def test_spoofed_leading_entry_is_limited_by_real_ip(self, monkeypatch):
        client = _edge_client(monkeypatch)
        assert _place(client, "198.51.100.7, 35.191.0.1").status_code == 200
        _assert_429(_place(client, "6.6.6.6, 198.51.100.7, 35.191.0.2"))

    def test_invalid_hops_does_not_break_startup(self, monkeypatch):
        client = _edge_client(monkeypatch, hops="abc")
        assert _place(client, "198.51.100.7, 35.191.0.1").status_code == 200
        _assert_429(_place(client, "203.0.113.9, 35.191.0.1"))
