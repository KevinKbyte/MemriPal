# Covers: MEM-098
# Requirement: every /baseline answer carries the credit data a derived scene must show (ADR 0064): a
# non-empty contributor `author`, `image_url` == "https://www.mapillary.com/app/?pKey=<id>", and `licence`
# == "CC BY-SA 4.0", alongside `image`. A live hit with no contributor username is never picked (the credit
# block could not name the creator), and fixture mode refuses a recording that does not carry a valid
# credit instead of replaying it. Zero live network calls.
"""Contract (MEM-098, extends MEM-053):

- `BaselineProvider.lookup` returns {"image", "author", "image_url", "licence"} plus MEM-137 `candidates`;
  `image_url` is the literal page prefix "https://www.mapillary.com/app/?pKey=" + the image id; `licence` ==
  "CC BY-SA 4.0".
- Images whose `creator.username` is missing, empty or blank are skipped like thumb-less ones: the nearest
  credited image within radius wins; none credited -> `NoBaseline` (route: 404 no_baseline).
- `FixtureBaselineProvider.lookup` replays only a recording that is a dict with exactly those four keys,
  `image` a "data:image/jpeg;base64," URL, `author` a non-blank str, `image_url` the page prefix + a
  non-empty id, `licence` == "CC BY-SA 4.0"; any other recording -> `NoBaseline`.
"""

import importlib
import json

import httpx
import pytest
from test_baseline import AUTHOR, IMAGE_ID, LAT, LON, FakeMapillary, _image, _provider

PAGE_PREFIX = "https://www.mapillary.com/app/?pKey="
LICENCE = "CC BY-SA 4.0"
RLAT, RLON = round(LAT, 4), round(LON, 4)
VALID = {
    "image": "data:image/jpeg;base64,/9j/AA==",
    "author": "replayed_author",
    "image_url": f"{PAGE_PREFIX}{IMAGE_ID}",
    "licence": LICENCE,
}


@pytest.fixture
def baseline():
    return importlib.import_module("memripal.baseline")


@pytest.fixture
def offline(monkeypatch):
    def refuse(*args, **kwargs):
        raise AssertionError("baseline lookup touched the network")

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", refuse)


def _uncredited(image_id: str, north_m: float, creator) -> dict:
    rec = _image(image_id=image_id, north_m=north_m)
    if creator is _MISSING:
        rec.pop("creator")
    else:
        rec["creator"] = creator
    return rec


_MISSING = object()
UNCREDITED_CREATORS = [_MISSING, None, {}, {"username": ""}, {"username": "   "}, {"username": None}]
UNCREDITED_IDS = [
    "no-creator",
    "creator-null",
    "creator-empty",
    "username-empty",
    "username-blank",
    "username-null",
]


class TestLiveCreditFields:
    def test_hit_returns_exact_page_url_and_licence(self, baseline):
        out = _provider(baseline, FakeMapillary()).lookup(LAT, LON)
        assert set(out) == {"image", "author", "image_url", "licence", "candidates"}  # candidates: MEM-137
        assert out["image_url"] == f"{PAGE_PREFIX}{IMAGE_ID}"
        assert out["licence"] == LICENCE
        assert out["author"] == AUTHOR
        assert out["image"].startswith("data:image/jpeg;base64,")

    @pytest.mark.parametrize("creator", UNCREDITED_CREATORS, ids=UNCREDITED_IDS)
    def test_nearest_uncredited_image_is_skipped_for_a_credited_one(self, baseline, creator):
        near_uncredited = _uncredited("333", 2, creator)
        far_credited = _image(image_id="444", north_m=20, author="credited_one")
        out = _provider(baseline, FakeMapillary(data=[near_uncredited, far_credited])).lookup(LAT, LON)
        assert out["author"] == "credited_one"
        assert out["image_url"] == f"{PAGE_PREFIX}444"

    @pytest.mark.parametrize("creator", UNCREDITED_CREATORS, ids=UNCREDITED_IDS)
    def test_only_uncredited_images_is_no_baseline_with_no_thumb_fetch(self, baseline, creator):
        fake = FakeMapillary(data=[_uncredited("555", 3, creator)])
        with pytest.raises(baseline.NoBaseline):
            _provider(baseline, fake).lookup(LAT, LON)
        assert fake.other_requests() == []


def _record(baseline, root, payload) -> None:
    path = baseline.replay_path(root, RLAT, RLON)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="ascii")


BAD_RECORDINGS = {
    "licence-nc": {**VALID, "licence": "CC BY-NC-SA 4.0"},
    "licence-missing": {k: v for k, v in VALID.items() if k != "licence"},
    "licence-old-version": {**VALID, "licence": "CC BY-SA 3.0"},
    "url-other-host": {**VALID, "image_url": "https://example.com/p/1"},
    "url-javascript": {**VALID, "image_url": "javascript:alert(1)"},
    "url-http": {**VALID, "image_url": f"http://www.mapillary.com/app/?pKey={IMAGE_ID}"},
    "url-lookalike-host": {
        **VALID,
        "image_url": f"https://www.mapillary.com.evil.example/app/?pKey={IMAGE_ID}",
    },
    "url-no-id": {**VALID, "image_url": PAGE_PREFIX},
    "url-missing": {k: v for k, v in VALID.items() if k != "image_url"},
    "author-empty": {**VALID, "author": ""},
    "author-blank": {**VALID, "author": "   "},
    "author-missing": {k: v for k, v in VALID.items() if k != "author"},
    "author-not-str": {**VALID, "author": 42},
    "image-cdn-url": {**VALID, "image": "https://scontent-lhr8-1.xx.fbcdn.net/t.jpg"},
    "image-missing": {k: v for k, v in VALID.items() if k != "image"},
    "extra-key": {**VALID, "thumb_1024_url": "https://scontent-lhr8-1.xx.fbcdn.net/t.jpg"},
    "not-a-dict": [VALID],
}


class TestFixtureCreditFields:
    def test_valid_recording_replays_exactly(self, baseline, tmp_path, offline):
        _record(baseline, tmp_path, VALID)
        out = baseline.FixtureBaselineProvider(tmp_path).lookup(RLAT, RLON)
        assert out == VALID

    @pytest.mark.parametrize("payload", list(BAD_RECORDINGS.values()), ids=list(BAD_RECORDINGS))
    def test_recording_without_a_valid_credit_is_no_baseline(self, baseline, tmp_path, offline, payload):
        _record(baseline, tmp_path, payload)
        with pytest.raises(baseline.NoBaseline):
            baseline.FixtureBaselineProvider(tmp_path).lookup(RLAT, RLON)
