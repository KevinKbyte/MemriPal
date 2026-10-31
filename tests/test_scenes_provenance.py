"""Contract (MEM-046, ADR amending 0024; plan D2/B1): scene provenance pass-through.

- `render_scene` returns the Muse Image reply bytes UNCHANGED (no decode/resize/re-encode): a tier-1
  `Scene.image` is byte-identical to the reply, model-supplied metadata (XMP, EXIF) included. The reply is
  still validated from its header + caps only (imaging._check_bytes, imaging._open_header).
- POST /scenes tier 1: the data URL mime follows the reply's format (webp -> image/webp, png -> image/png,
  jpeg -> image/jpeg); "width"/"height" stay the input photo's dims whatever size the reply is (the client
  zooms in fractions).
- An undecodable or over-cap reply is still tier 3 with its existing reason code.
- src/memripal/app.py stays <= 582 lines (plan D7 cap).
"""

import base64
import hashlib
import io
import json
import re
import threading
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from test_record_sign import KEY, KEY_ENV, _sign

from memripal.app import create_app
from memripal.imaging import MAX_UPLOAD_BYTES, validate_processed
from memripal.scenes import render_scene

ITEM = "milk carton"
LOCUS = "left book"
LOOPBACK_URL = "http://127.0.0.1"
W, H = 64, 48
BOX = {"x1": 8, "y1": 6, "x2": 40, "y2": 30}
APP_PY = Path(__file__).resolve().parents[1] / "src" / "memripal" / "app.py"
APP_PY_CAP = 582
XMP_MARKER = b"MODEL-XMP-PROVENANCE-MARKER"
XMP = b'<x:xmpmeta xmlns:x="adobe:ns:meta/">' + XMP_MARKER + b"</x:xmpmeta>"
EXIF = Image.Exif()
EXIF[0x0131] = "Muse Image test software"  # Software tag
DATA_URL = re.compile(r"data:(image/[a-z]+);base64,([A-Za-z0-9+/=]+)")


def _img(w=W, h=H, fmt="JPEG", mode="RGB", **save_kwargs) -> bytes:
    buf = io.BytesIO()
    Image.new(mode, (w, h), 0 if mode in ("1", "L") else (120, 80, 40)).save(buf, fmt, **save_kwargs)
    return buf.getvalue()


JPEG = _img()
PROCESSED = validate_processed(JPEG)
# Deliberately a different size than the photo: pass-through means no resize to (W, H).
WEBP_WITH_META = _img(32, 24, "WEBP", xmp=XMP, exif=EXIF.tobytes())
REPLIES = {
    "webp": _img(32, 24, "WEBP"),
    "png": _img(128, 96, "PNG"),
    "jpeg": _img(100, 100, "JPEG"),
}


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


class FakeBackend:
    """Answers every image_edit call with `answer` (bytes or callable(req)); counts calls."""

    mode = "fake"

    def __init__(self, answer):
        self.answer = answer
        self.calls = 0
        self._lock = threading.Lock()

    def call(self, req):
        with self._lock:
            self.calls += 1
        return self.answer(req) if callable(self.answer) else self.answer


def _render(reply):
    return render_scene(FakeBackend(reply), PROCESSED, BOX, good_record())


@pytest.fixture
def client_for(monkeypatch):
    monkeypatch.setenv(KEY_ENV, KEY)

    def make(backend):
        return TestClient(create_app(backend=backend), base_url=LOOPBACK_URL)

    return make


def _post_scene(client):
    record = good_record()
    body = {
        "image": "data:image/jpeg;base64," + base64.b64encode(JPEG).decode("ascii"),
        "box": dict(BOX),
        "record": record,
        "sig": _sign(record),
    }
    return client.post("/scenes", content=json.dumps(body), headers={"Content-Type": "application/json"})


