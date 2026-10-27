# Covers: MEM-020
"""Contract for POST /split, input side (MEM-020, ADR 0019). Notes-mode model replies:
tests/test_split_notes.py.

Request: Content-Type application/json (else 415 {"error": "unsupported_media_type"}), body
  {"photo": <standard base64 of the processed JPEG, no data: prefix>,
   "mode": "list" | "notes",
   "text": <the typed list or the pasted notes>,
   "loci_count": <int 1..12, the number of loci on the route>}
The photo is decoded (bad base64 -> 400 {"error": "bad_base64"}) and re-checked with
imaging.validate_processed: ImageRejected -> its status + {"error": code} (e.g. 400 not_jpeg,
400 too_big_side, 400 has_exif, 413 too_large).
Malformed body (not JSON, not an object, missing/ill-typed field, unknown mode, loci_count not an
int in 1..12, bool included) -> 422 {"error": "bad_request"}.
Caps, each 422 with its own code, checked before any model call:
- list text > 4096 UTF-8 bytes -> "list_too_large" (exactly 4096 ok);
- notes text > 20480 UTF-8 bytes -> "notes_too_large" (exactly 20480 ok);
- list item (a stripped line) > 100 chars -> "item_too_long" (exactly 100 ok);
- list items > loci_count (loci_count <= 12) -> "too_many_items" (12 of 12 ok, 13 rejected);
- no non-blank list line, or blank notes -> "no_items".
List mode: text split on \n / \r\n, each line stripped, blank lines dropped, order kept; NO
model call. 200 {"points": [{"label": item, "source_quote": item}, ...]}.
Errors mirror POST /loci: FixtureMissing -> 404 {"error": "fixture_missing"}, BackendCallFailed
-> 502 {"error": "upstream"}; error bodies are only {"error": code}.
"""

import base64
import io
import json

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from memripal.app import create_app
from memripal.backend import BackendCallFailed, FixtureBackend
from memripal.imaging import MAX_UPLOAD_BYTES

LOOPBACK_URL = "http://127.0.0.1"
LEAK_MARKER = "MODEL-SAID-SECRET-TEXT"
NOTES = (
    "Thank you all for coming tonight. First, our budget doubled this year. "
    "Second, the new library opens in May. Finally, volunteers keep this town running."
)
GOOD_REPLY = {
    "points": [
        {"label": "budget doubled", "source_quote": "our budget doubled this year"},
        {"label": "library opens", "source_quote": "the new library opens in May"},
        {"label": "volunteers", "source_quote": "volunteers keep this town running"},
    ]
}


def _jpeg(w: int = 64, h: int = 48, **save_kwargs) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (90, 60, 30)).save(buf, "JPEG", **save_kwargs)
    return buf.getvalue()


PHOTO = _jpeg()


class SplitStub:
    """ModelBackend stand-in: hands out the queued replies in order and records every request."""

    mode = "fake"

    def __init__(self, *replies):
        self.replies = list(replies)
        self.requests = []

    @property
    def calls(self) -> int:
        return len(self.requests)

    def call(self, req):
        self.requests.append(req)
        if not self.replies:
            raise AssertionError("unexpected extra backend call")
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return json.loads(json.dumps(reply))


def _client(backend) -> TestClient:
    return TestClient(create_app(backend=backend), base_url=LOOPBACK_URL)


def _body(text: str, mode: str = "list", loci_count: int = 12, photo: bytes = PHOTO) -> dict:
    return {
        "photo": base64.b64encode(photo).decode("ascii"),
        "mode": mode,
        "text": text,
        "loci_count": loci_count,
    }


def _post(client: TestClient, body=None, *, raw: bytes | None = None, content_type="application/json"):
    content = raw if raw is not None else json.dumps(body).encode("utf-8")
    return client.post("/split", content=content, headers={"Content-Type": content_type})


def _assert_error(resp, status: int, code: str) -> None:
    assert resp.status_code == status, resp.text[:300]
    assert resp.json() == {"error": code}


def _items(n: int) -> list[str]:
    return [f"item number {i}" for i in range(1, n + 1)]


# Requirement: a line-separated typed list is used as-is -- each non-blank line, stripped, in
# order, becomes one point whose label and source_quote are the item -- with no model call.
class TestListMode:
    def test_lines_become_points_in_order_without_a_model_call(self):
        stub = SplitStub()
        resp = _post(_client(stub), _body("milk\neggs\nbread", loci_count=10))
        assert resp.status_code == 200, resp.text
        assert resp.json()["points"] == [
            {"label": "milk", "source_quote": "milk"},
            {"label": "eggs", "source_quote": "eggs"},
            {"label": "bread", "source_quote": "bread"},
        ]
        assert stub.calls == 0

    def test_lines_are_stripped_blank_lines_dropped_and_crlf_accepted(self):
        stub = SplitStub()
        resp = _post(_client(stub), _body("  milk \r\n\r\n   \neggs\n\n", loci_count=10))
        assert resp.status_code == 200, resp.text
        assert [p["label"] for p in resp.json()["points"]] == ["milk", "eggs"]
        assert stub.calls == 0

    def test_every_point_has_exactly_label_and_source_quote(self):
        resp = _post(_client(SplitStub()), _body("milk\neggs", loci_count=10))
        assert resp.status_code == 200, resp.text
        for point in resp.json()["points"]:
            assert set(point) == {"label", "source_quote"}


