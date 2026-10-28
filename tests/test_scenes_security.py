"""Contract (MEM-027, S4 security review): scene render hardening in `memripal.scenes`.

- A reply Pillow refuses with a non-OSError (e.g. a PNG zTXt chunk decompressing past
  PngImagePlugin.MAX_TEXT_CHUNK raises ValueError inside Image.open) is tier 3 reason "decode_error";
  render_scene never raises.
- The server-wide slot wait is bounded by `scenes.SLOT_WAIT_S` (seconds, > 0): with all
  MAX_CONCURRENT_SCENES slots held, a further scene is tier 3 reason "busy" with no model call. A slot is
  released on every path (success, any backend exception, a hostile reply), and a "busy" scene never
  releases a slot it did not take.
- Tier 1 output is a fresh JPEG with no model-supplied comment: no COM (0xFFFE) segment, whether the reply
  carried a JPEG COM segment or a PNG tEXt "comment".
"""

import importlib
import io
import struct
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager

import pytest
from PIL import Image, PngImagePlugin

from memripal.backend import BackendCallFailed, FixtureMissing
from memripal.imaging import validate_processed

ITEM = "milk carton"
LOCUS = "left book"
W, H = 64, 48
BOX = {"x1": 8, "y1": 6, "x2": 40, "y2": 30}
COMMENT_MARKER = "MODEL-COMMENT-MARKER-123"
FAST_WAIT_S = 0.05
JOIN_S = 10


def _img(w=W, h=H, fmt="JPEG", **save_kwargs) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (120, 80, 40)).save(buf, fmt, **save_kwargs)
    return buf.getvalue()


def ztxt_bomb_png() -> bytes:
    """A tiny valid PNG whose zTXt chunk inflates past Pillow's MAX_TEXT_CHUNK (Image.open -> ValueError)."""
    info = PngImagePlugin.PngInfo()
    info.add_text("k", "A" * (2 * PngImagePlugin.MAX_TEXT_CHUNK), zip=True)
    return _img(8, 8, "PNG", pnginfo=info)


def png_with_text_comment() -> bytes:
    info = PngImagePlugin.PngInfo()
    info.add_text("comment", COMMENT_MARKER)
    return _img(fmt="PNG", pnginfo=info)


PROCESSED = validate_processed(_img())
WEBP_SMALL = _img(32, 24, "WEBP")


def good_record(item=ITEM, locus=LOCUS):
    return {
        "item": item,
        "locus": locus,
        "kinesthetic": f"You grip a freezing {item} with both hands.",
        "auditory": "It glugs and sloshes like a drum.",
        "visual": "A towering white carton glows.",
        "emotional": "You feel giddy and a little scared.",
        "conceptual": "Calcium builds strong bones.",
        "olfactory": "Sour cream smell fills the air.",
        "gustatory": "Cold and sweet on your tongue.",
        "spatial": f"It balances on top of the {locus}.",
        "scene_prompt_details": "giant carton, dramatic light",
        "walk_cue": "Look up at the shelf.",
        "reencode_hint": "Picture the drum sound.",
        "question": "Why does cold storage keep it fresh longer?",
        "answer": "Low temperature slows bacterial growth.",
    }


def scenes():
    return importlib.import_module("memripal.scenes")


class FakeBackend:
    """Answers every call with `answer` (bytes or exception); counts calls."""

    mode = "fake"

    def __init__(self, answer=WEBP_SMALL):
        self.answer = answer
        self.calls = 0
        self._lock = threading.Lock()

    def call(self, req):
        with self._lock:
            self.calls += 1
        if isinstance(self.answer, BaseException):
            raise self.answer
        return self.answer


class HoldingBackend:
    """Each call signals `entered`, then blocks until `release` is set (or JOIN_S passes)."""

    mode = "fake"

    def __init__(self):
        self.entered = threading.Semaphore(0)
        self.release = threading.Event()

    def call(self, req):
        self.entered.release()
        if not self.release.wait(timeout=JOIN_S):
            raise AssertionError("holding backend was never released")
        return WEBP_SMALL


def _render(backend):
    return scenes().render_scene(backend, PROCESSED, BOX, good_record())


@contextmanager
def _all_slots_held():
    """Occupy every scene slot with an in-flight render; on exit release them and join."""
    cap = scenes().MAX_CONCURRENT_SCENES
    holder = HoldingBackend()
    pool = ThreadPoolExecutor(max_workers=cap)
    futures = [pool.submit(_render, holder) for _ in range(cap)]
    try:
        for _ in range(cap):
            assert holder.entered.acquire(timeout=JOIN_S), "slot holders never all entered the backend"
        yield
    finally:
        holder.release.set()
        held = [f.result(timeout=JOIN_S) for f in futures]
        pool.shutdown(wait=True)
    assert [s.tier for s in held] == [1] * cap


