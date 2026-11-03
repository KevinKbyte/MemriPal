# Covers: MEM-078
# Requirement: the self-hosted map assets are served with their real types and without widening the CSP
# (plan S5 criteria 1 and 5; ADR 0041): GET /static/map/kendall.pmtiles answers 200 with Content-Type
# exactly "application/vnd.pmtiles" (registered via mimetypes.add_type, not a guessed
# application/octet-stream), GET /static/map/style-light.json answers 200 as application/json, and both
# still carry the exact pre-map Content-Security-Policy.
import pytest
from fastapi.testclient import TestClient

from memripal.app import create_app

LOOPBACK_URL = "http://127.0.0.1"
# The pre-map CSP (tests/test_security_headers.py, MEM-042): the real map must not change it.
PRE_MAP_CSP = (
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; img-src 'self' data: blob:; "
    "object-src 'none'; base-uri 'none'; "
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


def _media_type(resp):
    return resp.headers.get("content-type", "").split(";")[0].strip()


# Covers: MEM-078
# Requirement: the PMTiles extract is served as application/vnd.pmtiles and the style JSON as
# application/json, both under the unchanged pre-map CSP.
class TestMapAssetMime:
    def test_pmtiles_extract_is_application_vnd_pmtiles(self):
        resp = _client().get("/static/map/kendall.pmtiles")
        assert resp.status_code == 200, resp.text[:200]
        assert resp.headers.get("content-type") == "application/vnd.pmtiles"
        assert resp.content[:7] == b"PMTiles"

    def test_style_json_is_application_json(self):
        resp = _client().get("/static/map/style-light.json")
        assert resp.status_code == 200, resp.text[:200]
        assert _media_type(resp) == "application/json"

    @pytest.mark.parametrize("path", ["/static/map/kendall.pmtiles", "/static/map/style-light.json"])
    def test_map_assets_carry_the_pre_map_csp(self, path):
        resp = _client().get(path)
        assert resp.status_code == 200
        assert resp.headers.get_list("content-security-policy") == [PRE_MAP_CSP]
        assert resp.headers.get("x-content-type-options") == "nosniff"
