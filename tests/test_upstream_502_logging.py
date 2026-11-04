# Covers: MEM-015, MEM-020, MEM-021
# Requirement: when a live model call fails, POST /loci, POST /split (notes mode) and POST
# /associate still answer 502 with exactly {"error": "upstream"} (no model or exception text in
# the body), and the server logs one WARNING on logger "memripal.app" naming the exception class
# and its message (e.g. "BackendReplyInvalid: spark_json response incomplete or malformed"), so an
# operator can tell a truncated Spark reply from a transport failure; the API key never reaches
# the log. Beneath that, MetaBackend.call logs one WARNING on logger "memripal.backend" before it
# raises BackendCallFailed (or BackendTimeout / BackendReplyInvalid): the request method, the
# exception class name, status=<HTTP status or None>, and body=<upstream body excerpt, decoded
# utf-8, API key replaced by "***" before truncation, cut to backend.LOG_BODY_CHARS characters>;
# the route's response body never carries any of it.
import base64
import io
import json
import logging

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from memripal.app import create_app
from memripal.backend import BackendReplyInvalid, MetaBackend
from memripal.meta_client import MetaClient

FAKE_KEY = "fake-test-key-upstream-log-0123456789XYZ"
LOOPBACK_URL = "http://127.0.0.1"
MESSAGE = "spark_json response incomplete or malformed"
NOTES = (
    "Thank you all for coming tonight. First, our budget doubled this year. "
    "Second, the new library opens in May. Finally, volunteers keep this town running."
)


def _jpeg(w: int = 64, h: int = 48) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (120, 80, 40)).save(buf, "JPEG")
    return buf.getvalue()


JPEG = _jpeg()


def _loci_request() -> tuple[str, bytes, str]:
    return "/loci", JPEG, "image/jpeg"


def _split_request() -> tuple[str, bytes, str]:
    body = {"photo": base64.b64encode(JPEG).decode("ascii"), "mode": "notes", "text": NOTES, "loci_count": 12}
    return "/split", json.dumps(body).encode("utf-8"), "application/json"


def _associate_request() -> tuple[str, bytes, str]:
    image = "data:image/jpeg;base64," + base64.b64encode(JPEG).decode("ascii")
    body = {"image": image, "item": "milk carton", "locus": "left book"}
    return "/associate", json.dumps(body).encode("utf-8"), "application/json"


ROUTES = {"loci": _loci_request, "split": _split_request, "associate": _associate_request}


class TruncatedSpark:
    """ModelBackend whose every call fails the way a finish_reason "length" Spark reply does."""

    mode = "fake"

    def call(self, req):
        try:
            raise TypeError("the JSON object must be str, bytes or bytearray, not NoneType")
        except TypeError as exc:
            raise BackendReplyInvalid(MESSAGE) from exc


def _always_truncated(request: httpx.Request) -> httpx.Response:
    budget = json.loads(request.content).get("max_completion_tokens", 0)
    reply = {
        "choices": [{"finish_reason": "length", "message": {"role": "assistant", "content": None}}],
        "usage": {"completion_tokens": budget, "completion_tokens_details": {"reasoning_tokens": budget}},
    }
    return httpx.Response(200, json=reply)


def _post(backend, route: str):
    path, content, content_type = ROUTES[route]()
    client = TestClient(create_app(backend=backend), base_url=LOOPBACK_URL)
    return client.post(path, content=content, headers={"Content-Type": content_type})


def _warnings(caplog) -> list[str]:
    return [
        r.getMessage() for r in caplog.records if r.name == "memripal.app" and r.levelno == logging.WARNING
    ]


def _assert_upstream_logged(resp, caplog) -> None:
    assert resp.status_code == 502, resp.text[:300]
    assert resp.json() == {"error": "upstream"}
    assert any("BackendReplyInvalid" in m and MESSAGE in m for m in _warnings(caplog)), _warnings(caplog)