# Requirement: items <= loci <= 12 -- a list with more items than loci, or more than 12, is
# refused with 422 too_many_items before any model call; 12 items on 12 loci pass.
class TestItemCountCap:
    def test_twelve_items_on_twelve_loci_ok(self):
        stub = SplitStub()
        resp = _post(_client(stub), _body("\n".join(_items(12)), loci_count=12))
        assert resp.status_code == 200, resp.text
        assert [p["label"] for p in resp.json()["points"]] == _items(12)
        assert stub.calls == 0

    def test_thirteen_items_rejected(self):
        stub = SplitStub()
        _assert_error(
            _post(_client(stub), _body("\n".join(_items(13)), loci_count=12)), 422, "too_many_items"
        )
        assert stub.calls == 0

    def test_more_items_than_loci_rejected(self):
        _assert_error(
            _post(_client(SplitStub()), _body("\n".join(_items(11)), loci_count=10)), 422, "too_many_items"
        )

    def test_items_equal_to_loci_ok(self):
        resp = _post(_client(SplitStub()), _body("\n".join(_items(10)), loci_count=10))
        assert resp.status_code == 200, resp.text
        assert len(resp.json()["points"]) == 10

    @pytest.mark.parametrize("text", ["", "\n\n", "   \r\n  "], ids=["empty", "newlines", "blank"])
    def test_no_items_rejected(self, text):
        stub = SplitStub()
        _assert_error(_post(_client(stub), _body(text)), 422, "no_items")
        assert stub.calls == 0


# Requirement: a list item longer than 100 characters is refused with 422 item_too_long;
# exactly 100 characters passes.
class TestItemLengthCap:
    def test_hundred_char_item_ok(self):
        resp = _post(_client(SplitStub()), _body("a" * 100 + "\nmilk"))
        assert resp.status_code == 200, resp.text
        assert resp.json()["points"][0]["label"] == "a" * 100

    def test_hundred_and_one_char_item_rejected(self):
        stub = SplitStub()
        _assert_error(_post(_client(stub), _body("milk\n" + "a" * 101)), 422, "item_too_long")
        assert stub.calls == 0


# Requirement: list text over 4 KB (4096 UTF-8 bytes) is refused with 422 list_too_large;
# exactly 4096 bytes passes; the cap counts bytes, not characters.
class TestListSizeCap:
    def test_exactly_4096_bytes_ok(self):
        text = "milk\neggs" + "\n" * (4096 - 9)
        assert len(text.encode("utf-8")) == 4096
        resp = _post(_client(SplitStub()), _body(text))
        assert resp.status_code == 200, resp.text
        assert [p["label"] for p in resp.json()["points"]] == ["milk", "eggs"]

    def test_4097_bytes_rejected(self):
        text = "milk\neggs" + "\n" * (4097 - 9)
        assert len(text.encode("utf-8")) == 4097
        stub = SplitStub()
        _assert_error(_post(_client(stub), _body(text)), 422, "list_too_large")
        assert stub.calls == 0

    def test_cap_counts_utf8_bytes_not_characters(self):
        text = "caf\u00e9" + "\n" * (4097 - 5)
        assert len(text) == 4096 and len(text.encode("utf-8")) == 4097
        _assert_error(_post(_client(SplitStub()), _body(text)), 422, "list_too_large")


# Requirement: notes over 20 KB (20480 UTF-8 bytes) are refused with 422 notes_too_large before
# any model call; exactly 20480 bytes passes; blank notes are refused with 422 no_items.
class TestNotesSizeCap:
    def test_exactly_20480_bytes_ok(self):
        notes = NOTES + " " * (20480 - len(NOTES))
        assert len(notes.encode("utf-8")) == 20480
        stub = SplitStub(GOOD_REPLY)
        resp = _post(_client(stub), _body(notes, mode="notes"))
        assert resp.status_code == 200, resp.text
        assert stub.calls == 1

    def test_20481_bytes_rejected(self):
        notes = NOTES + " " * (20481 - len(NOTES))
        assert len(notes.encode("utf-8")) == 20481
        stub = SplitStub(GOOD_REPLY)
        _assert_error(_post(_client(stub), _body(notes, mode="notes")), 422, "notes_too_large")
        assert stub.calls == 0

    @pytest.mark.parametrize("notes", ["", "   \n\t "], ids=["empty", "blank"])
    def test_blank_notes_rejected(self, notes):
        stub = SplitStub(GOOD_REPLY)
        _assert_error(_post(_client(stub), _body(notes, mode="notes")), 422, "no_items")
        assert stub.calls == 0


