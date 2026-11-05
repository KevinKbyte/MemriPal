# Covers: MEM-098
"""Contract (MEM-098 first bullet): `create_app` mounts POST /baseline (`routes_baseline.baseline_router`).

- `create_app(..., baseline_provider=None)`: None -> `FixtureBaselineProvider(REPLAY_DIR)` when
  `backend.mode == "fixture"`, else `BaselineProvider(os.environ["MEMRIPAL_MAPILLARY_TOKEN"])`.
- The router shares the app's `_passcode_error`: a live app with MEMRIPAL_PASSCODE set refuses a request
  without the passcode header (401 passcode_required) before the body is read and with no provider call.
- A bad body -> 400 bad_coords; fixture mode replays `fixtures/replay/baseline/<sha>.json` with 0 network
  requests; a missing replay -> 404 no_baseline.
"""

import json
import os

import httpx
import pytest
from fastapi.testclient import TestClient
from test_baseline_api import OK, SpyProvider
from test_station_api import FakeBackend

import memripal.app as app_module
import memripal.baseline as baseline_module
import memripal.routes_baseline as routes_baseline_module
from memripal.app import create_app
from memripal.backend import FixtureBackend
from memripal.baseline import replay_path

# The app refuses non-loopback Host headers (MEM-015 host guard); TestClient defaults to "testserver".
LOOPBACK_URL = "http://127.0.0.1"
PASSCODE = "baseline-mount-passcode"
LAT, LON = 42.3626, -71.0843


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch, tmp_path):
    for name in list(os.environ):
        if name.startswith("MEMRIPAL_"):
            monkeypatch.delenv(name)
    monkeypatch.delenv("META_API_KEY", raising=False)
    monkeypatch.delenv("K_SERVICE", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("USERPROFILE", str(tmp_path / "home"))


@pytest.fixture
def network(monkeypatch):
    """Every httpx client built anywhere routes through a recording MockTransport."""
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(500)

    real_client = httpx.Client

    def recording_client(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return real_client(*args, **kwargs)

    monkeypatch.setattr(httpx, "Client", recording_client)
    monkeypatch.setattr(baseline_module.httpx, "Client", recording_client)
    return requests


@pytest.fixture
def replay_root(monkeypatch, tmp_path):
    root = tmp_path / "replay"
    monkeypatch.setattr(app_module, "REPLAY_DIR", root)
    return root


def _post(client, body=None, headers=None):
    payload = json.dumps(body if body is not None else {"lat": LAT, "lon": LON}).encode()
    return client.post(
        "/baseline", content=payload, headers={"Content-Type": "application/json", **(headers or {})}
    )


# Covers: MEM-098
class TestBaselineMountedOnApp:
    def test_live_app_without_passcode_is_401_with_no_provider_call(self, monkeypatch):
        monkeypatch.setenv("MEMRIPAL_PASSCODE", PASSCODE)
        spy = SpyProvider()
        client = TestClient(create_app(backend=FakeBackend(), baseline_provider=spy), base_url=LOOPBACK_URL)
        refused = _post(client)
        assert refused.status_code == 401, refused.text
        assert refused.json() == {"error": "passcode_required"}
        assert spy.calls == []
        allowed = _post(client, headers={"X-Memripal-Passcode": PASSCODE})
        assert allowed.status_code == 200, allowed.text
        assert allowed.json() == {**OK, "candidates": [OK]}  # MEM-137 legacy wrap
        assert spy.calls == [(LAT, LON)]

    @pytest.mark.parametrize(
        "body",
        [
            {"lat": LAT},
            {"lat": 91, "lon": LON},
            {"lat": LAT, "lon": LON, "extra": 1},
            ["not", "an", "object"],
        ],
        ids=["missing-lon", "lat-91", "extra-key", "array"],
    )
    def test_bad_body_is_400_bad_coords_with_no_provider_call(self, body):
        spy = SpyProvider()
        client = TestClient(create_app(backend=FakeBackend(), baseline_provider=spy), base_url=LOOPBACK_URL)
        resp = _post(client, body=body)
        assert resp.status_code == 400, resp.text
        assert resp.json() == {"error": "bad_coords"}
        assert spy.calls == []

    def test_fixture_mode_replays_with_zero_network_requests(self, tmp_path, network, replay_root):
        path = replay_path(replay_root, LAT, LON)
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps(OK), encoding="ascii")
        client = TestClient(create_app(backend=FixtureBackend(tmp_path)), base_url=LOOPBACK_URL)
        resp = _post(client)
        assert resp.status_code == 200, resp.text
        assert resp.json() == {**OK, "candidates": [OK]}  # MEM-137 legacy wrap
        assert network == []

    def test_fixture_mode_missing_replay_is_404_no_baseline(self, tmp_path, network, replay_root):
        client = TestClient(create_app(backend=FixtureBackend(tmp_path)), base_url=LOOPBACK_URL)
        resp = _post(client)
        assert resp.status_code == 404, resp.text
        assert resp.json() == {"error": "no_baseline"}
        assert network == []

    def test_live_mode_builds_mapillary_provider_from_token_env(self, monkeypatch):
        monkeypatch.setenv("MEMRIPAL_MAPILLARY_TOKEN", "tok-from-env")
        built: list[str] = []

        class SpyBaselineProvider(SpyProvider):
            def __init__(self, token):
                super().__init__()
                built.append(token)

        # create_app picks its provider via routes_baseline.default_baseline_provider (app.py line budget).
        monkeypatch.setattr(routes_baseline_module, "BaselineProvider", SpyBaselineProvider)
        client = TestClient(create_app(backend=FakeBackend()), base_url=LOOPBACK_URL)
        assert built == ["tok-from-env"]
        assert _post(client).status_code == 200
