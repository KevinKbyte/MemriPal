# Covers: MEM-100
# Requirement: the judged Cloud Run deploy is closed to everyone without the shared access key: a no-JS
# /access form trades the key (MEMRIPAL_ACCESS_KEY, stripped) for an HttpOnly cookie; every other path
# without it redirects HTML GETs to /access and answers 401 access_required otherwise; on Cloud Run with
# no key configured everything non-exempt is 503 access_unconfigured.
import json
from urllib.parse import urlencode

import pytest
from fastapi.testclient import TestClient

from memripal.app import create_app

KEY = "judges-key-0123456789abcdef"
BASE = "https://127.0.0.1"
PUBLIC_HOST = "memripal-abc123-uc.a.run.app"
FORM = "application/x-www-form-urlencoded"
HTML = {"Accept": "text/html,application/xhtml+xml"}
ENV_VARS = ("MEMRIPAL_MODE", "META_API_KEY", "MEMRIPAL_PASSCODE", "MEMRIPAL_ALLOWED_HOSTS", "K_SERVICE",
            "MEMRIPAL_ACCESS_KEY", "MEMRIPAL_ACCESS_MAX_FAILS", "MEMRIPAL_LOCKOUT_S", "MEMRIPAL_MAX_BODY_BYTES",
            "MEMRIPAL_TRUSTED_PROXY_HOPS", "MEMRIPAL_CALL_BUDGET")  # fmt: skip
SPLIT = json.dumps({"mode": "notes", "text": "First, the budget doubled.", "loci_count": 3}).encode()


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
        return {"points": [{"label": "budget", "source_quote": "the budget doubled"}]}


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch, tmp_path):
    for name in ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("MEMRIPAL_RATE_PER_MIN", "100000")
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("USERPROFILE", str(tmp_path / "home"))


def _client(monkeypatch, key=KEY, backend=None, clock=None, base=BASE, **env):
    if key is not None:
        monkeypatch.setenv("MEMRIPAL_ACCESS_KEY", key)
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    app = create_app(backend=backend, clock=clock or FakeClock())
    return TestClient(app, base_url=base, follow_redirects=False)


def _login(client, key=KEY, query="", **headers):
    return client.post(
        "/access" + query, content=urlencode({"key": key}), headers={"Content-Type": FORM, **headers}
    )


def _access_cookie(resp) -> dict[str, str] | None:
    for raw in resp.headers.get_list("set-cookie"):
        name, _, rest = raw.partition("=")
        if name.strip() == "memripal_access":
            parts = [p.strip() for p in rest.split(";")]
            attrs = {"value": parts[0]}
            for p in parts[1:]:
                k, _, v = p.partition("=")
                attrs[k.strip().lower()] = v.strip()
            return attrs
    return None


def _cookie_header(client) -> dict[str, str]:
    cookie = _access_cookie(_login(client))
    assert cookie is not None, "login set no memripal_access cookie"
    client.cookies.clear()
    return {"Cookie": f"memripal_access={cookie['value']}"}


# Requirement: without the cookie, HTML GETs redirect to /access and everything else is 401 JSON.
class TestGateRefusals:
    def test_html_get_redirects_to_access(self, monkeypatch):
        resp = _client(monkeypatch).get("/", headers=HTML)
        assert resp.status_code == 303, resp.text[:200]
        assert resp.headers["location"] == "/access"
        assert "no-store" in resp.headers.get("cache-control", "")

    @pytest.mark.parametrize(
        "path", ["/static/app.js", "/static/map/kendall.pmtiles", "/demo/photo.jpg", "/accessX"]
    )
    def test_non_html_get_is_401_access_required(self, monkeypatch, path):
        resp = _client(monkeypatch).get(path)
        assert resp.status_code == 401, resp.text[:200]
        assert resp.json() == {"error": "access_required"}
        assert "no-store" in resp.headers.get("cache-control", "")
        assert "form-action 'self'" in resp.headers.get("content-security-policy", "")
        assert resp.headers.get("x-content-type-options") == "nosniff"

    def test_api_post_is_401(self, monkeypatch):
        resp = _client(monkeypatch).post(
            "/split", content=SPLIT, headers={"Content-Type": "application/json"}
        )
        assert resp.status_code == 401 and resp.json() == {"error": "access_required"}

    def test_forged_cookie_is_refused(self, monkeypatch):
        resp = _client(monkeypatch).get("/static/app.js", headers={"Cookie": "memripal_access=" + "0" * 64})
        assert resp.status_code == 401

    def test_unlisted_host_is_refused_by_host_guard_first(self, monkeypatch):
        resp = _client(monkeypatch, base="https://evil.example").get("/", headers=HTML)
        assert resp.status_code == 400

    def test_key_in_query_string_is_not_accepted(self, monkeypatch):
        client = _client(monkeypatch)
        assert client.get(f"/?key={KEY}", headers=HTML).status_code == 303
        resp = client.post(f"/access?key={KEY}", content=b"", headers={"Content-Type": FORM})
        assert _access_cookie(resp) is None and resp.status_code != 303


