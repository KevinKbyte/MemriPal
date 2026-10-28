# Covers: MEM-036
"""Contract (MEM-036, ADR 0027): signed association records between POST /associate and POST /scenes.

- Key: MEMRIPAL_RECORD_KEY read once at create_app, stripped, blank = unset; unset -> 32 random bytes per
  app, so a record signed by one app instance never verifies on another. Never logged or returned.
- /associate 200 with a record adds "sig": lowercase hex HMAC-SHA256(key, canonical(record)), canonical =
  json.dumps(record, sort_keys=True, separators=(",", ":"), ensure_ascii=True).
- /scenes body is exactly {image, box, record, sig} (other key sets -> 400 "bad_request"); sig not a str or
  not matching -> 403 {"error": "bad_signature"}, before record caps, photo decode or any model call.
- Caps: spatial, visual, scene_prompt_details each <= 300 chars; over -> /scenes 400 "bad_record", and the
  /associate validator refuses the same records.
"""

import base64
import hashlib
import hmac
import io
import json
import logging
import re

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from memripal.app import create_app
from memripal.backend import PROMPT_ARGS

ITEM = "milk carton"
LOCUS = "left book"
LOOPBACK_URL = "http://127.0.0.1"
KEY = "KEY-MARKER-memripal-record-7f3a9c"
KEY_ENV = "MEMRIPAL_RECORD_KEY"
W, H = 64, 48
BOX = {"x1": 8, "y1": 6, "x2": 40, "y2": 30}
CAP = 300
CAPPED_FIELDS = ("spatial", "visual", "scene_prompt_details")
HEX_SIG = re.compile(r"[0-9a-f]{64}")
ASSOCIATE_KEYS = {"item", "locus", "status", "attempts", "record"}


def _img(w=W, h=H, fmt="JPEG") -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (120, 80, 40)).save(buf, fmt)
    return buf.getvalue()


JPEG = _img()
WEBP_SMALL = _img(32, 24, "WEBP")


def _data_url(data: bytes = JPEG) -> str:
    return "data:image/jpeg;base64," + base64.b64encode(data).decode("ascii")


