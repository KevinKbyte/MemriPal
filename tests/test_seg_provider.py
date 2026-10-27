# Covers: MEM-016
# Requirement: the segmentation provider is chosen by MEMRIPAL_SEG_PROVIDER (default "meta"; unknown values
# fail at startup with ValueError). The "modal" provider turns our own endpoint's box JSON into SAM-style
# token text so parse_boxes and everything downstream stay unchanged; a malformed reply yields zero boxes,
# never a raise.

import json

import httpx
import pytest

from memripal import seg_provider
from memripal.probe_metrics import Box, parse_boxes

ModalSegClient = seg_provider.ModalSegClient
select_seg_provider = seg_provider.select_seg_provider

BASE_URL = "https://seg.example.test"
TOKEN = "test-modal-token"
JPEG = b"\xff\xd8\xff\xe0fake-jpeg"


def _client(handler) -> ModalSegClient:
    return ModalSegClient(BASE_URL, TOKEN, transport=httpx.MockTransport(handler))


class TestSelectSegProvider:
    def test_default_selects_meta(self, monkeypatch):
        monkeypatch.delenv("MEMRIPAL_SEG_PROVIDER", raising=False)
        assert select_seg_provider() == "meta"

    def test_modal_selected_from_env(self, monkeypatch):
        monkeypatch.setenv("MEMRIPAL_SEG_PROVIDER", "modal")
        assert select_seg_provider() == "modal"

    def test_unknown_provider_raises_value_error(self, monkeypatch):
        monkeypatch.setenv("MEMRIPAL_SEG_PROVIDER", "openai")
        with pytest.raises(ValueError):
            select_seg_provider()


class TestModalSegClient:
    def test_two_boxes_map_to_two_parsed_boxes_with_confidence(self):
        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(
                200,
                json={
                    "boxes": [
                        {"x1": 10, "y1": 20, "x2": 110, "y2": 220, "score": 0.91},
                        {"x1": 300, "y1": 40, "x2": 420, "y2": 160, "score": 0.42},
                    ],
                    "w": 640,
                    "h": 480,
                },
            )

        text = _client(handler).segment(JPEG, "book")

        assert isinstance(text, str)
        assert parse_boxes(text) == [
            Box(x1=10, y1=20, x2=110, y2=220, w=640, h=480, confidence=0.91),
            Box(x1=300, y1=40, x2=420, y2=160, w=640, h=480, confidence=0.42),
        ]
        assert len(seen) == 1
        assert seen[0].url.host == "seg.example.test"
        assert seen[0].headers["Authorization"] == f"Bearer {TOKEN}"

    @pytest.mark.parametrize(
        "body",
        [
            b"not json at all",
            b'{"boxes": [',
            json.dumps({"boxes": "nope", "w": 640, "h": 480}).encode(),
            json.dumps(
                {"boxes": [{"x1": "a", "y1": 0, "x2": 5, "y2": 5, "score": 0.5}], "w": 640, "h": 480}
            ).encode(),
            json.dumps([1, 2, 3]).encode(),
        ],
    )
    def test_malformed_json_gives_zero_boxes_without_raising(self, body):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, content=body, headers={"Content-Type": "application/json"})

        text = _client(handler).segment(JPEG, "book")

        assert isinstance(text, str)
        assert parse_boxes(text) == []


# Covers: MEM-016
# Requirement: json.loads accepts NaN, Infinity, -Infinity and arbitrarily large ints; a Modal
# reply carrying any of them in a box coordinate or score drops just that box (the good boxes
# survive), and one in the frame size w/h yields zero boxes; parsing never raises.
class TestModalNonFiniteNumbers:
    GOOD = '{"x1": 10, "y1": 20, "x2": 110, "y2": 220, "score": 0.91}'
    HUGE = str(10**400)

    @staticmethod
    def _segment(body: bytes) -> str:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, content=body, headers={"Content-Type": "application/json"})

        return _client(handler).segment(JPEG, "book")

    @pytest.mark.parametrize("bad", ["NaN", "Infinity", "-Infinity", HUGE, "-" + HUGE])
    @pytest.mark.parametrize("field", ["x1", "y2", "score"])
    def test_non_finite_or_overflowing_box_number_drops_only_that_box(self, bad, field):
        values = {"x1": "300", "y1": "40", "x2": "420", "y2": "160", "score": "0.42"}
        values[field] = bad
        bad_box = "{" + ", ".join(f'"{k}": {v}' for k, v in values.items()) + "}"
        body = f'{{"boxes": [{self.GOOD}, {bad_box}], "w": 640, "h": 480}}'.encode()

        text = self._segment(body)

        assert parse_boxes(text) == [
            Box(x1=10, y1=20, x2=110, y2=220, w=640, h=480, confidence=0.91),
        ]

    @pytest.mark.parametrize("bad", ["NaN", "Infinity", "-Infinity", HUGE])
    @pytest.mark.parametrize("dim", ["w", "h"])
    def test_non_finite_or_overflowing_frame_size_gives_zero_boxes(self, bad, dim):
        size = {"w": "640", "h": "480"}
        size[dim] = bad
        body = f'{{"boxes": [{self.GOOD}], "w": {size["w"]}, "h": {size["h"]}}}'.encode()

        text = self._segment(body)

        assert isinstance(text, str)
        assert parse_boxes(text) == []