# Requirement: /healthz, the /access page and the assets it and the browser need stay reachable.
class TestExemptions:
    def test_healthz_is_open_and_reports_gated(self, monkeypatch):
        resp = _client(monkeypatch).get("/healthz")
        assert resp.status_code == 200 and resp.json()["gated"] is True

    def test_healthz_reports_ungated_without_key(self, monkeypatch):
        assert _client(monkeypatch, key=None).get("/healthz").json()["gated"] is False

    def test_access_page_is_a_no_js_password_form(self, monkeypatch):
        resp = _client(monkeypatch).get("/access", headers=HTML)
        assert resp.status_code == 200, resp.text[:200]
        assert "text/html" in resp.headers["content-type"]
        assert "no-store" in resp.headers.get("cache-control", "")
        assert "form-action 'self'" in resp.headers["content-security-policy"]
        page = resp.text.lower()
        assert 'method="post"' in page and 'action="/access"' in page
        assert 'type="password"' in page and 'name="key"' in page

    @pytest.mark.parametrize(
        "path", ["/static/manifest.webmanifest", "/static/icon.svg", "/static/assets/icon-192.png",
                 "/static/assets/icon-512.png"])  # fmt: skip
    def test_allowlisted_assets_need_no_cookie(self, monkeypatch, path):
        assert _client(monkeypatch).get(path).status_code == 200

    def test_stylesheets_linked_by_access_page_need_no_cookie(self, monkeypatch):
        import re

        client = _client(monkeypatch)
        for href in re.findall(r'<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"', client.get("/access").text):
            assert client.get(href).status_code == 200, href


# Requirement: the right key sets the 14-day HttpOnly Secure Lax cookie; wrong keys 401 and lock out per IP.
class TestLogin:
    def test_right_key_sets_cookie_and_redirects_home(self, monkeypatch):
        resp = _login(_client(monkeypatch))
        assert resp.status_code == 303, resp.text[:200]
        assert resp.headers["location"] == "/"
        assert "no-store" in resp.headers.get("cache-control", "")
        c = _access_cookie(resp)
        assert c is not None and c["value"] and KEY not in c["value"]
        assert "httponly" in c and "secure" in c
        assert c.get("samesite", "").lower() == "lax"
        assert c.get("path") == "/" and c.get("max-age") == "1209600"

    def test_cookie_opens_the_app(self, monkeypatch):
        client = _client(monkeypatch)
        assert client.get("/", headers={**HTML, **_cookie_header(client)}).status_code == 200

    def test_trailing_newline_in_secret_is_stripped(self, monkeypatch):
        assert _login(_client(monkeypatch, key=KEY + "\n")).status_code == 303

    def test_rotated_key_invalidates_old_cookie(self, monkeypatch):
        old = _cookie_header(_client(monkeypatch))
        assert (
            _client(monkeypatch, key="rotated-" + KEY).get("/static/app.js", headers=old).status_code == 401
        )

    def test_wrong_key_is_401_without_cookie(self, monkeypatch):
        resp = _login(_client(monkeypatch), key="wrong")
        assert resp.status_code == 401 and _access_cookie(resp) is None
        assert "no-store" in resp.headers.get("cache-control", "")

    def test_oversize_body_is_413(self, monkeypatch):
        resp = _client(monkeypatch).post(
            "/access", content=b"key=" + b"a" * 1100, headers={"Content-Type": FORM}
        )
        assert resp.status_code == 413

    def test_lockout_after_max_fails_then_lifts(self, monkeypatch):
        clock = FakeClock()
        client = _client(monkeypatch, clock=clock, MEMRIPAL_ACCESS_MAX_FAILS="3", MEMRIPAL_LOCKOUT_S="300")
        for _ in range(3):
            assert _login(client, key="wrong").status_code == 401
        locked = _login(client)
        assert locked.status_code == 429 and locked.json() == {"error": "too_many_attempts"}
        assert int(locked.headers["retry-after"]) >= 1
        clock.now += 300
        assert _login(client).status_code == 303


