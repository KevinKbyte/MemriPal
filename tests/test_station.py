# Covers: MEM-049
# Requirement: the station core (src/memripal/station.py) pixelates every person / licence-plate box
# deterministically before any photo leaves for Spark: pixelate(img, boxes) returns a new RGB image in
# which each box region is cut into at most 8 blocks across the box's long side (NEAREST resample down
# and back up), every pixel outside the boxes is byte-identical to the input, and the same photo +
# boxes always give the same pixels (golden sha pinned on the committed demo photo). The station-name
# shape rule valid_station_name(name) accepts a non-empty name of at most 3 words with no digits.
import hashlib
import io
import random
from pathlib import Path

import pytest
from PIL import Image

from memripal.probe_metrics import Box

REPO = Path(__file__).resolve().parents[1]
DEMO_PHOTO = REPO / "fixtures" / "demo" / "photo.jpg"
# sha256 of _reference_pixelate(demo photo, GOLDEN_BOXES).tobytes() under the pinned Pillow version.
GOLDEN_SHA = "a99893582ec79a2f074e089893ddcff045754b333d3e1913d0bdcf87e8cf697c"
GOLDEN_BOXES = [(100, 120, 500, 420), (600, 50, 700, 650)]
MAX_BLOCKS = 8


def _noise(w: int, h: int, seed: int = 0) -> Image.Image:
    """Every pixel random (seeded), so an untouched region has far more than 8 runs per row."""
    return Image.frombytes("RGB", (w, h), random.Random(seed).randbytes(w * h * 3))


def _box(x1: int, y1: int, x2: int, y2: int, img: Image.Image) -> Box:
    return Box(x1=x1, y1=y1, x2=x2, y2=y2, w=img.width, h=img.height)


def _runs(values: list) -> int:
    return 1 + sum(1 for a, b in zip(values, values[1:], strict=False) if a != b)


def _region_rows(img: Image.Image, box: tuple[int, int, int, int]) -> list[list]:
    region = img.crop(box)
    px = list(region.getdata())
    return [px[r * region.width : (r + 1) * region.width] for r in range(region.height)]


def _outside_identical(before: Image.Image, after: Image.Image, boxes: list[tuple]) -> bool:
    """Blank the boxes in copies of both images, then compare the rest byte for byte."""
    a, b = before.copy(), after.copy()
    for box in boxes:
        a.paste((0, 0, 0), box)
        b.paste((0, 0, 0), box)
    return a.size == b.size and a.tobytes() == b.tobytes()


def _reference_pixelate(img: Image.Image, boxes: list[tuple[int, int, int, int]]) -> Image.Image:
    """The pinned algorithm: per box in order, 8 blocks across the long side, NEAREST down then up."""
    out = img.copy()
    for x1, y1, x2, y2 in boxes:
        w, h = x2 - x1, y2 - y1
        long_side = max(w, h)
        bw, bh = max(1, round(w * MAX_BLOCKS / long_side)), max(1, round(h * MAX_BLOCKS / long_side))
        small = out.crop((x1, y1, x2, y2)).resize((bw, bh), Image.Resampling.NEAREST)
        out.paste(small.resize((w, h), Image.Resampling.NEAREST), (x1, y1))
    return out


class TestPixelate:
    def test_600px_person_box_has_at_most_8x8_blocks_and_outside_is_identical(self):
        from memripal.station import pixelate

        img = _noise(1000, 800)
        before = img.copy()
        box = (200, 100, 800, 700)
        out = pixelate(img, [_box(*box, img)])
        rows = _region_rows(out, box)
        cols = [list(c) for c in zip(*rows, strict=True)]
        assert max(_runs(r) for r in rows) <= MAX_BLOCKS
        assert max(_runs(c) for c in cols) <= MAX_BLOCKS
        assert len(set(px for r in rows for px in r)) <= MAX_BLOCKS * MAX_BLOCKS
        assert _outside_identical(before, out, [box])

    def test_box_region_actually_changes(self):
        from memripal.station import pixelate

        img = _noise(400, 300, seed=1)
        box = (50, 50, 250, 250)
        out = pixelate(img, [_box(*box, img)])
        assert out.crop(box).tobytes() != img.crop(box).tobytes()

    def test_non_square_box_has_at_most_8_blocks_along_its_long_side(self):
        from memripal.station import pixelate

        img = _noise(1000, 800, seed=2)
        box = (100, 100, 700, 250)  # 600 x 150
        out = pixelate(img, [_box(*box, img)])
        rows = _region_rows(out, box)
        cols = [list(c) for c in zip(*rows, strict=True)]
        assert max(_runs(r) for r in rows) <= MAX_BLOCKS
        assert max(_runs(c) for c in cols) <= MAX_BLOCKS
        assert _outside_identical(img, out, [box])

    def test_two_boxes_are_both_pixelated_and_the_rest_is_untouched(self):
        from memripal.station import pixelate

        img = _noise(800, 600, seed=3)
        boxes = [(10, 10, 210, 160), (500, 300, 780, 590)]
        out = pixelate(img, [_box(*b, img) for b in boxes])
        for b in boxes:
            assert max(_runs(r) for r in _region_rows(out, b)) <= MAX_BLOCKS
        assert _outside_identical(img, out, boxes)

    def test_no_boxes_leaves_every_pixel_unchanged(self):
        from memripal.station import pixelate

        img = _noise(320, 240, seed=4)
        assert pixelate(img, []).tobytes() == img.tobytes()

    def test_input_image_is_not_mutated(self):
        from memripal.station import pixelate

        img = _noise(320, 240, seed=5)
        before = img.tobytes()
        pixelate(img, [_box(20, 20, 200, 200, img)])
        assert img.tobytes() == before

    def test_same_input_gives_identical_pixels(self):
        from memripal.station import pixelate

        img = _noise(640, 480, seed=6)
        boxes = [_box(40, 40, 400, 300, img)]
        assert pixelate(img, boxes).tobytes() == pixelate(img.copy(), boxes).tobytes()


