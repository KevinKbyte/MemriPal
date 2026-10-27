# Requirement: MemriPal serves a liveness endpoint reporting which backend mode is active, and serves the
# static frontend shell at the root URL, so the demo can be opened in a browser and health-checked.
# Covers: MEM-001
# Requirement: MemriPal picks its model backend from an explicit mode or MEMRIPAL_MODE (default offline
# fixture replay); live "meta" mode refuses to start without META_API_KEY and never leaks the key value.
# Covers: MEM-002
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from memripal.app import create_app
from memripal.backend import FixtureBackend, MissingApiKey, select_backend

FAKE_KEY = "fake-test-key-0123456789abcdefXYZ"
# The app refuses non-loopback Host headers (MEM-015 host guard); TestClient defaults to "testserver".
LOOPBACK_URL = "http://127.0.0.1"
REPO = Path(__file__).resolve().parents[1]
DEMO_PHOTO = REPO / "fixtures" / "demo" / "photo.jpg"
DEMO_REPLAY_DIR = REPO / "fixtures" / "replay"


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch, tmp_path):
    monkeypatch.delenv("MEMRIPAL_MODE", raising=False)
    monkeypatch.delenv("META_API_KEY", raising=False)
    # Isolate home so nothing under the real ~/.secrets could ever be consulted.
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("USERPROFILE", str(tmp_path / "home"))


# Covers: MEM-001
class TestHealthAndStaticShell:
    def test_healthz_default_reports_ok_fixture_mode(self):
        client = TestClient(create_app(), base_url=LOOPBACK_URL)
        resp = client.get("/healthz")
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("application/json")
        assert resp.json() == {"status": "ok", "mode": "fixture"}

    def test_healthz_reports_fixture_mode_for_injected_fixture_backend(self, tmp_path):
        client = TestClient(create_app(backend=FixtureBackend(tmp_path)), base_url=LOOPBACK_URL)
        resp = client.get("/healthz")
        assert resp.status_code == 200
        assert resp.json() == {"status": "ok", "mode": "fixture"}

    def test_healthz_reports_meta_mode_without_leaking_key(self, monkeypatch, tmp_path):
        monkeypatch.setenv("META_API_KEY", FAKE_KEY)
        backend = select_backend("meta", tmp_path)
        client = TestClient(create_app(backend=backend), base_url=LOOPBACK_URL)
        resp = client.get("/healthz")
        assert resp.status_code == 200
        assert resp.json() == {"status": "ok", "mode": "meta"}
        assert FAKE_KEY not in resp.text

    def test_root_serves_html_shell(self):
        client = TestClient(create_app(), base_url=LOOPBACK_URL)
        resp = client.get("/")
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/html")
        assert "<html" in resp.text.lower()

    def test_module_level_app_serves_healthz(self):
        from memripal.app import app

        resp = TestClient(app, base_url=LOOPBACK_URL).get("/healthz")
        assert resp.status_code == 200
        assert resp.json()["status"] == "ok"


