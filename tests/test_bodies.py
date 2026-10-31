# Requirement: The request-body parsers live in their own module (src/memripal/bodies.py) so app.py stays
# under its line budget; the move changes no behaviour, each parser is defined exactly once, and app.py
# shrinks to <= 515 lines to free room for the map-to-palace wiring.
# Covers: MEM-060
import json
import re
from pathlib import Path

import pytest
from starlette.requests import Request

REPO = Path(__file__).resolve().parents[1]
PKG = REPO / "src" / "memripal"
APP_PY = PKG / "app.py"
APP_LINE_CAP = 515
MOVED = ("_split_body", "_associate_body", "_scenes_body", "_box_ok", "_place_body", "_length_error")


def _request(headers: dict[str, str]) -> Request:
    raw = [(k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in headers.items()]
    return Request({"type": "http", "method": "POST", "path": "/", "headers": raw})


# Covers: MEM-060
class TestBudgetAndSingleDefinition:
    def test_app_py_within_line_budget(self):
        lines = len(APP_PY.read_text(encoding="utf-8").splitlines())
        assert lines <= APP_LINE_CAP, f"app.py has {lines} lines, cap {APP_LINE_CAP}"

    @pytest.mark.parametrize("name", MOVED)
    def test_each_moved_parser_defined_once_in_bodies(self, name):
        pattern = re.compile(rf"^(?:async\s+)?def {name}\(", re.MULTILINE)
        hits = [p.name for p in sorted(PKG.rglob("*.py")) if pattern.search(p.read_text(encoding="utf-8"))]
        assert hits == ["bodies.py"], f"{name} defined in {hits}"


# Covers: MEM-060
class TestParsersBehaveAsBefore:
    def test_split_body_accepts_well_typed_and_rejects_bad(self):
        from memripal.bodies import _split_body

        good = {"photo": "p", "mode": "list", "text": "a", "loci_count": 3}
        assert _split_body(json.dumps(good).encode()) == good
        assert _split_body(b"not json") is None
        assert _split_body(b"[]") is None
        assert _split_body(json.dumps({**good, "loci_count": True}).encode()) is None
        assert _split_body(json.dumps({**good, "loci_count": 0}).encode()) is None
        assert _split_body(json.dumps({**good, "mode": "other"}).encode()) is None

    def test_associate_body_requires_exact_keys_place_optional(self):
        from memripal.bodies import _associate_body

        good = {"image": "i", "item": "x", "locus": "l"}
        assert _associate_body(json.dumps(good).encode()) == good
        assert _associate_body(json.dumps({**good, "place": "p"}).encode()) == {**good, "place": "p"}
        assert _associate_body(json.dumps({**good, "extra": 1}).encode()) is None
        assert _associate_body(json.dumps({**good, "item": 5}).encode()) is None
        assert _associate_body(b"{") is None

    def test_scenes_body_requires_exact_keys_and_string_image(self):
        from memripal.bodies import _scenes_body

        good = {"image": "i", "box": {}, "record": {}, "sig": "s"}
        assert _scenes_body(json.dumps(good).encode()) == good
        assert _scenes_body(json.dumps({**good, "image": 1}).encode()) is None
        assert _scenes_body(json.dumps({"image": "i"}).encode()) is None

    def test_box_ok_boundaries(self):
        from memripal.bodies import _box_ok

        assert _box_ok({"x1": 0, "y1": 0, "x2": 10, "y2": 20}, 10, 20) is True
        assert _box_ok({"x1": 0, "y1": 0, "x2": 11, "y2": 20}, 10, 20) is False
        assert _box_ok({"x1": 5, "y1": 0, "x2": 5, "y2": 20}, 10, 20) is False
        assert _box_ok({"x1": True, "y1": 0, "x2": 5, "y2": 20}, 10, 20) is False
        assert _box_ok({"x1": 0, "y1": 0, "x2": 5}, 10, 20) is False
        assert _box_ok(None, 10, 20) is False

    def test_place_body_returns_coords_or_none(self):
        from memripal.bodies import _place_body

        assert _place_body(b'{"lat": 51.5, "lon": -0.1}') == (51.5, -0.1)
        assert _place_body(b'{"lat": 91, "lon": 0}') is None
        assert _place_body(b'{"lat": 1, "lon": 2, "x": 3}') is None
        assert _place_body(b"nope") is None

    def test_length_error_checks_content_length(self):
        from memripal.bodies import _length_error

        assert _length_error(_request({}), 100) is None
        assert _length_error(_request({"content-length": "100"}), 100) is None
        bad = _length_error(_request({"content-length": "1x"}), 100)
        assert (bad.status_code, json.loads(bad.body)) == (400, {"error": "bad_content_length"})
        big = _length_error(_request({"content-length": "101"}), 100)
        assert (big.status_code, json.loads(big.body)) == (413, {"error": "too_large"})