# Requirement: a malformed request body (not JSON, not an object, missing or ill-typed fields,
# unknown mode, loci_count outside 1..12) answers 422 {"error": "bad_request"} with no model
# call, and a non-JSON Content-Type answers 415 unsupported_media_type.
class TestRequestValidation:
    @pytest.mark.parametrize(
        "mutate",
        [
            lambda b: b.pop("photo"),
            lambda b: b.pop("mode"),
            lambda b: b.pop("text"),
            lambda b: b.pop("loci_count"),
            lambda b: b.update(mode="poem"),
            lambda b: b.update(text=["milk"]),
            lambda b: b.update(photo=123),
            lambda b: b.update(loci_count=0),
            lambda b: b.update(loci_count=13),
            lambda b: b.update(loci_count="12"),
            lambda b: b.update(loci_count=True),
            lambda b: b.update(loci_count=10.5),
        ],
        ids=[
            "no-photo", "no-mode", "no-text", "no-loci", "bad-mode", "text-list", "photo-int",
            "loci-0", "loci-13", "loci-str", "loci-bool", "loci-float",
        ],
    )  # fmt: skip
    def test_bad_field_is_422_bad_request(self, mutate):
        body = _body("milk\neggs", loci_count=10)
        mutate(body)
        stub = SplitStub()
        _assert_error(_post(_client(stub), body), 422, "bad_request")
        assert stub.calls == 0

    @pytest.mark.parametrize(
        "raw", [b"not json", b"[1, 2]", b'"milk"', b""], ids=["text", "array", "str", "empty"]
    )
    def test_non_object_body_is_422_bad_request(self, raw):
        _assert_error(_post(_client(SplitStub()), raw=raw), 422, "bad_request")

    @pytest.mark.parametrize("content_type", ["text/plain", "image/jpeg", "multipart/form-data"])
    def test_non_json_content_type_is_415(self, content_type):
        stub = SplitStub()
        resp = _post(_client(stub), _body("milk"), content_type=content_type)
        _assert_error(resp, 415, "unsupported_media_type")
        assert stub.calls == 0


# Requirement: the client-held processed photo is base64-decoded and re-checked by
# validate_processed on every /split request; a bad or oversize photo is a 4xx with its fixed
# code and no model call.
class TestPhotoRevalidation:
    def _photo_post(self, photo_b64: str):
        stub = SplitStub(GOOD_REPLY)
        body = _body(NOTES, mode="notes")
        body["photo"] = photo_b64
        return _post(_client(stub), body), stub

    @pytest.mark.parametrize("photo_b64", ["!!!not-base64!!!", "abc", "data:image/jpeg;base64,AAAA"])
    def test_bad_base64_is_400(self, photo_b64):
        resp, stub = self._photo_post(photo_b64)
        _assert_error(resp, 400, "bad_base64")
        assert stub.calls == 0

    @pytest.mark.parametrize(
        "photo,status,code",
        [
            (b"", 400, "empty"),
            (b"GIF89a" + b"\x00" * 64, 400, "bad_magic"),
            (b"\xff\xd8\xff" + b"not really a jpeg" * 8, 400, "decode_error"),
            (None, 400, "not_jpeg"),
            (_jpeg(3000, 100), 400, "too_big_side"),
        ],
        ids=["empty", "bad_magic", "decode_error", "png", "too_big_side"],
    )
    def test_rejected_photo_maps_to_status_and_code(self, photo, status, code):
        if photo is None:
            buf = io.BytesIO()
            Image.new("RGB", (64, 48)).save(buf, "PNG")
            photo = buf.getvalue()
        resp, stub = self._photo_post(base64.b64encode(photo).decode("ascii"))
        _assert_error(resp, status, code)
        assert stub.calls == 0

    def test_photo_with_exif_is_rejected(self):
        exif = Image.Exif()
        exif[0x010F] = "SecretCamMaker"
        resp, stub = self._photo_post(base64.b64encode(_jpeg(exif=exif.tobytes())).decode("ascii"))
        _assert_error(resp, 400, "has_exif")
        assert stub.calls == 0

    def test_photo_over_upload_cap_is_413(self):
        photo = b"\xff\xd8\xff" + b"\x00" * (MAX_UPLOAD_BYTES - 2)
        assert len(photo) == MAX_UPLOAD_BYTES + 1
        resp, stub = self._photo_post(base64.b64encode(photo).decode("ascii"))
        _assert_error(resp, 413, "too_large")
        assert stub.calls == 0


# Requirement: notes-mode model failures map like POST /loci -- a missing fixture is 404
# fixture_missing and a failed upstream call is 502 upstream, with no model or exception text.
class TestUpstreamErrors:
    def test_backend_call_failed_is_502_without_model_text(self):
        failure = BackendCallFailed(f"spark_json call failed: 500 {LEAK_MARKER}")
        resp = _post(_client(SplitStub(failure, failure)), _body(NOTES, mode="notes"))
        _assert_error(resp, 502, "upstream")
        assert LEAK_MARKER not in resp.text
        assert "spark_json" not in resp.text

    def test_fixture_missing_is_404(self, tmp_path):
        resp = _post(_client(FixtureBackend(tmp_path)), _body(NOTES, mode="notes"))
        _assert_error(resp, 404, "fixture_missing")