def good_record(item=ITEM, locus=LOCUS, **over):
    rec = {
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
    rec.update(over)
    return rec


def _padded(field: str, length: int) -> dict:
    """good_record with `field` padded to exactly `length` chars, still naming item/locus where it did."""
    base = good_record()[field]
    return good_record(**{field: base + " " + "x" * (length - len(base) - 1)})


def _sign(record, key: str = KEY) -> str:
    canonical = json.dumps(record, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hmac.new(key.encode("utf-8"), canonical.encode("ascii"), hashlib.sha256).hexdigest()


class FakeBackend:
    """Spark calls echo a valid record (or answer `record`); image_edit returns a small WEBP; counts calls."""

    mode = "fake"

    def __init__(self, record=None):
        self.record = record
        self.calls = 0

    def call(self, req):
        self.calls += 1
        if req.method == "image_edit":
            return WEBP_SMALL
        if self.record is not None:
            return json.loads(json.dumps(self.record))
        args = req.gen_params[PROMPT_ARGS]
        return good_record(item=args["item"], locus=args["locus"])


def _client(backend) -> TestClient:
    return TestClient(create_app(backend=backend), base_url=LOOPBACK_URL)


def _post(client, path, body):
    content = json.dumps(body) if isinstance(body, dict) else body
    return client.post(path, content=content, headers={"Content-Type": "application/json"})


def _associate(client, item=ITEM, locus=LOCUS):
    return _post(client, "/associate", {"image": _data_url(), "item": item, "locus": locus})


_SIGN_IT = object()


def _scenes_body(record=None, sig=_SIGN_IT, **over) -> dict:
    record = good_record() if record is None else record
    body = {
        "image": _data_url(),
        "box": dict(BOX),
        "record": record,
        "sig": _sign(record) if sig is _SIGN_IT else sig,
    }
    body.update(over)
    return body


def _assert_error(resp, status, code):
    assert resp.status_code == status, resp.text
    assert resp.json() == {"error": code}


def _assert_tier1(resp):
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert set(payload) == {"tier", "image", "width", "height"}
    assert payload["tier"] == 1


@pytest.fixture(autouse=True)
def _no_ambient_key(monkeypatch):
    monkeypatch.delenv(KEY_ENV, raising=False)


@pytest.fixture
def keyed(monkeypatch):
    monkeypatch.setenv(KEY_ENV, KEY)


# Covers: MEM-036
# Requirement: a valid /associate record comes back with "sig", the lowercase hex HMAC-SHA256 of its
# canonical JSON under the server's record key, so the client can prove the record came from this server.
class TestAssociateSigns:
    def test_valid_record_carries_hex_hmac_of_canonical_json(self, keyed):
        resp = _associate(_client(FakeBackend()))
        assert resp.status_code == 200, resp.text
        payload = resp.json()
        assert set(payload) == ASSOCIATE_KEYS | {"sig"}
        assert payload["status"] == "valid"
        assert HEX_SIG.fullmatch(payload["sig"])
        assert payload["sig"] == _sign(payload["record"])

    def test_non_ascii_record_is_signed_over_ascii_escaped_json(self, keyed):
        item = "cr" + chr(0xE8) + "me br" + chr(0xFB) + "l" + chr(0xE9) + "e"
        resp = _associate(_client(FakeBackend()), item=item)
        assert resp.status_code == 200, resp.text
        payload = resp.json()
        assert payload["record"]["item"] == item
        assert payload["sig"] == _sign(payload["record"])

    def test_invalid_result_without_record_has_no_sig(self, keyed):
        backend = FakeBackend(good_record(olfactory=""))
        payload = _associate(_client(backend)).json()
        assert (payload["status"], payload["record"]) == ("invalid", None)
        assert "sig" not in payload

    def test_associate_sig_is_accepted_by_scenes(self, keyed):
        client = _client(FakeBackend())
        payload = _associate(client).json()
        _assert_tier1(_post(client, "/scenes", _scenes_body(payload["record"], payload["sig"])))


# Covers: MEM-036
# Requirement: /scenes only renders a record the server itself signed: the body must be exactly
# {image, box, record, sig}; a wrong, empty or non-string sig, or a record edited after signing, is refused
# 403 bad_signature before any record check, photo decode or model call.
class TestScenesRequiresSignature:
    def test_signed_record_renders_tier1(self, keyed):
        backend = FakeBackend()
        _assert_tier1(_post(_client(backend), "/scenes", _scenes_body()))
        assert backend.calls == 1

    def test_tampered_visual_is_403(self, keyed):
        record = good_record()
        tampered = good_record(visual="A" + record["visual"][1:].replace("t", "T", 1))
        assert tampered != record
        backend = FakeBackend()
        resp = _post(_client(backend), "/scenes", _scenes_body(tampered, _sign(record)))
        _assert_error(resp, 403, "bad_signature")
        assert backend.calls == 0

    @pytest.mark.parametrize(
        "sig",
        [
            _sign(good_record(), key="some-other-key"),
            _sign(good_record())[:-1] + ("0" if _sign(good_record())[-1] != "0" else "1"),
            _sign(good_record()).upper(),
            _sign(good_record())[:32],
            "",
            None,
            123,
            True,
            [_sign(good_record())],
            {"sig": _sign(good_record())},
        ],
        ids=[
            "other-key",
            "last-char-flipped",
            "uppercase",
            "truncated",
            "empty",
            "null",
            "int",
            "bool",
            "list",
            "object",
        ],
    )
    def test_bad_sig_is_403_without_model_call(self, keyed, sig):
        backend = FakeBackend()
        resp = _post(_client(backend), "/scenes", _scenes_body(sig=sig))
        _assert_error(resp, 403, "bad_signature")
        assert backend.calls == 0

    def test_missing_sig_is_400_bad_request(self, keyed):
        backend = FakeBackend()
        body = _scenes_body()
        del body["sig"]
        _assert_error(_post(_client(backend), "/scenes", body), 400, "bad_request")
        assert backend.calls == 0

    def test_extra_key_is_400_bad_request(self, keyed):
        backend = FakeBackend()
        _assert_error(_post(_client(backend), "/scenes", _scenes_body(extra="x")), 400, "bad_request")
        assert backend.calls == 0

    @pytest.mark.parametrize(
        "image",
        [
            "not a data url",
            "data:image/jpeg;base64,!!!not-base64!!!",
            _data_url(_img(fmt="PNG")),
        ],
        ids=["no-prefix", "bad-base64", "png-bytes"],
    )
    def test_bad_sig_is_403_before_photo_decode(self, keyed, image):
        backend = FakeBackend()
        resp = _post(_client(backend), "/scenes", _scenes_body(sig="0" * 64, image=image))
        _assert_error(resp, 403, "bad_signature")
        assert backend.calls == 0

    def test_bad_sig_is_403_before_record_caps(self, keyed):
        record = _padded("visual", CAP + 1)
        resp = _post(_client(FakeBackend()), "/scenes", _scenes_body(record, sig="0" * 64))
        _assert_error(resp, 403, "bad_signature")

    def test_bad_sig_is_403_before_record_validation(self, keyed):
        record = good_record(olfactory="")
        resp = _post(_client(FakeBackend()), "/scenes", _scenes_body(record, sig="0" * 64))
        _assert_error(resp, 403, "bad_signature")


# Covers: MEM-036
# Requirement: the record key comes from MEMRIPAL_RECORD_KEY (surrounding whitespace ignored); with no key
# configured each app instance signs with its own random key, so records from another instance (or from
# before a restart) are refused.
class TestRecordKey:
    def test_unset_key_sig_from_one_app_fails_on_another(self):
        first, second = _client(FakeBackend()), _client(FakeBackend())
        payload = _associate(first).json()
        assert HEX_SIG.fullmatch(payload["sig"])
        body = _scenes_body(payload["record"], payload["sig"])
        _assert_tier1(_post(first, "/scenes", body))
        _assert_error(_post(second, "/scenes", body), 403, "bad_signature")

    def test_key_with_surrounding_whitespace_equals_stripped_key(self, monkeypatch):
        monkeypatch.setenv(KEY_ENV, f"  {KEY}\n")
        client = _client(FakeBackend())
        payload = _associate(client).json()
        assert payload["sig"] == _sign(payload["record"], KEY)
        _assert_tier1(_post(client, "/scenes", _scenes_body()))

    def test_blank_key_is_treated_as_unset(self, monkeypatch):
        monkeypatch.setenv(KEY_ENV, " \n")
        first, second = _client(FakeBackend()), _client(FakeBackend())
        sig = _associate(first).json()["sig"]
        assert HEX_SIG.fullmatch(sig)
        assert sig not in (_sign(good_record(), ""), _sign(good_record(), " \n"))
        assert _associate(second).json()["sig"] != sig

    def test_key_never_appears_in_any_response_or_log(self, keyed, caplog):
        caplog.set_level(logging.DEBUG)
        client = _client(FakeBackend())
        record = good_record()
        responses = [
            _associate(client),
            _post(client, "/scenes", _scenes_body()),
            _post(client, "/scenes", _scenes_body(sig="0" * 64)),
            _post(client, "/scenes", _scenes_body(sig=KEY)),
            _post(client, "/scenes", {"image": _data_url(), "box": BOX, "record": record}),
            _post(
                client, "/scenes", _scenes_body(_padded("visual", CAP + 1), _sign(_padded("visual", CAP + 1)))
            ),
            client.get("/healthz"),
        ]
        assert [r.status_code for r in responses] == [200, 200, 403, 403, 400, 400, 200]
        for resp in responses:
            assert KEY not in resp.text
            assert KEY not in "".join(f"{k}:{v}" for k, v in resp.headers.items())
        assert not [r for r in caplog.records if KEY in r.getMessage()]


# Covers: MEM-036
# Requirement: spatial, visual and scene_prompt_details are capped at 300 chars: /associate refuses a model
# record past the cap (so it is never signed) and /scenes answers 400 bad_record for a signed one past it.
class TestRecordFieldCaps:
    @pytest.mark.parametrize("field", CAPPED_FIELDS)
    def test_scenes_accepts_field_at_300(self, keyed, field):
        record = _padded(field, CAP)
        assert len(record[field]) == CAP
        _assert_tier1(_post(_client(FakeBackend()), "/scenes", _scenes_body(record)))

    @pytest.mark.parametrize("field", CAPPED_FIELDS)
    def test_scenes_refuses_signed_field_at_301_with_bad_record(self, keyed, field):
        record = _padded(field, CAP + 1)
        assert len(record[field]) == CAP + 1
        backend = FakeBackend()
        _assert_error(_post(_client(backend), "/scenes", _scenes_body(record)), 400, "bad_record")
        assert backend.calls == 0

    @pytest.mark.parametrize("field", CAPPED_FIELDS)
    def test_associate_accepts_and_signs_field_at_300(self, keyed, field):
        backend = FakeBackend(_padded(field, CAP))
        payload = _associate(_client(backend)).json()
        assert (payload["status"], payload["attempts"]) == ("valid", 1)
        assert payload["sig"] == _sign(_padded(field, CAP))

    @pytest.mark.parametrize("field", CAPPED_FIELDS)
    def test_associate_refuses_model_field_at_301(self, keyed, field):
        backend = FakeBackend(_padded(field, CAP + 1))
        resp = _associate(_client(backend))
        assert resp.status_code == 200, resp.text
        payload = resp.json()
        assert (payload["status"], payload["attempts"], payload["record"]) == ("invalid", 3, None)
        assert "sig" not in payload
        assert backend.calls == 3
