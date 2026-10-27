"""Contract (MEM-025, ADR 0022): stateless POST /place backed by `memripal.place.PlaceProvider`.

- `PlaceProvider(transport: httpx.BaseTransport | None = None)`; `create_app(backend=..., place_provider=...)`
  injects it (None -> a default provider on the real network).
- Request: Content-Type application/json (else 415 {"error": "unsupported_media_type"}); body exactly
  {"lat": number, "lon": number}, finite, lat in [-90, 90], lon in [-180, 180], bools refused; anything else
  -> 400 {"error": "bad_request"}; a body past a small cap -> 413 {"error": "too_large"}. No upstream call
  on any rejection.
- Upstream: Wikipedia GeoSearch (GET en.wikipedia.org/w/api.php, list=geosearch, gscoord "<lat>|<lon>",
  gsradius 500) then the REST page summary per hit; descriptive User-Agent; every timeout <= 2 s; an
  in-process LRU keyed by coords answers a repeat without a new GeoSearch request.
- 200 {"places": [...]}: the top 3 hits, each exactly {"title", "distance_m" (int, rounded metres),
  "extract" (the plain-text summary, <= 400 chars)}. Any upstream failure (429, 5xx, timeout, connect
  error, non-JSON) -> 200 {"places": []}.
- Coords are never logged: no log record (any logger, any level, incl. httpx) carries them.
"""

import importlib
import json
import logging
from urllib.parse import unquote

import httpx
import pytest
from fastapi.testclient import TestClient

from memripal.app import create_app

LOOPBACK_URL = "http://127.0.0.1"
LAT, LON = 51.5007, -0.1246
COORD_STRINGS = ("51.5007", "0.1246")
PLACE_KEYS = {"title", "distance_m", "extract"}
LONG_EXTRACT = (
    "Big Ben is the nickname for the Great Bell of the Great Clock of Westminster, at the north end of the "
    "Palace of Westminster in London, England, and the name is frequently extended to refer also to the "
    "clock and the clock tower. The official name of the tower in which Big Ben is located was originally "
    "the Clock Tower, but it was renamed Elizabeth Tower in 2012 to mark the Diamond Jubilee of Elizabeth "
    "II. The clock is a striking clock with five bells, and the tower was designed by Augustus Pugin."
)

# Recorded GeoSearch reply (shape of en.wikipedia.org/w/api.php?action=query&list=geosearch&format=json).
GEOSEARCH = {
    "batchcomplete": "",
    "query": {
        "geosearch": [
            {
                "pageid": 3956,
                "ns": 0,
                "title": "Big Ben",
                "lat": 51.50073,
                "lon": -0.12463,
                "dist": 12.7,
                "primary": "",
            },
            {
                "pageid": 74484,
                "ns": 0,
                "title": "Palace of Westminster",
                "lat": 51.4995,
                "lon": -0.1248,
                "dist": 95.2,
                "primary": "",
            },
            {
                "pageid": 1166383,
                "ns": 0,
                "title": "Portcullis House",
                "lat": 51.50147,
                "lon": -0.12424,
                "dist": 180.4,
                "primary": "",
            },
            {
                "pageid": 33707,
                "ns": 0,
                "title": "Westminster Bridge",
                "lat": 51.50083,
                "lon": -0.12194,
                "dist": 210.9,
                "primary": "",
            },
        ]
    },
}

# Recorded REST summaries (shape of en.wikipedia.org/api/rest_v1/page/summary/<title>).
SUMMARIES = {
    "Big Ben": LONG_EXTRACT,
    "Palace of Westminster": "The Palace of Westminster is the meeting place of the Parliament of the UK.",
    "Portcullis House": "Portcullis House is an office building in Westminster, London.",
    "Westminster Bridge": "Westminster Bridge is a road-and-foot-traffic bridge over the River Thames.",
}


def _summary(title: str) -> dict:
    extract = SUMMARIES[title]
    return {
        "type": "standard",
        "title": title,
        "extract": extract,
        "extract_html": f"<p><b>{title}</b>{extract[len(title) :]}</p>",
    }


