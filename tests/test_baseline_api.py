# Covers: MEM-053
"""Contract (MEM-053): POST /baseline router from `memripal.routes_baseline` (standalone app, not create_app).

- `baseline_router(provider, passcode_error, *, call_budget: int | None = None, max_concurrent: int = ...)`
  -> APIRouter. `provider.lookup(lat, lon)` returns the response dict or raises `baseline.NoBaseline` (404
  {"error": "no_baseline"}) / `baseline.BaselineFailed` (502 {"error": "upstream"}).
- `passcode_error(request)` (the create_app closure) runs first: a non-None JSONResponse is returned before
  the body is read; the provider is never called.
- Body: JSON object with exactly {"lat", "lon"}, finite numbers (bools refused), lat in [-90, 90], lon in
  [-180, 180]; anything else -> 400 {"error": "bad_coords"} with 0 provider calls. Valid coords are
  rounded to 4 dp before the provider sees them.
- `call_budget` N: after N provider calls further requests -> 429 {"error": "budget_exhausted"}; rejected
  bodies never spend budget. `max_concurrent` N: with N lookups in flight, one more request -> 429
  {"error": "busy"} without calling the provider.
"""

import importlib
import random
import threading

import pytest
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

# Covers: MEM-053
# Requirement: POST /baseline is passcode-gated before the body is read, budget- and concurrency-capped,
# accepts only {lat, lon} finite in-range numbers (400 bad_coords otherwise, no outbound call) and hands
# the provider coords rounded to 4 dp, so a station's position never leaves at full precision.

OK = {
    "image": "data:image/jpeg;base64,/9j/AA==",
    "author": "someone",
    "image_url": "https://www.mapillary.com/app/?pKey=1",
    "licence": "CC BY-SA 4.0",
}
SAFETY_S = 10


class SpyProvider:
    def __init__(self, result=OK, exc=None):
        self.result, self.exc = result, exc
        self.calls: list[tuple[float, float]] = []
        self._lock = threading.Lock()

    def lookup(self, lat, lon):
        with self._lock:
            self.calls.append((lat, lon))
        if self.exc is not None:
            raise self.exc
        return self.result


@pytest.fixture
def baseline():
    return importlib.import_module("memripal.baseline")


@pytest.fixture
def routes():
    return importlib.import_module("memripal.routes_baseline")


def _client(routes, provider, passcode_error=lambda request: None, **kwargs) -> TestClient:
    app = FastAPI()
    app.include_router(routes.baseline_router(provider, passcode_error, **kwargs))
    return TestClient(app)


def _post(client, lat=51.5007, lon=-0.1246):
    return client.post("/baseline", json={"lat": lat, "lon": lon})


class TestPasscode:
    @staticmethod
    def _deny(request):
        return JSONResponse({"error": "passcode_required"}, status_code=401)

    def test_401_without_provider_call(self, routes):
        spy = SpyProvider()
        resp = _post(_client(routes, spy, passcode_error=self._deny))
        assert resp.status_code == 401
        assert resp.json() == {"error": "passcode_required"}
        assert spy.calls == []

    def test_401_wins_over_a_malformed_body(self, routes):
        spy = SpyProvider()
        client = _client(routes, spy, passcode_error=self._deny)
        resp = client.post("/baseline", content=b"{not json", headers={"Content-Type": "application/json"})
        assert resp.status_code == 401
        assert spy.calls == []


