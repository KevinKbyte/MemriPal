# Covers: MEM-053
"""Contract (MEM-053): Mapillary street-photo baseline per station, fetched by a backend proxy.

Covers: MEM-053

Module `memripal.baseline`:
- `BaselineProvider(token: str, transport: httpx.BaseTransport | None = None)`; `.lookup(lat, lon)` returns
  exactly {"image", "author", "image_url", "licence"} or raises `NoBaseline` / `BaselineFailed`.
- Outbound search: GET `GRAPH_IMAGES_URL` (https://graph.mapillary.com/images, the Graph API image search).
  The client token rides ONLY in the `Authorization: OAuth <token>` header (the live doc allows it for Entity
  API calls and strongly discourages ?access_token=); never in any URL, never sent to the CDN.
  Every decimal in the outbound query has <= 4 dp (coords rounded before any outbound call).
- Pick: the nearest image within `RADIUS_M` (30 m) that has a `thumb_1024_url`; far / thumb-less images are
  skipped even when the API returns them; none left -> `NoBaseline` (route: 404 {"error": "no_baseline"}).
- Thumb fetch: https only, host must end with one of `CDN_HOST_SUFFIXES` (Mapillary thumbs are served from
  *.fbcdn.net), redirects never followed (a 3xx is a failure), body capped at `MAX_IMAGE_BYTES`. Any breach
  -> `BaselineFailed` (route: 502 {"error": "upstream"}) with no further fetch.
- `image` is a `data:image/jpeg;base64,` URL of a Pillow re-encode carrying no EXIF; `author` is
  creator.username; `image_url` is an https link to the image page on www.mapillary.com containing the image
  id; `licence` == `LICENCE` (CC BY-SA). The raw CDN URL never appears in the response.
- Logs: no record (any logger, any level, incl. httpx) carries the coords or the token.
- `FixtureBaselineProvider(root)` replays `replay_path(root, lat, lon)` (a JSON file holding the response
  object) and never touches the network; a missing file -> `NoBaseline`.

Module `memripal.routes_baseline`: `baseline_router(provider, passcode_error, *, call_budget=None,
max_concurrent=...)` -> APIRouter serving POST /baseline (exercised further in test_baseline_api.py).
"""

import base64
import importlib
import io
import json
import logging
import random
import re

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

# Covers: MEM-053
# Requirement: a station's baseline street photo comes from Mapillary through a backend proxy that keeps
# the token server-side (header only), sends coords at <= 4 dp, fetches only https thumbs from the
# Mapillary CDN without following redirects, strips EXIF, credits the CC BY-SA author, and never logs
# coords or the token; fixture mode replays offline.

TOKEN = "fake-mly-token-for-tests-0000"
LAT, LON = 51.50071234, -0.12461987
COORD_STRINGS = ("51.5007", "0.1246", "51.50071", "0.12461")
IMAGE_ID = "1122334455667788"
CDN_HOST = "scontent-lhr8-1.xx.fbcdn.net"
THUMB_URL = f"https://{CDN_HOST}/m1/v/t6/thumb_{IMAGE_ID}.jpg?stp=s1024x768"
AUTHOR = "street_walker_test"
EXIF_MARKER = "LeakyCamTestMake"
DEG_PER_M = 1 / 111_320


def _jpeg_with_exif() -> bytes:
    exif = Image.Exif()
    exif[0x010F] = EXIF_MARKER  # Make
    buf = io.BytesIO()
    Image.new("RGB", (64, 48), (120, 140, 160)).save(buf, "JPEG", exif=exif.tobytes())
    data = buf.getvalue()
    assert EXIF_MARKER.encode() in data
    return data


def _image(image_id=IMAGE_ID, north_m=0.0, thumb=THUMB_URL, author=AUTHOR, lat=LAT, lon=LON) -> dict:
    point = {"type": "Point", "coordinates": [round(lon, 4), round(lat, 4) + north_m * DEG_PER_M]}
    rec = {
        "id": image_id,
        "computed_geometry": point,
        "geometry": point,
        "creator": {"username": author, "id": "42"},
        "captured_at": 1700000000000,
        "is_pano": False,
    }
    if thumb is not None:
        rec["thumb_1024_url"] = thumb
    return rec