def _tier1_image(resp):
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert payload.get("tier") == 1, payload
    match = DATA_URL.fullmatch(payload["image"])
    assert match, payload["image"][:40]
    return payload, match.group(1), base64.b64decode(match.group(2))


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# Covers: MEM-046
# Requirement: a tier-1 scene is the Muse Image reply exactly as the model returned it: its bytes (and so
# its provenance metadata, XMP/EXIF) pass through unchanged, never decoded, resized or re-encoded.
class TestScenePassThrough:
    def test_fixture_reply_really_carries_xmp_and_exif(self):
        assert XMP_MARKER in WEBP_WITH_META
        with Image.open(io.BytesIO(WEBP_WITH_META)) as img:
            assert img.format == "WEBP"
            assert img.info.get("exif")

    def test_render_scene_returns_the_reply_bytes_unchanged(self):
        scene = _render(WEBP_WITH_META)
        assert scene.tier == 1, scene.reason
        assert _sha(scene.image) == _sha(WEBP_WITH_META)

    def test_scenes_api_image_bytes_equal_the_reply_bytes(self, client_for):
        backend = FakeBackend(WEBP_WITH_META)
        payload, mime, image = _tier1_image(_post_scene(client_for(backend)))
        assert _sha(image) == _sha(WEBP_WITH_META)
        assert XMP_MARKER in image
        assert backend.calls == 1

    def test_reported_dims_stay_the_photo_dims_not_the_reply_dims(self, client_for):
        payload, _, image = _tier1_image(_post_scene(client_for(FakeBackend(WEBP_WITH_META))))
        assert (payload["width"], payload["height"]) == (W, H)
        with Image.open(io.BytesIO(image)) as img:
            assert img.size == (32, 24)


# Covers: MEM-046
# Requirement: the scene data URL's mime type matches the format Muse Image replied in (webp, png or
# jpeg), so the browser decodes the passed-through bytes as what they are.
class TestSceneMimeFollowsReplyFormat:
    @pytest.mark.parametrize("fmt", sorted(REPLIES), ids=sorted(REPLIES))
    def test_data_url_mime_matches_reply_format(self, client_for, fmt):
        reply = REPLIES[fmt]
        _, mime, image = _tier1_image(_post_scene(client_for(FakeBackend(reply))))
        assert mime == f"image/{fmt}"
        assert _sha(image) == _sha(reply)


def _pixel_bomb_png() -> bytes:
    # 6400 x 6400 = 40.96M pixels: over imaging.MAX_PIXELS with both sides under imaging.MAX_SIDE.
    return _img(6400, 6400, "PNG", mode="1")


def _over_cap_png() -> bytes:
    png = _img(W, H, "PNG")
    return png + b"\0" * (MAX_UPLOAD_BYTES + 1 - len(png))


# Covers: MEM-046
# Requirement: pass-through does not weaken reply validation: an undecodable or over-cap reply still falls
# back to tier 3 with its existing reason code.
class TestRejectedReplyKeepsReasons:
    @pytest.mark.parametrize(
        ("reply", "reason"),
        [
            (b"", "empty"),
            (b"<html><script>alert(1)</script></html>", "bad_magic"),
            (_img(fmt="GIF"), "bad_magic"),
            (b"RIFF\x00\x00\x00\x00WEBPgarbage", "decode_error"),
            (b"\x89PNG\r\n\x1a\n" + b"\x00" * 32, "decode_error"),
            (_over_cap_png(), "too_large"),
            (_pixel_bomb_png(), "pixel_bomb"),
            (_img(8001, 8, "PNG", mode="L"), "pixel_bomb"),
        ],
        ids=[
            "empty",
            "html",
            "gif",
            "truncated-webp",
            "png-bad-header",
            "over-cap",
            "pixel-bomb",
            "side-over-8000",
        ],
    )
    def test_rejected_reply_is_tier3_with_existing_reason(self, reply, reason):
        scene = _render(reply)
        assert (scene.tier, scene.image, scene.reason) == (3, None, reason)

    @pytest.mark.parametrize("reply", ["not bytes", None], ids=["str", "none"])
    def test_non_bytes_reply_is_tier3_not_bytes(self, reply):
        scene = _render(lambda req: reply)
        assert (scene.tier, scene.image, scene.reason) == (3, None, "not_bytes")


# Covers: MEM-046
# Requirement: app.py stays within the plan's 582-line budget after the mime lookup lands (D7).
def test_app_py_within_line_budget():
    lines = APP_PY.read_text(encoding="utf-8").count("\n")
    assert lines <= APP_PY_CAP, f"app.py is {lines} lines (cap {APP_PY_CAP})"
