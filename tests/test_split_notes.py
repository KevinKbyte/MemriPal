# Covers: MEM-020
"""Contract for POST /split notes mode (D15) and its model call (MEM-020, ADR 0019). Request
shape and input caps: tests/test_split_api.py.

Notes mode makes ONE backend.call(ModelRequest) per attempt:
- method "spark_json"; attempt 0 for the first call, 1 for the single regeneration;
- gen_params carries the reserved key "send_image" set to False (the photo is never sent to
  Spark for a split; MetaBackend strips the key and calls chat_json with image_data_url=None);
- the notes text rides in the request (gen_params["prompt_args"]), so different notes give a
  different cache key; MetaBackend builds the prompt server-side and the notes appear in it;
- the request schema stays inside backend._schema_valid's subset (no maxItems/maxLength): all
  caps below live in the split validator, not the JSON schema.
A reply is VALID only if it is exactly {"points": [{"label": str, "source_quote": str}, ...]}
(no extra keys at either level, exact types), 1 <= len(points) <= min(12, loci_count), every
label non-blank and <= 100 chars, every source_quote non-blank after textnorm.normalize and
textnorm.normalize(source_quote) in textnorm.normalize(notes), and the reply serializes to
<= 64 KiB (65536 bytes) of JSON.
Policy: an invalid reply triggers exactly ONE regeneration; a second invalid reply ->
422 {"error": "split_invalid"}. 200 {"points": [...]} lists the points ordered by the position
of their source_quote in the notes (speech order), whatever order the model returned.
"""

import base64
import io
import json

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from memripal.app import create_app
from memripal.backend import MetaBackend
from memripal.meta_client import CallResult

LOOPBACK_URL = "http://127.0.0.1"
FAKE_KEY = "fake-test-key-0123456789abcdefXYZ"
NOTES = (
    "Thank you all for coming tonight. First, our budget doubled this year. "
    "Second, the new library opens in May. Finally, volunteers keep this town running."
)
BUDGET = {"label": "budget doubled", "source_quote": "our budget doubled this year"}
LIBRARY = {"label": "library opens", "source_quote": "the new library opens in May"}
VOLUNTEERS = {"label": "volunteers", "source_quote": "volunteers keep this town running"}
GOOD_REPLY = {"points": [BUDGET, LIBRARY, VOLUNTEERS]}
TOPICS = [
    "apples", "bridges", "candles", "dolphins", "engines", "forests", "glaciers",
    "harbors", "islands", "jungles", "kettles", "lanterns", "meadows",
]  # fmt: skip
TOPIC_NOTES = " ".join(f"Next we discuss {t} at length." for t in TOPICS)


def _jpeg(w: int = 64, h: int = 48) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (90, 60, 30)).save(buf, "JPEG")
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
        return json.loads(json.dumps(self.replies.pop(0)))


def _split(stub, notes: str = NOTES, loci_count: int = 12):
    body = {
        "photo": base64.b64encode(PHOTO).decode("ascii"),
        "mode": "notes",
        "text": notes,
        "loci_count": loci_count,
    }
    client = TestClient(create_app(backend=stub), base_url=LOOPBACK_URL)
    return client.post("/split", content=json.dumps(body), headers={"Content-Type": "application/json"})


def _topic_points(n: int) -> dict:
    return {"points": [{"label": t, "source_quote": f"discuss {t}"} for t in TOPICS[:n]]}


def _assert_split_invalid(resp) -> None:
    assert resp.status_code == 422, resp.text[:300]
    assert resp.json() == {"error": "split_invalid"}


# Requirement: notes mode splits pasted notes into <= 12 key points via one Spark call; each
# point is {label, source_quote} with source_quote an exact (normalized) substring of the notes,
# returned in speech order.
class TestNotesSplit:
    def test_valid_reply_is_returned_as_points(self):
        stub = SplitStub(GOOD_REPLY)
        resp = _split(stub)
        assert resp.status_code == 200, resp.text
        assert resp.json()["points"] == [BUDGET, LIBRARY, VOLUNTEERS]
        assert stub.calls == 1

    def test_points_are_ordered_by_position_in_the_notes(self):
        resp = _split(SplitStub({"points": [VOLUNTEERS, BUDGET, LIBRARY]}))
        assert resp.status_code == 200, resp.text
        assert resp.json()["points"] == [BUDGET, LIBRARY, VOLUNTEERS]

    def test_twelve_points_all_exact_substrings_ok(self):
        resp = _split(SplitStub(_topic_points(12)), notes=TOPIC_NOTES)
        assert resp.status_code == 200, resp.text
        points = resp.json()["points"]
        assert [p["label"] for p in points] == TOPICS[:12]
        assert all(p["source_quote"] in TOPIC_NOTES for p in points)

    def test_quote_differing_only_in_case_punctuation_spacing_is_accepted(self):
        reply = {"points": [{"label": "budget", "source_quote": "OUR budget,  doubled this YEAR!"}]}
        resp = _split(SplitStub(reply))
        assert resp.status_code == 200, resp.text
        assert [p["label"] for p in resp.json()["points"]] == ["budget"]