class WikiApi:
    """httpx.MockTransport handler replaying the recorded Wikipedia replies; records every request."""

    def __init__(self, geosearch=None, summary=None):
        self.geosearch = geosearch
        self.summary = summary
        self.requests: list[httpx.Request] = []

    def geosearch_requests(self):
        return [r for r in self.requests if r.url.path == "/w/api.php"]

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        if path == "/w/api.php":
            if self.geosearch is not None:
                return self.geosearch(request)
            return httpx.Response(200, json=GEOSEARCH)
        prefix = "/api/rest_v1/page/summary/"
        if path.startswith(prefix):
            if self.summary is not None:
                return self.summary(request)
            title = unquote(path[len(prefix) :]).replace("_", " ")
            if title not in SUMMARIES:
                return httpx.Response(404, json={"type": "not_found"})
            return httpx.Response(200, json=_summary(title))
        return httpx.Response(404, json={"error": "unexpected path"})


class NoModelBackend:
    mode = "fake"

    def call(self, req):
        raise AssertionError("POST /place must never call the model backend")


@pytest.fixture
def place():
    # Imported per test, so a missing module fails each test rather than erroring collection.
    return importlib.import_module("memripal.place")


def _client(place, api) -> TestClient:
    provider = place.PlaceProvider(transport=httpx.MockTransport(api))
    return TestClient(create_app(backend=NoModelBackend(), place_provider=provider), base_url=LOOPBACK_URL)


def _post(client, body, content_type="application/json"):
    content = json.dumps(body) if isinstance(body, dict) else body
    return client.post("/place", content=content, headers={"Content-Type": content_type})


def _raise(exc):
    def handler(request):
        raise exc

    return handler


# Covers: MEM-025
# Requirement: with place history on, POST /place turns rounded coords into the top 3 nearby Wikipedia
# places (title, rounded metres, plain-text extract capped at 400 chars), replayed offline here from
# recorded GeoSearch + REST summary replies.
class TestPlaceLookup:
    def test_recorded_fixture_gives_top_three_places(self, place):
        resp = _post(_client(place, WikiApi()), {"lat": LAT, "lon": LON})
        assert resp.status_code == 200, resp.text
        payload = resp.json()
        assert set(payload) == {"places"}
        places = payload["places"]
        assert [p["title"] for p in places] == ["Big Ben", "Palace of Westminster", "Portcullis House"]
        assert [p["distance_m"] for p in places] == [13, 95, 180]
        for p in places:
            assert set(p) == PLACE_KEYS
            assert isinstance(p["distance_m"], int)
        assert places[1]["extract"] == SUMMARIES["Palace of Westminster"]

    def test_extract_is_plain_text_capped_at_400_chars(self, place):
        places = _post(_client(place, WikiApi()), {"lat": LAT, "lon": LON}).json()["places"]
        big_ben = places[0]["extract"]
        assert 0 < len(big_ben) <= 400
        assert big_ben.startswith("Big Ben is the nickname")
        assert all("<" not in p["extract"] for p in places)

    def test_geosearch_request_uses_500_m_radius_and_the_given_coords(self, place):
        api = WikiApi()
        _post(_client(place, api), {"lat": LAT, "lon": LON})
        [geo] = api.geosearch_requests()
        assert geo.method == "GET"
        assert geo.url.host == "en.wikipedia.org"
        assert geo.url.params["list"] == "geosearch"
        assert geo.url.params["gsradius"] == "500"
        assert geo.url.params["gscoord"] == f"{LAT}|{LON}"

    def test_requests_send_a_descriptive_user_agent_and_a_2s_timeout(self, place):
        api = WikiApi()
        _post(_client(place, api), {"lat": LAT, "lon": LON})
        assert api.requests
        for req in api.requests:
            agent = req.headers.get("user-agent", "")
            assert agent and not agent.startswith("python-httpx"), agent
            timeouts = req.extensions["timeout"]
            assert all(t is not None and 0 < t <= 2.0 for t in timeouts.values()), timeouts

    def test_repeat_coords_are_answered_from_the_in_process_cache(self, place):
        api = WikiApi()
        client = _client(place, api)
        first = _post(client, {"lat": LAT, "lon": LON}).json()
        second = _post(client, {"lat": LAT, "lon": LON}).json()
        assert second == first
        assert len(api.geosearch_requests()) == 1
        _post(client, {"lat": 48.8584, "lon": 2.2945})
        assert len(api.geosearch_requests()) == 2