# Covers: MEM-015, MEM-020, MEM-021
# Requirement: each 502 upstream answer logs a WARNING on memripal.app with the exception class
# name and message, while the response body stays exactly {"error": "upstream"}.
class TestUpstream502IsLogged:
    @pytest.mark.parametrize("route", sorted(ROUTES))
    def test_reply_invalid_logs_class_and_message(self, caplog, route):
        caplog.set_level(logging.WARNING, logger="memripal.app")

        resp = _post(TruncatedSpark(), route)

        _assert_upstream_logged(resp, caplog)
        assert MESSAGE not in resp.text

    @pytest.mark.parametrize("route", sorted(ROUTES))
    def test_live_truncated_reply_logs_without_api_key(self, caplog, route):
        caplog.set_level(logging.DEBUG)
        client = MetaClient(FAKE_KEY, transport=httpx.MockTransport(_always_truncated), max_retries=0)

        resp = _post(MetaBackend(FAKE_KEY, client=client), route)

        _assert_upstream_logged(resp, caplog)
        assert FAKE_KEY not in caplog.text
        assert FAKE_KEY not in resp.text


def _backend_warnings(caplog) -> list[str]:
    return [
        r.getMessage()
        for r in caplog.records
        if r.name == "memripal.backend" and r.levelno == logging.WARNING
    ]


def _status_400(message: str):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"error": {"code": "invalid_request", "message": message}})

    return handler


def _post_live(handler, caplog, route: str = "loci"):
    caplog.set_level(logging.WARNING, logger="memripal.backend")
    client = MetaClient(FAKE_KEY, transport=httpx.MockTransport(handler), max_retries=0)
    return _post(MetaBackend(FAKE_KEY, client=client), route)


def _assert_bare_upstream(resp) -> None:
    assert resp.status_code == 502, resp.text[:300]
    assert resp.json() == {"error": "upstream"}


# Covers: MEM-014, MEM-015
# Requirement: whenever a live MetaBackend call fails (BackendCallFailed, BackendTimeout or
# BackendReplyInvalid) it first logs exactly one WARNING on logger "memripal.backend" with the
# request method, the exception class name, status=<HTTP status, None for a transport failure> and
# body=<excerpt of the upstream body, API key replaced by "***" before it is cut to LOG_BODY_CHARS>,
# so an operator can see why Meta refused; the route's response body stays {"error": "upstream"}.
class TestBackendLogsUpstreamCause:
    def test_http_400_logs_method_class_status_and_body_but_not_in_response(self, caplog):
        reason = "max_completion_tokens exceeds limit"

        resp = _post_live(_status_400(reason), caplog)

        _assert_bare_upstream(resp)
        logged = _backend_warnings(caplog)
        assert len(logged) == 1, logged
        for part in ("spark_json", "BackendCallFailed", "status=400", "body=", reason):
            assert part in logged[0], (part, logged[0])
        assert reason not in resp.text

    def test_truncated_200_reply_logs_finish_reason_length(self, caplog):
        resp = _post_live(_always_truncated, caplog)

        _assert_bare_upstream(resp)
        logged = _backend_warnings(caplog)
        assert len(logged) == 1, logged
        for part in ("spark_json", "BackendReplyInvalid", "status=200", "finish_reason", "length"):
            assert part in logged[0], (part, logged[0])

    def test_api_key_echoed_by_upstream_is_masked(self, caplog):
        resp = _post_live(_status_400(f"bad key {FAKE_KEY}"), caplog)

        _assert_bare_upstream(resp)
        logged = _backend_warnings(caplog)
        assert len(logged) == 1, logged
        assert "***" in logged[0]
        assert "bad key" in logged[0]
        assert FAKE_KEY not in caplog.text
        assert FAKE_KEY not in resp.text

    def test_long_body_is_truncated_to_log_body_chars(self, caplog):
        from memripal.backend import LOG_BODY_CHARS

        resp = _post_live(_status_400("x" * 2000 + "TAIL-MARKER-XYZ"), caplog)

        _assert_bare_upstream(resp)
        assert LOG_BODY_CHARS == 500
        logged = _backend_warnings(caplog)
        assert len(logged) == 1, logged
        assert "TAIL-MARKER-XYZ" not in logged[0]
        excerpt = logged[0].split("body=", 1)[1]
        assert 0 < len(excerpt) <= LOG_BODY_CHARS

    def test_transport_timeout_logs_status_none(self, caplog):
        def slow(request: httpx.Request) -> httpx.Response:
            raise httpx.ReadTimeout("slow", request=request)

        resp = _post_live(slow, caplog)

        _assert_bare_upstream(resp)
        logged = _backend_warnings(caplog)
        assert len(logged) == 1, logged
        for part in ("spark_json", "BackendTimeout", "status=None"):
            assert part in logged[0], (part, logged[0])