class FakeMapillary:
    """MockTransport handler: Graph search answers `graph`, CDN thumbs answer `cdn`; records every request."""

    def __init__(self, data=None, cdn=None, graph_status=200):
        self.data = [_image()] if data is None else data
        self.cdn = cdn or (lambda req: httpx.Response(200, content=_jpeg_with_exif()))
        self.graph_status = graph_status
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.url.host == "graph.mapillary.com":
            if self.graph_status != 200:
                return httpx.Response(self.graph_status, json={"error": {"message": "boom"}})
            return httpx.Response(200, json={"data": self.data})
        return self.cdn(request)

    def graph_requests(self):
        return [r for r in self.requests if r.url.host == "graph.mapillary.com"]

    def other_requests(self):
        return [r for r in self.requests if r.url.host != "graph.mapillary.com"]


@pytest.fixture
def baseline():
    return importlib.import_module("memripal.baseline")


@pytest.fixture
def routes():
    return importlib.import_module("memripal.routes_baseline")


def _client(routes, provider) -> TestClient:
    app = FastAPI()
    app.include_router(routes.baseline_router(provider, lambda request: None))
    return TestClient(app)


def _post(client, lat=LAT, lon=LON):
    return client.post("/baseline", json={"lat": lat, "lon": lon})


def _provider(baseline, fake):
    return baseline.BaselineProvider(TOKEN, transport=httpx.MockTransport(fake))


class TestOutboundRequest:
    def test_token_rides_only_in_the_authorization_header(self, baseline):
        fake = FakeMapillary()
        _provider(baseline, fake).lookup(LAT, LON)
        (graph,) = fake.graph_requests()
        assert graph.url.scheme == "https"
        assert str(graph.url).startswith(baseline.GRAPH_IMAGES_URL)
        assert graph.headers.get("authorization") == f"OAuth {TOKEN}"
        assert "access_token" not in graph.url.params
        for req in fake.requests:
            assert TOKEN not in str(req.url)

    def test_token_is_never_sent_to_the_cdn(self, baseline):
        fake = FakeMapillary()
        _provider(baseline, fake).lookup(LAT, LON)
        cdn = fake.other_requests()
        assert len(cdn) == 1
        assert "authorization" not in cdn[0].headers
        assert TOKEN not in str(cdn[0].headers)

    def test_outbound_coords_have_at_most_4_dp_for_20_random_inputs(self, baseline):
        rng = random.Random(53)
        for _ in range(20):
            lat, lon = rng.uniform(-89.9, 89.9), rng.uniform(-179.9, 179.9)
            fake = FakeMapillary(data=[_image(lat=lat, lon=lon)])
            _provider(baseline, fake).lookup(lat, lon)
            (graph,) = fake.graph_requests()
            for _key, value in graph.url.params.multi_items():
                for frac in re.findall(r"\d\.(\d+)", value):
                    assert len(frac) <= 4, f"{value!r} carries more than 4 dp (input {lat}, {lon})"


class TestCdnGuard:
    def test_non_allowlisted_thumb_host_is_502_with_no_thumb_fetch(self, baseline, routes):
        fake = FakeMapillary(data=[_image(thumb="https://evil.example.com/x.jpg")])
        resp = _post(_client(routes, _provider(baseline, fake)))
        assert resp.status_code == 502
        assert resp.json() == {"error": "upstream"}
        assert fake.other_requests() == []

    def test_http_thumb_url_is_502_with_no_thumb_fetch(self, baseline, routes):
        fake = FakeMapillary(data=[_image(thumb=f"http://{CDN_HOST}/thumb.jpg")])
        resp = _post(_client(routes, _provider(baseline, fake)))
        assert resp.status_code == 502
        assert fake.other_requests() == []

    def test_cross_host_redirect_is_502_and_never_followed(self, baseline, routes):
        def redirect(req):
            return httpx.Response(302, headers={"Location": "https://evil.example.com/stolen.jpg"})

        fake = FakeMapillary(cdn=redirect)
        resp = _post(_client(routes, _provider(baseline, fake)))
        assert resp.status_code == 502
        assert [r.url.host for r in fake.other_requests()] == [CDN_HOST]

    def test_thumb_over_the_byte_cap_is_502(self, baseline, routes):
        big = b"\xff\xd8" + b"\x00" * baseline.MAX_IMAGE_BYTES
        fake = FakeMapillary(cdn=lambda req: httpx.Response(200, content=big))
        resp = _post(_client(routes, _provider(baseline, fake)))
        assert resp.status_code == 502

    def test_graph_api_error_is_502(self, baseline, routes):
        fake = FakeMapillary(graph_status=500)
        resp = _post(_client(routes, _provider(baseline, fake)))
        assert resp.status_code == 502
        assert fake.other_requests() == []


