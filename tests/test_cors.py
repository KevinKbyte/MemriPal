# Covers: MEM-063
# Requirement: the Capacitor shell (origin https://localhost on Android, capacitor://localhost on
# iOS) calls the Cloud Run API cross-origin. memripal.cors.add_cors(app) allows exactly the origins in
# MEMRIPAL_CORS_ORIGINS (comma-separated; blank/unset = https://localhost, capacitor://localhost),
# never *, never credentials, and preflights allow X-Memripal-Passcode plus Content-Type. Any other
# origin gets no Access-Control-Allow-Origin.
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

DEFAULT_ORIGINS = ("https://localhost", "capacitor://localhost")
PASSCODE_HEADER = "X-Memripal-Passcode"
EVIL = "https://evil.example"


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    monkeypatch.delenv("MEMRIPAL_CORS_ORIGINS", raising=False)


def _client() -> TestClient:
    from memripal.cors import add_cors

    app = FastAPI()

    @app.get("/healthz")
    def healthz():
        return {"ok": True}

    @app.post("/loci")
    def loci():
        return {"ok": True}

    add_cors(app)
    return TestClient(app, base_url="http://127.0.0.1")


def _preflight(client: TestClient, origin: str, headers: str = "x-memripal-passcode, content-type"):
    return client.options(
        "/loci",
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": headers,
        },
    )


def _allowed_headers(resp) -> set[str]:
    raw = resp.headers.get("access-control-allow-headers", "")
    return {h.strip().lower() for h in raw.split(",") if h.strip()}


# Covers: MEM-063
# Requirement: default origins are the Capacitor WebView origins, echoed exactly.
class TestDefaultOrigins:
    @pytest.mark.parametrize("origin", DEFAULT_ORIGINS)
    def test_simple_get_echoes_exact_origin(self, origin):
        resp = _client().get("/healthz", headers={"Origin": origin})
        assert resp.status_code == 200
        assert resp.headers.get("access-control-allow-origin") == origin
        assert "origin" in resp.headers.get("vary", "").lower()

    @pytest.mark.parametrize("origin", DEFAULT_ORIGINS)
    def test_preflight_allows_passcode_and_content_type(self, origin):
        resp = _preflight(_client(), origin)
        assert resp.status_code == 200, resp.text
        assert resp.headers.get("access-control-allow-origin") == origin
        allowed = _allowed_headers(resp)
        assert PASSCODE_HEADER.lower() in allowed
        assert "content-type" in allowed
        assert "*" not in allowed
        assert "POST" in resp.headers.get("access-control-allow-methods", "")

    @pytest.mark.parametrize("origin", DEFAULT_ORIGINS)
    def test_no_credentials(self, origin):
        client = _client()
        for resp in (_preflight(client, origin), client.get("/healthz", headers={"Origin": origin})):
            assert resp.headers.get("access-control-allow-credentials") is None

    def test_blank_env_means_default(self, monkeypatch):
        monkeypatch.setenv("MEMRIPAL_CORS_ORIGINS", "   ")
        resp = _client().get("/healthz", headers={"Origin": "https://localhost"})
        assert resp.headers.get("access-control-allow-origin") == "https://localhost"


# Covers: MEM-063
# Requirement: origins outside the list never get an ACAO header, and * is never granted.
class TestDisallowedOrigins:
    @pytest.mark.parametrize("origin", [EVIL, "http://localhost", "https://localhost.evil.example", "null"])
    def test_get_from_disallowed_origin_has_no_acao(self, origin):
        resp = _client().get("/healthz", headers={"Origin": origin})
        assert resp.headers.get("access-control-allow-origin") is None

    def test_preflight_from_disallowed_origin_has_no_acao(self):
        resp = _preflight(_client(), EVIL)
        assert resp.headers.get("access-control-allow-origin") is None

    def test_wildcard_in_env_is_never_granted(self, monkeypatch):
        monkeypatch.setenv("MEMRIPAL_CORS_ORIGINS", "*, https://a.example")
        try:
            client = _client()
        except ValueError:
            return  # refusing the config outright is also acceptable
        for origin in (EVIL, "https://a.example"):
            acao = client.get("/healthz", headers={"Origin": origin}).headers.get(
                "access-control-allow-origin"
            )
            assert acao != "*"
        assert (
            client.get("/healthz", headers={"Origin": EVIL}).headers.get("access-control-allow-origin")
            is None
        )


# Covers: MEM-063
# Requirement: MEMRIPAL_CORS_ORIGINS replaces the default list exactly (comma-separated, trimmed).
class TestEnvOrigins:
    def test_env_list_replaces_defaults(self, monkeypatch):
        monkeypatch.setenv("MEMRIPAL_CORS_ORIGINS", " https://a.example , ,https://b.example ")
        client = _client()
        for origin in ("https://a.example", "https://b.example"):
            resp = client.get("/healthz", headers={"Origin": origin})
            assert resp.headers.get("access-control-allow-origin") == origin
        resp = client.get("/healthz", headers={"Origin": "https://localhost"})
        assert resp.headers.get("access-control-allow-origin") is None
