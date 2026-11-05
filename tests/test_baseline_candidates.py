# Covers: MEM-137
"""Contract (MEM-137, ADR 0080; additive over MEM-053 / MEM-098): POST /baseline returns candidates.

- `memripal.baseline.MAX_CANDIDATES == 4`; the Graph search `fields` param also asks for `compass_angle` and
  `captured_at`.
- `BaselineProvider.lookup` keeps the four top-level single-image fields {"image", "author", "image_url",
  "licence"} unchanged (they equal the nearest candidate) and adds `candidates`: a list, nearest first, of at
  most MAX_CANDIDATES dicts with exactly {"image", "author", "image_url", "licence", "lat", "lon",
  "compass_angle", "captured_at"}. `image` is a `data:image/jpeg;base64,` EXIF-free re-encode of that
  record's thumb, fetched through the same CDN guards (https, *.fbcdn.net, no redirects, byte cap), one CDN
  fetch per candidate; `lat`/`lon` are the record's point (computed geometry preferred); `compass_angle` a
  number or None; `captured_at` an int (epoch ms) or None.
- Records with no thumb, no author, a malformed point or beyond RADIUS_M are skipped. A candidate whose thumb
  fetch or guard fails is skipped (no fetch to a non-allowlisted host) as long as one candidate survives; none
  surviving -> BaselineFailed (502 upstream), as before.
- No log record carries the station coords.
- `baseline_router`: a provider answer that has no `candidates` key (a legacy single-answer provider, e.g.
  `FixtureBaselineProvider` replays and `default_baseline_provider("fixture", ...)`) is answered as the
  legacy fields plus `candidates == [that answer]`; an answer that has `candidates` passes through unchanged.
"""

import base64
import importlib
import io
import json
import logging

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image
from test_baseline import AUTHOR, CDN_HOST, COORD_STRINGS, EXIF_MARKER, LAT, LON, FakeMapillary, _image

# Covers: MEM-137
# Requirement: to let the client pick the best Mapillary photo for a photo-less landmark (camera facing,
# distance, recency), POST /baseline also returns up to 4 nearby credited candidates, nearest first, each with
# its own guarded EXIF-free JPEG thumb, position, compass angle and capture time; one broken thumb never sinks
# the whole pull; the old single-image fields stay as they were (the nearest candidate) and a legacy
# single-answer provider still answers as one candidate; coords are never logged.

TOKEN = "fake-mly-token-for-tests-0000"
PAGE_PREFIX = "https://www.mapillary.com/app/?pKey="
LEGACY_KEYS = {"image", "author", "image_url", "licence"}
CANDIDATE_KEYS = LEGACY_KEYS | {"lat", "lon", "compass_angle", "captured_at"}
OK = {
    "image": "data:image/jpeg;base64,/9j/AA==",
    "author": "someone",
    "image_url": f"{PAGE_PREFIX}1",
    "licence": "CC BY-SA 4.0",
}


def _thumb(image_id: str) -> str:
    return f"https://{CDN_HOST}/m1/v/t6/thumb_{image_id}.jpg?stp=s1024x768"


def _rec(image_id: str, north_m: float, **over) -> dict:
    rec = _image(image_id=image_id, north_m=north_m, thumb=_thumb(image_id), author=f"user_{image_id}")
    rec.update(over)
    return rec


def _jpeg() -> bytes:
    exif = Image.Exif()
    exif[0x010F] = EXIF_MARKER
    buf = io.BytesIO()
    Image.new("RGB", (32, 24), (90, 100, 110)).save(buf, "JPEG", exif=exif.tobytes())
    return buf.getvalue()


def _cdn_failing(*bad_ids: str):
    def handler(req: httpx.Request) -> httpx.Response:
        if any(f"thumb_{i}." in req.url.path for i in bad_ids):
            return httpx.Response(500)
        return httpx.Response(200, content=_jpeg())

    return handler


@pytest.fixture
def baseline():
    return importlib.import_module("memripal.baseline")


@pytest.fixture
def routes():
    return importlib.import_module("memripal.routes_baseline")


def _provider(baseline, fake):
    return baseline.BaselineProvider(TOKEN, transport=httpx.MockTransport(fake))


def _client(routes, provider) -> TestClient:
    app = FastAPI()
    app.include_router(routes.baseline_router(provider, lambda request: None))
    return TestClient(app)


