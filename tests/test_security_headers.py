# Covers: MEM-042
# Requirement: C1 every response from create_app carries the app-wide XSS control: the exact
# Content-Security-Policy from the spec plus X-Content-Type-Options: nosniff, on the HTML shell,
# a static JS file, an API JSON answer, a not-found answer and a host-guard refusal alike.
import pytest
from fastapi.testclient import TestClient

from memripal.app import create_app

LOOPBACK_URL = "http://127.0.0.1"
CSP = (
    "default-src 'self'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; "
    "form-action 'none'; frame-ancestors 'none'"
)


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch, tmp_path):
    monkeypatch.delenv("MEMRIPAL_MODE", raising=False)
    monkeypatch.delenv("META_API_KEY", raising=False)
    monkeypatch.delenv("MEMRIPAL_ALLOWED_HOSTS", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("USERPROFILE", str(tmp_path / "home"))


def _client():
    return TestClient(create_app(), base_url=LOOPBACK_URL, raise_server_exceptions=False)


# Covers: MEM-042
# Requirement: C1 the shell, a static script and the JSON API all carry the exact CSP and nosniff,
# whatever their status code.
class TestSecurityHeaders:
    @pytest.mark.parametrize(
        ("path", "content_type", "status"),
        [
            ("/", "text/html", 200),
            ("/static/app.js", "javascript", 200),
            ("/healthz", "application/json", 200),
            ("/no-such-route", "application/json", 404),
        ],
    )
    def test_response_carries_exact_csp_and_nosniff(self, path, content_type, status):
        resp = _client().get(path)
        assert resp.status_code == status, resp.text[:200]
        assert content_type in resp.headers["content-type"]
        assert resp.headers.get("content-security-policy") == CSP
        assert resp.headers.get("x-content-type-options") == "nosniff"

    def test_exactly_one_csp_header(self):
        resp = _client().get("/")
        assert resp.headers.get_list("content-security-policy") == [CSP]
        assert resp.headers.get_list("x-content-type-options") == ["nosniff"]

    def test_host_guard_refusal_also_carries_the_headers(self):
        resp = TestClient(create_app(), base_url="http://evil.example").get("/")
        assert resp.status_code == 400
        assert resp.headers.get("content-security-policy") == CSP
        assert resp.headers.get("x-content-type-options") == "nosniff"