# Covers: MEM-025
# Requirement: place lookup is best effort; a rate limit (429), server error, timeout, connect error or
# unreadable reply from Wikipedia answers 200 with an empty list, so the upload flow never breaks.
class TestPlaceUpstreamFailure:
    @pytest.mark.parametrize(
        "geosearch",
        [
            lambda r: httpx.Response(429, json={"error": "ratelimited"}),
            lambda r: httpx.Response(503, text="unavailable"),
            lambda r: httpx.Response(200, text="<html>not json</html>"),
            _raise(httpx.ReadTimeout("slow")),
            _raise(httpx.ConnectError("refused")),
        ],
        ids=["429", "503", "non-json", "timeout", "connect-error"],
    )
    def test_geosearch_failure_gives_empty_list(self, place, geosearch):
        resp = _post(_client(place, WikiApi(geosearch=geosearch)), {"lat": LAT, "lon": LON})
        assert resp.status_code == 200, resp.text
        assert resp.json() == {"places": []}

    def test_summary_rate_limit_gives_empty_list(self, place):
        api = WikiApi(summary=lambda r: httpx.Response(429, json={"error": "ratelimited"}))
        resp = _post(_client(place, api), {"lat": LAT, "lon": LON})
        assert resp.status_code == 200, resp.text
        assert resp.json() == {"places": []}


# Covers: MEM-025
# Requirement: /place is stateless and private: coords never appear in any log record (app, httpx or
# otherwise, at any level), on success or failure.
class TestPlaceCoordsNeverLogged:
    @pytest.mark.parametrize(
        "geosearch",
        [None, lambda r: httpx.Response(429, json={}), _raise(httpx.ReadTimeout("slow"))],
        ids=["success", "429", "timeout"],
    )
    def test_no_log_record_carries_the_coords(self, place, caplog, geosearch):
        caplog.set_level(logging.DEBUG)
        resp = _post(_client(place, WikiApi(geosearch=geosearch)), {"lat": LAT, "lon": LON})
        assert resp.status_code == 200, resp.text
        for coord in COORD_STRINGS:
            assert coord not in caplog.text
            for record in caplog.records:
                assert coord not in record.getMessage()


# Covers: MEM-025
# Requirement: /place input is validated at the boundary: JSON content type, a small body cap, exactly
# {lat, lon} as finite in-range numbers; every rejection is {"error": code} and makes no upstream request.
class TestPlaceRejections:
    def test_wrong_content_type_is_415(self, place):
        api = WikiApi()
        resp = _post(_client(place, api), json.dumps({"lat": LAT, "lon": LON}), content_type="text/plain")
        assert resp.status_code == 415
        assert resp.json() == {"error": "unsupported_media_type"}
        assert api.requests == []

    def test_oversized_body_is_413(self, place):
        api = WikiApi()
        resp = _post(_client(place, api), b'{"lat": 1, "lon": 2, "pad": "' + b"x" * (64 * 1024) + b'"}')
        assert resp.status_code == 413
        assert resp.json() == {"error": "too_large"}
        assert api.requests == []

    @pytest.mark.parametrize(
        "body",
        [
            "{not json",
            "[51.5, -0.12]",
            json.dumps({"lat": LAT}),
            json.dumps({"lon": LON}),
            json.dumps({"lat": LAT, "lon": LON, "extra": 1}),
            json.dumps({"lat": "51.5", "lon": LON}),
            json.dumps({"lat": True, "lon": LON}),
            json.dumps({"lat": None, "lon": LON}),
            '{"lat": NaN, "lon": 0}',
            '{"lat": 0, "lon": Infinity}',
            json.dumps({"lat": 90.0001, "lon": 0}),
            json.dumps({"lat": -90.0001, "lon": 0}),
            json.dumps({"lat": 0, "lon": 180.0001}),
            json.dumps({"lat": 0, "lon": -180.0001}),
        ],
        ids=[
            "malformed",
            "array",
            "missing-lon",
            "missing-lat",
            "unknown-key",
            "lat-string",
            "lat-bool",
            "lat-null",
            "lat-nan",
            "lon-infinity",
            "lat-over-90",
            "lat-under-minus-90",
            "lon-over-180",
            "lon-under-minus-180",
        ],
    )
    def test_bad_body_is_400_without_upstream_request(self, place, body):
        api = WikiApi()
        resp = _post(_client(place, api), body)
        assert resp.status_code == 400, resp.text
        assert resp.json() == {"error": "bad_request"}
        assert api.requests == []

    @pytest.mark.parametrize("lat,lon", [(90, 180), (-90, -180), (0, 0)], ids=["max", "min", "zero"])
    def test_boundary_coords_are_accepted(self, place, lat, lon):
        resp = _post(_client(place, WikiApi()), {"lat": lat, "lon": lon})
        assert resp.status_code == 200, resp.text