# Covers: MEM-002
class TestSelectBackend:
    def test_none_mode_without_env_defaults_to_fixture(self, tmp_path):
        assert isinstance(select_backend(None, tmp_path), FixtureBackend)

    def test_none_mode_reads_env_fixture(self, monkeypatch, tmp_path):
        monkeypatch.setenv("MEMRIPAL_MODE", "fixture")
        assert isinstance(select_backend(None, tmp_path), FixtureBackend)

    def test_none_mode_reads_env_meta(self, monkeypatch, tmp_path):
        monkeypatch.setenv("MEMRIPAL_MODE", "meta")
        monkeypatch.setenv("META_API_KEY", FAKE_KEY)
        backend = select_backend(None, tmp_path)
        assert not isinstance(backend, FixtureBackend)
        assert type(backend).__name__ == "MetaBackend"

    def test_explicit_fixture_ignores_env_meta(self, monkeypatch, tmp_path):
        monkeypatch.setenv("MEMRIPAL_MODE", "meta")
        assert isinstance(select_backend("fixture", tmp_path), FixtureBackend)

    def test_explicit_meta_without_key_raises_missing_api_key(self, tmp_path):
        with pytest.raises(MissingApiKey):
            select_backend("meta", tmp_path)

    def test_explicit_meta_with_empty_key_raises_missing_api_key(self, monkeypatch, tmp_path):
        monkeypatch.setenv("META_API_KEY", "")
        with pytest.raises(MissingApiKey):
            select_backend("meta", tmp_path)

    def test_env_meta_without_key_raises_missing_api_key(self, monkeypatch, tmp_path):
        monkeypatch.setenv("MEMRIPAL_MODE", "meta")
        with pytest.raises(MissingApiKey):
            select_backend(None, tmp_path)

    def test_missing_key_never_falls_back_to_secret_files(self, tmp_path):
        secrets = tmp_path / "home" / ".secrets"
        secrets.mkdir(parents=True)
        (secrets / "META_API_KEY").write_text(FAKE_KEY, encoding="utf-8")
        (tmp_path / ".env").write_text("META" + "_API_KEY=" + FAKE_KEY + "\n", encoding="utf-8")
        with pytest.raises(MissingApiKey) as excinfo:
            select_backend("meta", tmp_path)
        assert FAKE_KEY not in str(excinfo.value)

    def test_meta_backend_repr_and_str_never_contain_key(self, monkeypatch, tmp_path):
        monkeypatch.setenv("META_API_KEY", FAKE_KEY)
        backend = select_backend("meta", tmp_path)
        assert FAKE_KEY not in repr(backend)
        assert FAKE_KEY not in str(backend)

    @pytest.mark.parametrize(
        ("method", "args"),
        [
            ("segment", ("sha", "book")),
            ("spark_json", ("sha", "phrases")),
            ("image_edit", ("sha", "book")),
        ],
    )
    def test_meta_backend_methods_not_implemented_without_leaking_key(
        self, monkeypatch, tmp_path, method, args
    ):
        monkeypatch.setenv("META_API_KEY", FAKE_KEY)
        backend = select_backend("meta", tmp_path)
        with pytest.raises(NotImplementedError) as excinfo:
            getattr(backend, method)(*args)
        assert "S1" in str(excinfo.value)
        assert FAKE_KEY not in str(excinfo.value)
        assert FAKE_KEY not in repr(excinfo.value)

    @pytest.mark.parametrize("mode", ["live", "", "FIXTURE ", "openai"])
    def test_unknown_explicit_mode_raises_value_error_without_key(self, monkeypatch, tmp_path, mode):
        monkeypatch.setenv("META_API_KEY", FAKE_KEY)
        with pytest.raises(ValueError) as excinfo:
            select_backend(mode, tmp_path)
        assert FAKE_KEY not in str(excinfo.value)

    def test_unknown_env_mode_raises_value_error(self, monkeypatch, tmp_path):
        monkeypatch.setenv("MEMRIPAL_MODE", "bogus")
        with pytest.raises(ValueError):
            select_backend(None, tmp_path)


# Covers: MEM-017
# Requirement: the "Load demo" control works end to end in fixture mode. The server serves the
# committed demo photo at GET /demo/photo.jpg (200, image/jpeg, byte-identical to
# fixtures/demo/photo.jpg), and POSTing exactly those served bytes to /loci yields >= 10 loci,
# because no client re-encode sits between the served asset and the upload (browser JPEG
# encoders differ, so re-encoded bytes could never match a replay fixture). Only the demo photo
# is exposed: a traversal attempt out of /demo/ is never served.
class TestDemoPhotoRoute:
    @staticmethod
    def _client():
        return TestClient(create_app(backend=FixtureBackend(DEMO_REPLAY_DIR)), base_url=LOOPBACK_URL)

    def test_demo_photo_is_served_byte_identical_as_jpeg(self):
        resp = self._client().get("/demo/photo.jpg")
        assert resp.status_code == 200, resp.text[:200]
        assert resp.headers["content-type"].split(";")[0].strip() == "image/jpeg"
        assert resp.content == DEMO_PHOTO.read_bytes()

    def test_served_demo_bytes_posted_to_loci_yield_at_least_ten_loci(self):
        client = self._client()
        served = client.get("/demo/photo.jpg")
        assert served.status_code == 200, served.text[:200]
        resp = client.post("/loci", content=served.content, headers={"Content-Type": "image/jpeg"})
        assert resp.status_code == 200, resp.text[:200]
        loci = resp.json()["loci"]
        assert len(loci) >= 10
        assert [lc["n"] for lc in loci] == list(range(1, len(loci) + 1))

    @pytest.mark.parametrize("path", ["/demo/%2e%2e/MANIFEST.md", "/demo/..%2fMANIFEST.md"])
    def test_traversal_out_of_demo_is_not_served(self, path):
        resp = self._client().get(path)
        assert resp.status_code != 200
        assert "synthetic" not in resp.text


# Covers: MEM-017
# Requirement: when the committed demo photo is missing, GET /demo/photo.jpg answers 404 with the
# app's standard JSON error body {"error": "demo_missing"}, never a plain-text 500.
class TestDemoPhotoMissing:
    def test_missing_demo_photo_is_404_demo_missing_json(self, monkeypatch, tmp_path):
        import memripal.app as app_module

        monkeypatch.setattr(app_module, "DEMO_PHOTO", tmp_path / "absent" / "photo.jpg")
        client = TestClient(
            create_app(backend=FixtureBackend(tmp_path)),
            base_url=LOOPBACK_URL,
            raise_server_exceptions=False,
        )
        resp = client.get("/demo/photo.jpg")
        assert resp.status_code == 404, resp.text[:200]
        assert resp.headers["content-type"].startswith("application/json")
        assert resp.json() == {"error": "demo_missing"}