class TestPick:
    def test_success_response_shape_credit_and_link(self, baseline, routes):
        fake = FakeMapillary()
        resp = _post(_client(routes, _provider(baseline, fake)))
        assert resp.status_code == 200
        body = resp.json()
        assert set(body) == {"image", "author", "image_url", "licence"}
        assert body["author"] == AUTHOR
        assert body["image_url"].startswith("https://www.mapillary.com/")
        assert IMAGE_ID in body["image_url"]
        assert body["licence"] == baseline.LICENCE
        assert "CC BY-SA" in baseline.LICENCE
        assert body["image"].startswith("data:image/jpeg;base64,")
        assert CDN_HOST not in resp.text and "fbcdn" not in resp.text

    def test_nearest_image_within_radius_wins(self, baseline):
        far_in_radius = _image(image_id="111", north_m=25, author="farther")
        near = _image(image_id="222", north_m=5, author="nearer")
        out = _provider(baseline, FakeMapillary(data=[far_in_radius, near])).lookup(LAT, LON)
        assert out["author"] == "nearer"
        assert "222" in out["image_url"]

    @pytest.mark.parametrize(
        "data",
        [[], [_image(north_m=100)], [_image(thumb=None)]],
        ids=["no-images", "only-beyond-30m", "only-without-thumb"],
    )
    def test_no_usable_image_is_404_no_baseline(self, baseline, routes, data):
        fake = FakeMapillary(data=data)
        resp = _post(_client(routes, _provider(baseline, fake)))
        assert resp.status_code == 404
        assert resp.json() == {"error": "no_baseline"}
        assert fake.other_requests() == []


class TestExifStripped:
    def test_response_jpeg_carries_no_exif(self, baseline):
        out = _provider(baseline, FakeMapillary()).lookup(LAT, LON)
        raw = base64.b64decode(out["image"].split(",", 1)[1])
        assert raw[:2] == b"\xff\xd8"
        assert b"Exif\x00\x00" not in raw
        assert EXIF_MARKER.encode() not in raw
        with Image.open(io.BytesIO(raw)) as img:
            assert img.format == "JPEG"
            assert dict(img.getexif()) == {}


class TestLogsCarryNoSecrets:
    @pytest.mark.parametrize("graph_status", [200, 500], ids=["success", "upstream-failure"])
    def test_no_record_carries_coords_or_token(self, baseline, routes, caplog, graph_status):
        caplog.set_level(logging.DEBUG)
        caplog.set_level(logging.DEBUG, logger="httpx")
        caplog.set_level(logging.DEBUG, logger="httpcore")
        _post(_client(routes, _provider(baseline, FakeMapillary(graph_status=graph_status))))
        fmt = logging.Formatter("%(name)s %(message)s")
        for record in caplog.records:
            text = fmt.format(record) + repr(record.args)
            assert TOKEN not in text, f"token in log: {record.name}"
            for coord in COORD_STRINGS:
                assert coord not in text, f"coords in log: {record.name}: {text[:200]}"


class TestFixtureReplay:
    REPLAY = {
        "image": "data:image/jpeg;base64,/9j/AA==",
        "author": "replayed_author",
        "image_url": f"https://www.mapillary.com/app/?pKey={IMAGE_ID}",
        "licence": "CC BY-SA 4.0",
    }

    @pytest.fixture
    def offline(self, monkeypatch):
        def refuse(*args, **kwargs):
            raise AssertionError("fixture replay touched the network")

        monkeypatch.setattr(httpx.HTTPTransport, "handle_request", refuse)

    def test_recorded_answer_replays_offline_for_rounded_coords(self, baseline, routes, tmp_path, offline):
        path = baseline.replay_path(tmp_path, round(LAT, 4), round(LON, 4))
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.REPLAY), encoding="ascii")
        resp = _post(_client(routes, baseline.FixtureBaselineProvider(tmp_path)))
        assert resp.status_code == 200
        assert resp.json() == self.REPLAY

    def test_missing_recording_is_404_no_baseline(self, baseline, routes, tmp_path, offline):
        resp = _post(_client(routes, baseline.FixtureBaselineProvider(tmp_path)))
        assert resp.status_code == 404
        assert resp.json() == {"error": "no_baseline"}