def _post(client, lat=LAT, lon=LON):
    return client.post("/baseline", json={"lat": lat, "lon": lon})


def _ids(cands) -> list[str]:
    return [c["image_url"][len(PAGE_PREFIX) :] for c in cands]


class _Legacy:
    def __init__(self, answer):
        self.answer = answer

    def lookup(self, lat, lon):
        return dict(self.answer)


class TestConstantsAndFields:
    def test_max_candidates_is_4(self, baseline):
        assert baseline.MAX_CANDIDATES == 4

    def test_graph_search_asks_for_compass_angle_and_captured_at(self, baseline):
        fake = FakeMapillary(data=[_rec("1", 5)], cdn=_cdn_failing())
        _provider(baseline, fake).lookup(LAT, LON)
        (graph,) = fake.graph_requests()
        fields = graph.url.params["fields"].split(",")
        assert "compass_angle" in fields
        assert "captured_at" in fields


class TestCandidateList:
    def test_candidates_nearest_first_with_exact_keys(self, baseline):
        data = [_rec("far", 25), _rec("near", 3), _rec("mid", 12)]
        out = _provider(baseline, FakeMapillary(data=data, cdn=_cdn_failing())).lookup(LAT, LON)
        assert isinstance(out["candidates"], list)
        assert _ids(out["candidates"]) == ["near", "mid", "far"]
        for c in out["candidates"]:
            assert set(c) == CANDIDATE_KEYS
            assert c["image"].startswith("data:image/jpeg;base64,")
            assert c["licence"] == baseline.LICENCE
            assert c["image_url"].startswith(PAGE_PREFIX)
        assert [c["author"] for c in out["candidates"]] == ["user_near", "user_mid", "user_far"]

    def test_top_level_fields_unchanged_and_equal_the_nearest_candidate(self, baseline):
        data = [_rec("far", 25), _rec("near", 3)]
        out = _provider(baseline, FakeMapillary(data=data, cdn=_cdn_failing())).lookup(LAT, LON)
        assert set(out) == LEGACY_KEYS | {"candidates"}
        first = out["candidates"][0]
        for key in LEGACY_KEYS:
            assert out[key] == first[key], key
        assert out["image_url"] == f"{PAGE_PREFIX}near"

    def test_capped_at_max_candidates_with_one_cdn_fetch_each(self, baseline):
        n = baseline.MAX_CANDIDATES + 3
        data = [_rec(f"r{i}", i * 3) for i in range(n)]
        fake = FakeMapillary(data=data, cdn=_cdn_failing())
        out = _provider(baseline, fake).lookup(LAT, LON)
        assert _ids(out["candidates"]) == [f"r{i}" for i in range(baseline.MAX_CANDIDATES)]
        assert len(fake.other_requests()) == baseline.MAX_CANDIDATES

    def test_position_compass_and_capture_time_carried(self, baseline):
        rec = _rec("a", 8, compass_angle=187.5, captured_at=1712345678901)
        out = _provider(baseline, FakeMapillary(data=[rec], cdn=_cdn_failing())).lookup(LAT, LON)
        (c,) = out["candidates"]
        lon, lat = rec["computed_geometry"]["coordinates"]
        assert c["lat"] == pytest.approx(lat)
        assert c["lon"] == pytest.approx(lon)
        assert c["compass_angle"] == pytest.approx(187.5)
        assert c["captured_at"] == 1712345678901
        assert isinstance(c["captured_at"], int) and not isinstance(c["captured_at"], bool)

    def test_computed_geometry_preferred_for_position(self, baseline):
        rec = _rec("a", 8)
        raw = {"type": "Point", "coordinates": [round(LON, 4) + 0.0001, round(LAT, 4)]}
        rec["geometry"] = raw
        out = _provider(baseline, FakeMapillary(data=[rec], cdn=_cdn_failing())).lookup(LAT, LON)
        lon, lat = rec["computed_geometry"]["coordinates"]
        assert out["candidates"][0]["lon"] == pytest.approx(lon)
        assert out["candidates"][0]["lat"] == pytest.approx(lat)

    @pytest.mark.parametrize(
        ("over", "angle", "captured"),
        [
            ({}, None, None),
            ({"compass_angle": None, "captured_at": None}, None, None),
            ({"compass_angle": "north", "captured_at": "2024-01-01"}, None, None),
            ({"compass_angle": True, "captured_at": True}, None, None),
            ({"compass_angle": 0, "captured_at": 0}, 0, 0),
        ],
        ids=["absent", "null", "strings", "bools", "zeros-kept"],
    )
    def test_missing_or_malformed_compass_and_time_are_null(self, baseline, over, angle, captured):
        rec = _rec("a", 4)
        rec.pop("captured_at", None)
        rec.update(over)
        out = _provider(baseline, FakeMapillary(data=[rec], cdn=_cdn_failing())).lookup(LAT, LON)
        (c,) = out["candidates"]
        assert c["compass_angle"] == angle
        assert c["captured_at"] == captured
        if angle is None:
            assert c["compass_angle"] is None
        if captured is None:
            assert c["captured_at"] is None

    def test_every_candidate_image_is_exif_free_jpeg(self, baseline):
        data = [_rec("a", 2), _rec("b", 9)]
        out = _provider(baseline, FakeMapillary(data=data, cdn=_cdn_failing())).lookup(LAT, LON)
        assert len(out["candidates"]) == 2
        for c in out["candidates"]:
            raw = base64.b64decode(c["image"].split(",", 1)[1])
            assert raw[:2] == b"\xff\xd8"
            assert EXIF_MARKER.encode() not in raw
            with Image.open(io.BytesIO(raw)) as img:
                assert dict(img.getexif()) == {}

    def test_raw_cdn_url_never_in_the_response(self, baseline, routes):
        data = [_rec("a", 2), _rec("b", 9)]
        resp = _post(_client(routes, _provider(baseline, FakeMapillary(data=data, cdn=_cdn_failing()))))
        assert resp.status_code == 200
        assert len(resp.json()["candidates"]) == 2
        assert "fbcdn" not in resp.text and CDN_HOST not in resp.text