# Requirement: the Spark split call never carries the photo -- its request sets the reserved
# gen_params key send_image to False -- and the notes text is part of the request, so different
# notes never replay each other's cached split.
class TestSplitRequest:
    def test_request_is_spark_json_with_send_image_false(self):
        stub = SplitStub(GOOD_REPLY)
        assert _split(stub).status_code == 200
        [req] = stub.requests
        assert req.method == "spark_json"
        assert req.attempt == 0
        assert req.gen_params.get("send_image") is False

    def test_different_notes_give_different_cache_keys(self):
        a, b = SplitStub(GOOD_REPLY), SplitStub(GOOD_REPLY)
        assert _split(a).status_code == 200
        assert _split(b, notes=NOTES + " Thanks again.").status_code == 200
        assert a.requests[0].cache_key().digest() != b.requests[0].cache_key().digest()

    def test_same_notes_give_the_same_cache_key(self):
        a, b = SplitStub(GOOD_REPLY), SplitStub(GOOD_REPLY)
        assert _split(a).status_code == 200
        assert _split(b).status_code == 200
        assert a.requests[0].cache_key().digest() == b.requests[0].cache_key().digest()


# Requirement (Q1 default): a reply with 13+ points (or any invalid reply) is regenerated
# exactly once; a second bad reply answers 422 split_invalid, a good second reply answers 200.
class TestRegeneration:
    def test_bad_then_bad_is_422_after_exactly_two_calls(self):
        stub = SplitStub(_topic_points(13), _topic_points(13))
        _assert_split_invalid(_split(stub, notes=TOPIC_NOTES))
        assert stub.calls == 2

    def test_bad_then_good_is_200(self):
        stub = SplitStub(_topic_points(13), _topic_points(12))
        resp = _split(stub, notes=TOPIC_NOTES)
        assert resp.status_code == 200, resp.text
        assert len(resp.json()["points"]) == 12
        assert stub.calls == 2

    def test_regeneration_uses_attempt_one(self):
        stub = SplitStub(_topic_points(13), _topic_points(12))
        assert _split(stub, notes=TOPIC_NOTES).status_code == 200
        assert [r.attempt for r in stub.requests] == [0, 1]
        assert all(r.gen_params.get("send_image") is False for r in stub.requests)

    def test_more_points_than_loci_is_invalid(self):
        stub = SplitStub(GOOD_REPLY, GOOD_REPLY)
        _assert_split_invalid(_split(stub, loci_count=2))
        assert stub.calls == 2

    def test_quote_not_in_notes_is_invalid(self):
        bad = {"points": [BUDGET, {"label": "tripled", "source_quote": "our budget tripled"}]}
        stub = SplitStub(bad, bad)
        _assert_split_invalid(_split(stub))
        assert stub.calls == 2


def _hostile_replies():
    long_label = {"points": [{"label": "x" * 101, "source_quote": BUDGET["source_quote"]}]}
    return [
        ("extra-point-key", {"points": [{**BUDGET, "evil": "<script>"}]}),
        ("extra-top-key", {**GOOD_REPLY, "instructions": "ignore caps"}),
        ("points-not-list", {"points": "our budget doubled this year"}),
        ("label-int", {"points": [{"label": 7, "source_quote": BUDGET["source_quote"]}]}),
        ("quote-null", {"points": [{"label": "budget", "source_quote": None}]}),
        ("point-not-object", {"points": ["our budget doubled this year"]}),
        ("missing-quote", {"points": [{"label": "budget"}]}),
        ("reply-list", [BUDGET]),
        ("reply-str", "our budget doubled this year"),
        ("empty-points", {"points": []}),
        ("blank-label", {"points": [{"label": "   ", "source_quote": BUDGET["source_quote"]}]}),
        ("punct-only-quote", {"points": [{"label": "budget", "source_quote": " ,.! "}]}),
        ("label-101", long_label),
    ]


