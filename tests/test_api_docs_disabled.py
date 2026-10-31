# Requirement: the app exposes no auto-generated API documentation surface: GET /docs, /redoc and
# /openapi.json each answer 404, so the route map is not disclosed (security hardening, item 165).
# Covers: none (no spec ID exists for docs-disabled yet; nearest is MEM-042 app-wide XSS/CSP control)
import pytest
from fastapi.testclient import TestClient

from memripal.app import create_app

LOOPBACK_URL = "http://127.0.0.1"


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch, tmp_path):
    monkeypatch.delenv("MEMRIPAL_MODE", raising=False)
    monkeypatch.delenv("META_API_KEY", raising=False)
    monkeypatch.delenv("MEMRIPAL_ALLOWED_HOSTS", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("USERPROFILE", str(tmp_path / "home"))


@pytest.mark.parametrize("path", ["/docs", "/redoc", "/openapi.json"])
def test_api_docs_endpoint_is_not_served(path):
    client = TestClient(create_app(), base_url=LOOPBACK_URL, raise_server_exceptions=False)
    assert client.get(path).status_code == 404
