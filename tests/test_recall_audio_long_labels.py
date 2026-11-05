# Covers: MEM-143
# Requirement: the 30-char Meta ASR keyword cap (MEM-010) only trims what is sent to speech-to-text; the
# /recall/audio relay still hands the FULL palace label list, including labels over 30 chars, to the
# transcriber call and to the Spark recall grader, so grading can match long labels.
import base64
import io
import json
import wave

import pytest
from fastapi.testclient import TestClient

from memripal.app import create_app
from memripal.meta_client import CallResult

LOOPBACK_URL = "http://127.0.0.1"
PASSCODE = "pass-" + "c" * 20
TEXT = "vivid images stick better than plain facts"
GRADE = {
    "provider": "fireworks",
    "latency_ms": 412,
    "items": [{"index": 1, "verdict": "correct", "reason": "paraphrased"}],
}
LONG = "Core technique: place items along familiar route"
LABELS = ["Kendall MIT station", LONG, "lamp"]


def _wav() -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"\x00" * 3200)
    return buf.getvalue()


class FakeAsr:
    def __init__(self):
        self.calls: list[object] = []

    def transcribe(self, wav_bytes, *, keywords=None, **kw):
        self.calls.append(keywords)
        body = json.dumps({"transcript": TEXT}).encode()
        return CallResult(ok=True, status=200, body=body, error=None, attempts=1, latency_s=0.01)


class FakeGrader:
    def __init__(self):
        self.calls: list[tuple] = []

    def grade(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        return GRADE


class _ModeBackend:
    def __init__(self, mode: str):
        self.mode = mode


@pytest.fixture(autouse=True)
def _env(monkeypatch, tmp_path):
    monkeypatch.delenv("MEMRIPAL_MODE", raising=False)
    monkeypatch.delenv("META_API_KEY", raising=False)
    for name in ("MEMRIPAL_ALLOWED_HOSTS", "MEMRIPAL_CALL_BUDGET", "MEMRIPAL_MAX_BODY_BYTES"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("MEMRIPAL_PASSCODE", PASSCODE)
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("USERPROFILE", str(tmp_path / "home"))


class TestLongLabelsReachGrader:
    # Covers: MEM-143
    def test_label_over_30_chars_reaches_asr_client_and_grader(self):
        asr = FakeAsr()
        grader = FakeGrader()
        app = create_app(
            backend=_ModeBackend("meta"), place_provider=object(), asr_client=asr, recall_grader=grader
        )
        client = TestClient(app, base_url=LOOPBACK_URL)
        body = {"audio": base64.b64encode(_wav()).decode("ascii"), "keywords": LABELS, "grade": True}
        resp = client.post(
            "/recall/audio",
            content=json.dumps(body).encode(),
            headers={"Content-Type": "application/json", "X-Memripal-Passcode": PASSCODE},
        )
        assert resp.status_code == 200, resp.text[:200]
        assert resp.json() == {"text": TEXT, "grade": GRADE}
        assert list(asr.calls[0]) == LABELS
        args, _ = grader.calls[0]
        assert args[0] == TEXT
        assert list(args[1]) == LABELS