# Requirement: unconfigured fails open only off Cloud Run; on Cloud Run (K_SERVICE) it is 503 for any Host.
class TestUnconfigured:
    def test_cloud_run_without_key_is_503_even_on_localhost(self, monkeypatch):
        client = _client(monkeypatch, key=None, base="https://localhost", K_SERVICE="memripal")
        for resp in (client.get("/", headers=HTML), client.get("/static/app.js")):
            assert resp.status_code == 503 and resp.json() == {"error": "access_unconfigured"}
        assert client.get("/healthz").status_code == 200

    def test_blank_key_counts_as_unset_on_cloud_run(self, monkeypatch):
        client = _client(monkeypatch, key="  \n", base="https://localhost", K_SERVICE="memripal")
        assert client.get("/").status_code == 503

    def test_local_run_without_key_is_open(self, monkeypatch):
        assert _client(monkeypatch, key=None).get("/", headers=HTML).status_code == 200


# Requirement: the cookie satisfies the live passcode check; cross-site POSTs are refused; the gate runs
# before the rate limiter and body cap so unauthenticated floods spend nothing.
class TestLiveAndCsrf:
    def _live(self, monkeypatch, **env):
        stub = LiveStub()
        client = _client(monkeypatch, backend=stub, base=f"https://{PUBLIC_HOST}", K_SERVICE="memripal",
                         MEMRIPAL_ALLOWED_HOSTS=PUBLIC_HOST, **env)  # fmt: skip
        return stub, client, _cookie_header(client)

    def _split(self, client, **headers):
        return client.post("/split", content=SPLIT, headers={"Content-Type": "application/json", **headers})

    @pytest.mark.parametrize("passcode", [None, "correct-horse"], ids=["no-passcode", "passcode-set"])
    def test_cookie_satisfies_live_passcode_check(self, monkeypatch, passcode):
        env = {"MEMRIPAL_PASSCODE": passcode} if passcode else {}
        stub, client, cookie = self._live(monkeypatch, **env)
        resp = self._split(client, **cookie)
        assert resp.status_code == 200, resp.text[:300]
        assert stub.calls >= 1

    @pytest.mark.parametrize("site", ["same-site", "cross-site"])
    def test_non_same_origin_post_is_403(self, monkeypatch, site):
        stub, client, cookie = self._live(monkeypatch)
        resp = self._split(client, **cookie, **{"Sec-Fetch-Site": site})
        assert resp.status_code == 403 and resp.json() == {"error": "cross_site"}
        assert stub.calls == 0

    @pytest.mark.parametrize("site", ["same-origin", None])
    def test_same_origin_or_headerless_post_is_served(self, monkeypatch, site):
        _, client, cookie = self._live(monkeypatch)
        extra = {"Sec-Fetch-Site": site} if site else {}
        assert self._split(client, **cookie, **extra).status_code == 200

    def test_login_post_is_exempt_from_site_check(self, monkeypatch):
        assert _login(_client(monkeypatch), **{"Sec-Fetch-Site": "same-site"}).status_code == 303

    def test_unauthenticated_flood_does_not_spend_rate_limit(self, monkeypatch):
        stub, client, cookie = self._live(monkeypatch, MEMRIPAL_RATE_PER_MIN="2")
        for _ in range(3):
            assert self._split(client).status_code == 401
        assert self._split(client, **cookie).status_code == 200

    def test_unauthenticated_oversize_body_is_401_not_413(self, monkeypatch):
        _, client, _ = self._live(monkeypatch, MEMRIPAL_MAX_BODY_BYTES="1024")
        resp = client.post("/split", content=b"x" * 4096, headers={"Content-Type": "application/json"})
        assert resp.status_code == 401