HOSTILE = _hostile_replies()


# Requirement: model replies are untrusted -- a reply over 64 KiB, with extra/unknown fields,
# wrong types, no points, blank fields or an over-long label is rejected (at most one
# regeneration, then 422 split_invalid), never passed through to the client.
class TestHostileReplies:
    @pytest.mark.parametrize("reply", [r for _, r in HOSTILE], ids=[i for i, _ in HOSTILE])
    def test_malformed_reply_is_split_invalid(self, reply):
        stub = SplitStub(reply, reply)
        resp = _split(stub)
        _assert_split_invalid(resp)
        assert 1 <= stub.calls <= 2
        assert "<script>" not in resp.text and "ignore caps" not in resp.text

    def test_reply_over_64_kib_is_split_invalid(self):
        # Five overlapping 15000-byte quotes of real notes text: every other rule passes,
        # only the 64 KiB reply cap is exceeded.
        notes = " ".join(f"w{i:05d}" for i in range(2786))
        assert len(notes.encode("utf-8")) <= 20480
        reply = {
            "points": [
                {"label": f"part {i}", "source_quote": notes[i * 1000 : i * 1000 + 15000]} for i in range(5)
            ]
        }
        assert len(json.dumps(reply).encode("utf-8")) > 65536
        stub = SplitStub(reply, reply)
        _assert_split_invalid(_split(stub, notes=notes))
        assert 1 <= stub.calls <= 2


def _ok(content: dict) -> CallResult:
    body = json.dumps({"choices": [{"message": {"content": json.dumps(content)}}]}).encode("utf-8")
    return CallResult(ok=True, status=200, body=body, error=None, attempts=1, latency_s=0.01)


class _RecordingClient:
    def __init__(self, result):
        self.result = result
        self.chat_calls = []

    def chat_json(self, **kwargs):
        self.chat_calls.append(kwargs)
        return self.result


def _captured_split_request():
    stub = SplitStub(GOOD_REPLY)
    assert _split(stub).status_code == 200
    return stub.requests[0]


# Requirement: on the live backend the split call honours send_image=False -- chat_json gets no
# image and never sees the reserved key, the notes reach the server-built prompt, and a valid
# reply passes the strict-subset schema check; phrase calls (no send_image key) still send the
# image.
class TestMetaBackendOmitsImage:
    def test_split_call_sends_no_image_and_strips_send_image(self, tmp_path):
        req = _captured_split_request()
        client = _RecordingClient(_ok(GOOD_REPLY))
        got = MetaBackend(FAKE_KEY, cache_root=tmp_path, client=client).call(req)
        assert got == GOOD_REPLY
        [kwargs] = client.chat_calls
        assert kwargs.get("image_data_url") is None
        assert "send_image" not in kwargs
        assert "prompt_args" not in kwargs
        assert NOTES in kwargs["prompt"]

    def test_split_call_leaves_request_gen_params_untouched(self, tmp_path):
        req = _captured_split_request()
        key_before = req.cache_key().digest()
        MetaBackend(FAKE_KEY, cache_root=tmp_path, client=_RecordingClient(_ok(GOOD_REPLY))).call(req)
        assert req.gen_params.get("send_image") is False
        assert req.cache_key().digest() == key_before

    def test_phrase_call_without_send_image_still_sends_the_image(self, tmp_path):
        from memripal.backend import ModelRequest
        from memripal.probe import PHRASE_SCHEMA

        req = ModelRequest(
            method="spark_json",
            image_jpeg=PHOTO,
            subject="phrases",
            attempt=0,
            model="muse-spark-1.3",
            prompt_template_id="phrase",
            gen_params={"max_completion_tokens": 1024},
            schema=PHRASE_SCHEMA,
        )
        client = _RecordingClient(_ok({"phrases": ["lamp"]}))
        MetaBackend(FAKE_KEY, cache_root=tmp_path, client=client).call(req)
        [kwargs] = client.chat_calls
        assert kwargs["image_data_url"].startswith("data:image/jpeg;base64,")