class TestSkippedRecords:
    def test_uncredited_malformed_thumbless_and_far_records_are_skipped(self, baseline):
        no_author = _rec("noauthor", 2)
        no_author["creator"] = {"username": "  ", "id": "9"}
        bad_point = _rec("badpoint", 3)
        bad_point["computed_geometry"] = {"type": "Point", "coordinates": ["x", 1]}
        bad_point["geometry"] = {"type": "Point", "coordinates": [1]}
        no_thumb = _rec("nothumb", 4)
        no_thumb.pop("thumb_1024_url")
        far = _rec("far", 100)
        good = _rec("good", 10)
        fake = FakeMapillary(data=[no_author, bad_point, no_thumb, far, good], cdn=_cdn_failing())
        out = _provider(baseline, fake).lookup(LAT, LON)
        assert _ids(out["candidates"]) == ["good"]
        assert out["author"] == "user_good"
        assert len(fake.other_requests()) == 1

    def test_a_failed_thumb_skips_that_candidate_only(self, baseline):
        data = [_rec("broken", 2), _rec("ok1", 6), _rec("ok2", 14)]
        fake = FakeMapillary(data=data, cdn=_cdn_failing("broken"))
        out = _provider(baseline, fake).lookup(LAT, LON)
        assert _ids(out["candidates"]) == ["ok1", "ok2"]
        assert out["image_url"] == f"{PAGE_PREFIX}ok1"
        assert out["author"] == "user_ok1"

    def test_a_non_allowlisted_thumb_is_skipped_without_fetching_it(self, baseline):
        evil = _rec("evil", 2, thumb_1024_url="https://evil.example.com/x.jpg")
        insecure = _rec("insecure", 3, thumb_1024_url=f"http://{CDN_HOST}/thumb_insecure.jpg")
        fake = FakeMapillary(data=[evil, insecure, _rec("ok", 9)], cdn=_cdn_failing())
        out = _provider(baseline, fake).lookup(LAT, LON)
        assert _ids(out["candidates"]) == ["ok"]
        hosts = [(r.url.scheme, r.url.host) for r in fake.other_requests()]
        assert hosts == [("https", CDN_HOST)]

    def test_a_redirecting_thumb_is_skipped_and_never_followed(self, baseline):
        def cdn(req):
            if "thumb_hop." in req.url.path:
                return httpx.Response(302, headers={"Location": "https://evil.example.com/s.jpg"})
            return httpx.Response(200, content=_jpeg())

        fake = FakeMapillary(data=[_rec("hop", 2), _rec("ok", 9)], cdn=cdn)
        out = _provider(baseline, fake).lookup(LAT, LON)
        assert _ids(out["candidates"]) == ["ok"]
        assert all(r.url.host == CDN_HOST for r in fake.other_requests())

    def test_all_thumbs_failing_is_502_upstream_but_one_survivor_is_200(self, baseline, routes):
        fake = FakeMapillary(data=[_rec("b1", 2), _rec("b2", 6)], cdn=_cdn_failing("b1", "b2"))
        resp = _post(_client(routes, _provider(baseline, fake)))
        assert resp.status_code == 502
        assert resp.json() == {"error": "upstream"}
        fake = FakeMapillary(data=[_rec("b1", 2), _rec("ok", 6)], cdn=_cdn_failing("b1"))
        resp = _post(_client(routes, _provider(baseline, fake)))
        assert resp.status_code == 200
        assert _ids(resp.json()["candidates"]) == ["ok"]