class TestValidation:
    @pytest.mark.parametrize(
        "raw",
        [
            b'{"lat": 51.5, "lon": -0.12, "extra": 1}',
            b'{"lat": NaN, "lon": -0.12}',
            b'{"lat": 91, "lon": -0.12}',
            b'{"lat": 51.5, "lon": -181}',
            b'{"lat": "51.5", "lon": -0.12}',
            b'{"lat": 51.5}',
            b'{"lat": true, "lon": -0.12}',
        ],
        ids=["extra-key", "nan", "lat-91", "lon-minus-181", "string", "missing-lon", "bool"],
    )
    def test_bad_body_is_400_bad_coords_with_no_provider_call(self, routes, raw):
        spy = SpyProvider()
        client = _client(routes, spy)
        resp = client.post("/baseline", content=raw, headers={"Content-Type": "application/json"})
        assert resp.status_code == 400
        assert resp.json() == {"error": "bad_coords"}
        assert spy.calls == []

    @pytest.mark.parametrize("lat, lon", [(90, 180), (-90, -180), (0, 0)])
    def test_boundary_coords_are_accepted(self, routes, lat, lon):
        spy = SpyProvider()
        assert _post(_client(routes, spy), lat, lon).status_code == 200
        assert spy.calls == [(lat, lon)]

    def test_provider_sees_coords_rounded_to_4_dp_for_20_random_inputs(self, routes):
        rng = random.Random(530)
        spy = SpyProvider()
        client = _client(routes, spy)
        sent = [(rng.uniform(-90, 90), rng.uniform(-180, 180)) for _ in range(20)]
        for lat, lon in sent:
            assert _post(client, lat, lon).status_code == 200
        assert len(spy.calls) == 20
        for (lat, lon), (got_lat, got_lon) in zip(sent, spy.calls, strict=True):
            assert got_lat == round(lat, 4)
            assert got_lon == round(lon, 4)


class TestProviderOutcomes:
    def test_success_passes_the_provider_answer_through(self, routes):
        resp = _post(_client(routes, SpyProvider()))
        assert resp.status_code == 200
        assert resp.json() == OK

    def test_no_baseline_is_404(self, baseline, routes):
        resp = _post(_client(routes, SpyProvider(exc=baseline.NoBaseline())))
        assert resp.status_code == 404
        assert resp.json() == {"error": "no_baseline"}

    def test_baseline_failed_is_502_upstream(self, baseline, routes):
        resp = _post(_client(routes, SpyProvider(exc=baseline.BaselineFailed())))
        assert resp.status_code == 502
        assert resp.json() == {"error": "upstream"}


class TestBudget:
    def test_budget_exhausted_is_429_after_n_calls(self, routes):
        spy = SpyProvider()
        client = _client(routes, spy, call_budget=1)
        assert _post(client).status_code == 200
        resp = _post(client)
        assert resp.status_code == 429
        assert resp.json() == {"error": "budget_exhausted"}
        assert len(spy.calls) == 1

    def test_rejected_body_does_not_spend_budget(self, routes):
        spy = SpyProvider()
        client = _client(routes, spy, call_budget=1)
        assert _post(client, lat=91).status_code == 400
        assert _post(client).status_code == 200


class _SlowProvider(SpyProvider):
    def __init__(self):
        super().__init__()
        self.entered = threading.Semaphore(0)
        self.release = threading.Event()

    def lookup(self, lat, lon):
        result = super().lookup(lat, lon)
        self.entered.release()
        self.release.wait(SAFETY_S)
        return result


class TestConcurrencyCap:
    def test_one_past_the_cap_is_refused_429_busy(self, routes):
        cap = 2
        slow = _SlowProvider()
        client = _client(routes, slow, max_concurrent=cap)
        results: list[tuple[int, dict]] = []
        lock, first_done = threading.Lock(), threading.Event()

        def worker():
            resp = _post(client)
            with lock:
                results.append((resp.status_code, resp.json()))
            first_done.set()

        threads = [threading.Thread(target=worker) for _ in range(cap)]
        try:
            for t in threads:
                t.start()
            for _ in range(cap):
                assert slow.entered.acquire(timeout=SAFETY_S)
            extra = threading.Thread(target=worker)
            threads.append(extra)
            extra.start()
            assert first_done.wait(SAFETY_S)
            with lock:
                assert results == [(429, {"error": "busy"})]
        finally:
            slow.release.set()
            for t in threads:
                t.join(SAFETY_S)
        assert sorted(code for code, _ in results) == [200, 200, 429]
        assert len(slow.calls) == cap
