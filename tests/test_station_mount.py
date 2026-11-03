# Covers: MEM-083
# Requirement: the app from memripal.app.create_app serves POST /station (the routes_station router,
# MEM-049) alongside its other model routes: a valid photo returns 200 with the station JSON, a bad
# upload (non-image bytes, or a content type outside the /loci upload types) returns the route's own
# 4xx error code without any model call, and the app's passcode guard covers /station like /loci.
import os

import pytest
from fastapi.testclient import TestClient
from test_station_api import GOOD_REPLY, UPLOAD, FakeBackend

from memripal.app import create_app

# The app refuses non-loopback Host headers (MEM-015 host guard); TestClient defaults to "testserver".
LOOPBACK_URL = "http://127.0.0.1"
PASSCODE = "mount-test-passcode"


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch, tmp_path):
    for name in list(os.environ):
        if name.startswith("MEMRIPAL_"):
            monkeypatch.delenv(name)
    monkeypatch.delenv("META_API_KEY", raising=False)
    monkeypatch.delenv("K_SERVICE", raising=False)
    # Isolate home so nothing under the real ~/.secrets could ever be consulted.
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("USERPROFILE", str(tmp_path / "home"))


def _post(client, body=UPLOAD, content_type="image/jpeg", headers=None):
    return client.post("/station", content=body, headers={"Content-Type": content_type, **(headers or {})})


# Covers: MEM-083
class TestStationMountedOnApp:
    def test_valid_photo_returns_200_with_station_json(self):
        backend = FakeBackend()
        resp = _post(TestClient(create_app(backend=backend), base_url=LOOPBACK_URL))
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["name"] == GOOD_REPLY["station_name"]
        assert body["image"].startswith("data:image/jpeg;base64,")
        assert backend.count("spark_json") == 1

    @pytest.mark.parametrize(
        ("body", "content_type", "status", "code"),
        [
            (b"not an image at all", "image/jpeg", 400, "bad_magic"),
            (UPLOAD, "application/octet-stream", 415, "unsupported_media_type"),
        ],
        ids=["non-image-bytes", "unknown-type"],
    )
    def test_bad_upload_returns_route_4xx_and_calls_no_model(self, body, content_type, status, code):
        backend = FakeBackend()
        client = TestClient(create_app(backend=backend), base_url=LOOPBACK_URL)
        resp = _post(client, body=body, content_type=content_type)
        assert resp.status_code == status, resp.text
        assert resp.json() == {"error": code}
        assert backend.calls == []

    def test_app_passcode_guard_covers_station(self, monkeypatch):
        monkeypatch.setenv("MEMRIPAL_PASSCODE", PASSCODE)
        backend = FakeBackend()
        client = TestClient(create_app(backend=backend), base_url=LOOPBACK_URL)
        refused = _post(client)
        assert refused.status_code == 401, refused.text
        assert refused.json() == {"error": "passcode_required"}
        assert backend.calls == []
        allowed = _post(client, headers={"X-Memripal-Passcode": PASSCODE})
        assert allowed.status_code == 200, allowed.text