def _render_while_all_slots_held(backend):
    # Pool outermost: the slots are released before the pool joins, so an unbounded wait fails the
    # result() timeout below instead of deadlocking the test.
    with ThreadPoolExecutor(max_workers=1) as pool, _all_slots_held():
        return pool.submit(_render, backend).result(timeout=JOIN_S / 2)


def _jpeg_markers(data: bytes) -> list[int]:
    """Marker bytes of every JPEG segment from SOI up to and including SOS."""
    assert data[:2] == b"\xff\xd8", "not a JPEG"
    markers, i = [], 2
    while i + 4 <= len(data):
        assert data[i] == 0xFF, f"bad marker at byte {i}"
        marker = data[i + 1]
        markers.append(marker)
        if marker == 0xDA:
            break
        (length,) = struct.unpack(">H", data[i + 2 : i + 4])
        i += 2 + length
    return markers


# Covers: MEM-027
# Requirement: a hostile reply that makes Pillow raise anything other than OSError (a zTXt decompression
# bomb raises ValueError) is tier 3 "decode_error", and render_scene never raises.
class TestUndecodableReply:
    def test_ztxt_bomb_reply_is_tier3_decode_error(self):
        backend = FakeBackend(ztxt_bomb_png())
        scene = _render(backend)
        assert (scene.tier, scene.image, scene.reason) == (3, None, "decode_error")
        assert backend.calls == 1


# Covers: MEM-027
# Requirement: a scene waits a bounded time (scenes.SLOT_WAIT_S) for one of the server-wide slots; when all
# are held it is tier 3 "busy" without a model call, and slots are always given back.
class TestBoundedSlotWait:
    def test_slot_wait_is_a_positive_bounded_constant(self):
        wait = scenes().SLOT_WAIT_S
        assert isinstance(wait, int | float) and not isinstance(wait, bool)
        assert 0 < wait <= 60

    def test_scene_beyond_the_cap_is_tier3_busy_without_a_model_call(self, monkeypatch):
        monkeypatch.setattr(scenes(), "SLOT_WAIT_S", FAST_WAIT_S)
        extra = FakeBackend()
        scene = _render_while_all_slots_held(extra)
        assert (scene.tier, scene.image, scene.reason) == (3, None, "busy")
        assert extra.calls == 0

    def test_busy_scene_neither_leaks_nor_adds_a_slot(self, monkeypatch):
        monkeypatch.setattr(scenes(), "SLOT_WAIT_S", FAST_WAIT_S)
        for _ in range(2):
            assert _render_while_all_slots_held(FakeBackend()).reason == "busy"
        assert _render(FakeBackend()).tier == 1

    @pytest.mark.parametrize(
        "answer",
        [
            RuntimeError("boom"),
            FixtureMissing("nope"),
            BackendCallFailed("image_edit call failed: 503 server_error"),
            TimeoutError("slow"),
            b"<html>not an image</html>",
            ztxt_bomb_png(),
        ],
        ids=["runtime-error", "fixture-missing", "backend-failed", "timeout-error", "non-image", "ztxt-bomb"],
    )
    def test_slot_is_released_on_every_failure_path(self, monkeypatch, answer):
        monkeypatch.setattr(scenes(), "SLOT_WAIT_S", FAST_WAIT_S)
        for _ in range(scenes().MAX_CONCURRENT_SCENES + 1):
            assert _render(FakeBackend(answer)).tier == 3
        scene = _render(FakeBackend())
        assert scene.tier == 1, scene.reason


# Covers: MEM-027
# Requirement: no model-supplied comment survives into a tier-1 scene: the output JPEG has no COM segment
# whether the reply carried a JPEG comment or a PNG tEXt "comment".
class TestReplyCommentStripped:
    @pytest.mark.parametrize(
        "reply",
        [
            _img(fmt="JPEG", comment=COMMENT_MARKER.encode()),
            png_with_text_comment(),
        ],
        ids=["jpeg-com", "png-text-comment"],
    )
    def test_tier1_jpeg_has_no_comment_segment(self, reply):
        scene = _render(FakeBackend(reply))
        assert scene.tier == 1, scene.reason
        assert 0xFE not in _jpeg_markers(scene.image)
        assert COMMENT_MARKER.encode() not in scene.image
        with Image.open(io.BytesIO(scene.image)) as img:
            assert img.format == "JPEG"
            assert not img.info.get("comment")