class TestPixelateGolden:
    def test_reference_oracle_still_matches_the_pinned_sha(self):
        # Guards the oracle itself: a drift here means the pinned Pillow version changed decode output.
        with Image.open(DEMO_PHOTO) as im:
            img = im.convert("RGB")
        assert hashlib.sha256(_reference_pixelate(img, GOLDEN_BOXES).tobytes()).hexdigest() == GOLDEN_SHA

    def test_demo_photo_with_fixed_boxes_matches_the_pinned_sha(self):
        from memripal.station import pixelate

        with Image.open(DEMO_PHOTO) as im:
            img = im.convert("RGB")
        out = pixelate(img, [_box(*b, img) for b in GOLDEN_BOXES])
        assert hashlib.sha256(out.tobytes()).hexdigest() == GOLDEN_SHA


class TestStationNameRule:
    @pytest.mark.parametrize("name", ["Arch", "Stone Arch", "Old Stone Arch", "Blue Door"])
    def test_accepts_one_to_three_words_without_digits(self, name):
        from memripal.station import valid_station_name

        assert valid_station_name(name) is True

    @pytest.mark.parametrize(
        "name",
        ["", "   ", "Big Old Stone Arch", "Arch 2", "Gate7", "12", None, 5, ["Arch"]],
        ids=[
            "empty",
            "blank",
            "four-words",
            "digit-word",
            "digit-inside",
            "only-digits",
            "none",
            "int",
            "list",
        ],
    )
    def test_refuses_empty_long_digit_or_non_string(self, name):
        from memripal.station import valid_station_name

        assert valid_station_name(name) is False


FIXED_PHRASE = "brick arch"
FIXED_TOKEN = "<|box;x1=10;y1=20;x2=110;y2=220;w=320;h=240|>"


def _reply(phrase: str) -> dict:
    return {
        "station_name": "Brick Arch",
        "landmark_phrase": phrase,
        "visual": "a red brick arch",
        "spatial": "over the path",
        "conceptual": "a gateway",
    }


class LandmarkBackend:
    """Spark replies in order (last repeats); blur SAM finds nothing; landmark SAM boxes only FIXED_PHRASE."""

    mode = "fake"

    def __init__(self, phrases):
        self.phrases = list(phrases)
        self.spark_calls = 0
        self.segment_subjects: list[str] = []

    def call(self, req):
        if req.method == "spark_json":
            self.spark_calls += 1
            return _reply(self.phrases[min(self.spark_calls, len(self.phrases)) - 1])
        self.segment_subjects.append(req.subject)
        return FIXED_TOKEN if req.subject == FIXED_PHRASE else ""


def _processed():
    from memripal.imaging import process_upload

    buf = io.BytesIO()
    _noise(320, 240, seed=7).save(buf, "JPEG", quality=90)
    return process_upload(buf.getvalue())


# Covers: MEM-079
# Requirement: the station box marks a FIXED structure only. A Spark landmark_phrase naming a movable thing
# (a word from MOVABLE_NOUNS, singular or plural, any case) breaks the reply contract: it is regenerated
# once, then BadReply, and no segment request ever carries that phrase, so it never becomes the box. A fixed
# phrase ("brick arch") still yields exactly one box.
class TestFixedLandmarkOnly:
    @pytest.mark.parametrize("phrase", ["red chair", "parked car", "person by door", "Two Bikes", "PEOPLE"])
    def test_movable_phrase_is_never_segmented_and_ends_in_bad_reply(self, phrase):
        from memripal.station import BadReply, run_station

        backend = LandmarkBackend([phrase])
        with pytest.raises(BadReply):
            run_station(backend, _processed(), [])
        assert phrase not in backend.segment_subjects
        assert backend.spark_calls == 2

    def test_movable_phrase_is_re_asked_and_a_fixed_one_gives_one_box(self):
        from memripal.station import run_station

        backend = LandmarkBackend(["parked car", FIXED_PHRASE])
        result = run_station(backend, _processed(), [])
        assert backend.spark_calls == 2
        assert "parked car" not in backend.segment_subjects
        assert backend.segment_subjects.count(FIXED_PHRASE) == 1
        assert (result.box.x1, result.box.y1, result.box.x2, result.box.y2) == (10, 20, 110, 220)

    @pytest.mark.parametrize("phrase", [FIXED_PHRASE, "carved door", "oak tree", "busy mural", "cartoon"])
    def test_fixed_phrase_passes_the_check(self, phrase):
        from memripal.station import movable_phrase

        assert movable_phrase(phrase) is False

    def test_denylist_is_the_agreed_set(self):
        from memripal.station import MOVABLE_NOUNS

        assert set(MOVABLE_NOUNS) == {
            "person", "people", "man", "woman", "child", "dog", "car", "bus", "bike", "scooter",
            "truck", "chair", "table", "cart", "bag", "umbrella", "cone",
        }  # fmt: skip