class TestLogs:
    @pytest.mark.parametrize("bad", [(), ("b1",)], ids=["all-ok", "one-thumb-fails"])
    def test_no_record_carries_the_coords(self, baseline, routes, caplog, bad):
        caplog.set_level(logging.DEBUG)
        caplog.set_level(logging.DEBUG, logger="httpx")
        caplog.set_level(logging.DEBUG, logger="httpcore")
        fake = FakeMapillary(data=[_rec("b1", 2), _rec("b2", 6)], cdn=_cdn_failing(*bad))
        resp = _post(_client(routes, _provider(baseline, fake)))
        assert resp.status_code == 200
        assert len(resp.json()["candidates"]) == 2 - len(bad)
        fmt = logging.Formatter("%(name)s %(message)s")
        for record in caplog.records:
            text = fmt.format(record) + repr(record.args)
            assert TOKEN not in text
            for coord in COORD_STRINGS:
                assert coord not in text, f"coords in log: {record.name}: {text[:200]}"


class TestRouteCandidatesContract:
    def test_legacy_single_answer_provider_is_one_candidate(self, routes):
        resp = _post(_client(routes, _Legacy(OK)))
        assert resp.status_code == 200
        assert resp.json() == {**OK, "candidates": [OK]}

    def test_answer_with_candidates_passes_through_unchanged_while_legacy_is_wrapped(self, routes):
        cand = {**OK, "lat": 1.0, "lon": 2.0, "compass_angle": None, "captured_at": None}
        answer = {**OK, "candidates": [cand]}
        resp = _post(_client(routes, _Legacy(answer)))
        assert resp.status_code == 200
        assert resp.json() == answer
        legacy = _post(_client(routes, _Legacy(OK)))
        assert legacy.json()["candidates"] == [OK]

    def test_live_provider_through_the_route_returns_candidates(self, baseline, routes):
        fake = FakeMapillary(data=[_rec("near", 2), _rec("far", 20)], cdn=_cdn_failing())
        resp = _post(_client(routes, _provider(baseline, fake)))
        assert resp.status_code == 200
        body = resp.json()
        assert set(body) == LEGACY_KEYS | {"candidates"}
        assert _ids(body["candidates"]) == ["near", "far"]
        assert body["author"] == "user_near" != AUTHOR

    def test_fixture_replay_is_one_candidate(self, baseline, routes, tmp_path):
        path = baseline.replay_path(tmp_path, round(LAT, 4), round(LON, 4))
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(OK), encoding="ascii")
        resp = _post(_client(routes, baseline.FixtureBaselineProvider(tmp_path)))
        assert resp.status_code == 200
        assert resp.json() == {**OK, "candidates": [OK]}

    def test_default_fixture_mode_provider_is_one_candidate(self, baseline, routes, tmp_path):
        path = baseline.replay_path(tmp_path, round(LAT, 4), round(LON, 4))
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(OK), encoding="ascii")
        provider = routes.default_baseline_provider("fixture", tmp_path)
        resp = _post(_client(routes, provider))
        assert resp.status_code == 200
        assert resp.json() == {**OK, "candidates": [OK]}
