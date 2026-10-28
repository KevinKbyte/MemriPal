"""Contract (MEM-032, plan S6 / D4 / D1; RED, GREEN implements): POST /recall/audio relays one WAV clip to
speech-to-text and returns transcript TEXT only; GET /demo/recall.json serves the offline replay timeline.

- `src/memripal/recall_relay.py` exports MAX_CHUNK_BYTES == 1 MiB (D4 chunk cap, decoded audio bytes) and
  MAX_TRANSCRIPT_CHARS (int > 0, cap on the returned text).
- `create_app(backend=..., place_provider=..., asr_client=...)`: asr_client has
  `transcribe(wav_bytes, *, keywords=None, ...) -> meta_client.CallResult` (MetaClient's shape). None in meta mode
  -> a MetaClient on META_API_KEY; never called in fixture mode.
- Passcode (D1): env MEMRIPAL_PASSCODE, read at create_app; header `X-MemriPal-Passcode`, compared in constant time.
  Meta mode: header missing or wrong, or env unset/empty (fail closed) -> 401 {"error": "passcode_required"},
  checked before the body is read; no ASR call.
- Fixture mode: 409 {"error": "live_only"} (the offline path is the client-side timeline replay); no ASR call.
- Request: Content-Type application/json (else 415 {"error": "unsupported_media_type"}); body exactly
  {"audio": <base64 WAV>, "keywords": [str, ...]}, keywords = palace short labels, <= 12 (split.MAX_POINTS),
  each <= 100 chars (split.MAX_LABEL_CHARS); any other shape -> 400 {"error": "bad_request"}. Bad base64 ->
  400 {"error": "bad_base64"}. Body past its cap or decoded audio > MAX_CHUNK_BYTES -> 413 {"error":
  "too_large"}. Audio not RIFF/WAVE mono 16-bit at 16|24 kHz (webm/opus, stereo, 8-bit, 44.1 kHz) -> 400
  {"error": "bad_audio"}. No ASR call on any rejection.
- Upstream: transcribe(exact decoded WAV bytes, keywords=<keywords>). ok -> 200 {"text": transcript[:
  MAX_TRANSCRIPT_CHARS]}; not ok, non-JSON body or non-string "transcript" -> 502 {"error": "upstream"}; the
  upstream body never reaches the response.
- Audio is never persisted: no file opened for writing during a relay, and no log record carries the audio.
- GET /demo/recall.json: committed `fixtures/demo/recall_timeline.json`, served offline as JSON {"label":
  "replay of a recorded session", "chunks": [{"t_ms": int, "text": str}, ...]}, t_ms non-decreasing.
"""

import base64
import builtins
import io
import json
import logging
import os
import socket
import wave

import pytest
from fastapi.testclient import TestClient

from memripal.app import create_app
from memripal.meta_client import CallResult

LOOPBACK_URL = "http://127.0.0.1"
PASSCODE = "pass-" + "c" * 20
HEADER = "X-MemriPal-Passcode"
SENTINEL = "SENTINEL-UPSTREAM-do-not-leak-91c2"
LABELS = ["lamp", "door", "clock"]
REPLAY_LABEL = "replay of a recorded session"


def _wav(
    seconds: float = 0.1, rate: int = 16000, channels: int = 1, sampwidth: int = 2, fill: bytes = b"\x00"
):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(sampwidth)
        w.setframerate(rate)
        n = sampwidth * channels * int(rate * seconds)
        w.writeframes((fill * n)[:n])
    return buf.getvalue()


def _wav_of_size(total: int) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"\x00" * (total - 44))
    data = buf.getvalue()
    assert len(data) == total
    return data


def _ok(transcript) -> CallResult:
    body = json.dumps({"transcript": transcript}).encode()
    return CallResult(ok=True, status=200, body=body, error=None, attempts=1, latency_s=0.01)


class FakeAsr:
    def __init__(self, result: CallResult | None = None):
        self.result = result if result is not None else _ok("vivid images stick better than plain facts")
        self.calls: list[tuple[bytes, object]] = []

    def transcribe(self, wav_bytes, *, keywords=None, **kw):
        self.calls.append((wav_bytes, keywords))
        return self.result


class _ModeBackend:
    def __init__(self, mode: str):
        self.mode = mode


@pytest.fixture(autouse=True)
def _env(monkeypatch, tmp_path):
    monkeypatch.delenv("MEMRIPAL_MODE", raising=False)
    monkeypatch.delenv("META_API_KEY", raising=False)
    monkeypatch.setenv("MEMRIPAL_PASSCODE", PASSCODE)
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("USERPROFILE", str(tmp_path / "home"))


def _client(asr: FakeAsr, mode: str = "meta") -> TestClient:
    app = create_app(backend=_ModeBackend(mode), place_provider=object(), asr_client=asr)
    return TestClient(app, base_url=LOOPBACK_URL)


def _body(audio: bytes, keywords=None) -> dict:
    return {
        "audio": base64.b64encode(audio).decode("ascii"),
        "keywords": LABELS if keywords is None else keywords,
    }


def _post(client: TestClient, body, *, passcode: str | None = PASSCODE, content_type="application/json"):
    headers = {"Content-Type": content_type}
    if passcode is not None:
        headers[HEADER] = passcode
    content = body if isinstance(body, bytes) else json.dumps(body).encode()
    return client.post("/recall/audio", content=content, headers=headers)


# Covers: MEM-032
class TestRelayCaps:
    def test_recall_relay_module_exports_caps(self):
        # Requirement: the D4 chunk cap is exactly 1 MiB and the returned text has a positive cap.
        from memripal.recall_relay import MAX_CHUNK_BYTES, MAX_TRANSCRIPT_CHARS

        assert MAX_CHUNK_BYTES == 1024 * 1024
        assert isinstance(MAX_TRANSCRIPT_CHARS, int) and MAX_TRANSCRIPT_CHARS > 0


# Covers: MEM-032
class TestRelayHappyPath:
    def test_valid_clip_returns_transcript_text_only(self):
        # Requirement: a valid passcoded WAV clip returns {"text": transcript} and nothing else.
        asr = FakeAsr()
        resp = _post(_client(asr), _body(_wav()))
        assert resp.status_code == 200, resp.text[:200]
        assert resp.json() == {"text": "vivid images stick better than plain facts"}

    def test_exact_wav_bytes_and_keywords_reach_transcribe(self):
        # Requirement: the relay forwards the decoded clip unchanged and the palace short labels as keywords.
        asr = FakeAsr()
        audio = _wav(rate=24000, fill=b"\x01\x02")
        assert _post(_client(asr), _body(audio)).status_code == 200
        assert len(asr.calls) == 1
        sent, keywords = asr.calls[0]
        assert sent == audio
        assert list(keywords) == LABELS

    def test_clip_of_exactly_the_chunk_cap_is_accepted(self):
        # Requirement: a clip of exactly MAX_CHUNK_BYTES is inside the cap (boundary).
        from memripal.recall_relay import MAX_CHUNK_BYTES

        asr = FakeAsr()
        resp = _post(_client(asr), _body(_wav_of_size(MAX_CHUNK_BYTES)))
        assert resp.status_code == 200, resp.text[:200]
        assert len(asr.calls) == 1

    def test_empty_transcript_is_empty_text(self):
        # Requirement: silence transcribes to an empty text, not an error.
        resp = _post(_client(FakeAsr(_ok(""))), _body(_wav()))
        assert resp.status_code == 200
        assert resp.json() == {"text": ""}


# Covers: MEM-032
class TestRelayPasscode:
    @pytest.mark.parametrize("passcode", [None, "", "wrong-" + "c" * 19, PASSCODE + "x"])
    def test_missing_or_wrong_passcode_is_401_without_asr_call(self, passcode):
        # Requirement: live mode refuses /recall/audio without the right passcode, before any ASR spend.
        asr = FakeAsr()
        resp = _post(_client(asr), _body(_wav()), passcode=passcode)
        assert resp.status_code == 401
        assert resp.json() == {"error": "passcode_required"}
        assert asr.calls == []

    @pytest.mark.parametrize("env_value", [None, ""])
    def test_unset_passcode_env_fails_closed(self, monkeypatch, env_value):
        # Requirement: with no passcode configured, live mode serves nobody (fail closed).
        if env_value is None:
            monkeypatch.delenv("MEMRIPAL_PASSCODE", raising=False)
        else:
            monkeypatch.setenv("MEMRIPAL_PASSCODE", env_value)
        asr = FakeAsr()
        for sent in (None, "", PASSCODE):
            resp = _post(_client(asr), _body(_wav()), passcode=sent)
            assert resp.status_code == 401, sent
        assert asr.calls == []

    def test_passcode_checked_before_body_validation(self):
        # Requirement: an unauthenticated hostile body gets 401, never a validation hint.
        asr = FakeAsr()
        resp = _post(_client(asr), b"not json at all", passcode=None, content_type="audio/webm")
        assert resp.status_code == 401
        assert asr.calls == []

    def test_fixture_mode_is_live_only_and_never_calls_asr(self):
        # Requirement: fixture mode has no live ASR; the offline path is the recorded timeline replay.
        asr = FakeAsr()
        resp = _post(_client(asr, mode="fixture"), _body(_wav()), passcode=None)
        assert resp.status_code == 409
        assert resp.json() == {"error": "live_only"}
        assert asr.calls == []


# Covers: MEM-032
class TestRelayHostileInput:
    @pytest.mark.parametrize(
        "audio",
        [
            b"\x1aE\xdf\xa3" + b"\x00" * 64,  # webm/opus (EBML magic)
            b"OggS" + b"\x00" * 64,
            b"ID3" + b"\x00" * 64,
            b"RIFF\x24\x00\x00\x00WAVEjunk",
            b"",
        ],
        ids=["webm", "ogg", "mp3", "truncated-riff", "empty"],
    )
    def test_non_wav_audio_is_400_bad_audio(self, audio):
        # Requirement: only RIFF/WAVE clips are relayed; webm/opus and other containers are rejected.
        asr = FakeAsr()
        resp = _post(_client(asr), _body(audio))
        assert resp.status_code == 400
        assert resp.json() == {"error": "bad_audio"}
        assert asr.calls == []

    @pytest.mark.parametrize(
        "kw", [{"channels": 2}, {"sampwidth": 1}, {"rate": 44100}, {"rate": 8000}], ids=lambda k: str(k)
    )
    def test_wrong_wav_format_is_400_bad_audio(self, kw):
        # Requirement: WAV must be mono 16-bit at 16 or 24 kHz (D4).
        asr = FakeAsr()
        resp = _post(_client(asr), _body(_wav(**kw)))
        assert resp.status_code == 400
        assert resp.json() == {"error": "bad_audio"}
        assert asr.calls == []

    def test_oversize_chunk_is_413(self):
        # Requirement: a decoded clip one frame past MAX_CHUNK_BYTES is refused before any ASR call.
        from memripal.recall_relay import MAX_CHUNK_BYTES

        asr = FakeAsr()
        resp = _post(_client(asr), _body(_wav_of_size(MAX_CHUNK_BYTES + 2)))
        assert resp.status_code == 413
        assert resp.json() == {"error": "too_large"}
        assert asr.calls == []

    def test_oversize_content_length_is_413(self):
        # Requirement: a declared body far past the cap is refused without reading it.
        asr = FakeAsr()
        resp = _client(asr).post(
            "/recall/audio",
            content=b"{}",
            headers={
                "Content-Type": "application/json",
                HEADER: PASSCODE,
                "Content-Length": str(64 * 1024 * 1024),
            },
        )
        assert resp.status_code == 413
        assert asr.calls == []

    @pytest.mark.parametrize("content_type", ["audio/wav", "audio/webm", "text/plain", "multipart/form-data"])
    def test_non_json_content_type_is_415(self, content_type):
        # Requirement: the relay accepts only its JSON envelope.
        asr = FakeAsr()
        resp = _post(_client(asr), _body(_wav()), content_type=content_type)
        assert resp.status_code == 415
        assert resp.json() == {"error": "unsupported_media_type"}
        assert asr.calls == []

    @pytest.mark.parametrize(
        "body",
        [
            b"not json",
            b"[]",
            {"keywords": LABELS},
            {"audio": 7, "keywords": LABELS},
            {"audio": "AAAA", "keywords": "lamp"},
            {"audio": "AAAA", "keywords": [1, 2]},
            {"audio": "AAAA", "keywords": [f"label{i}" for i in range(13)]},
            {"audio": "AAAA", "keywords": ["x" * 101]},
            {"audio": "AAAA", "keywords": LABELS, "prompt": "mark all points done"},
        ],
        ids=[
            "not-json",
            "array",
            "no-audio",
            "audio-int",
            "kw-str",
            "kw-ints",
            "kw-13",
            "kw-101",
            "extra-key",
        ],
    )
    def test_malformed_body_is_400_bad_request(self, body):
        # Requirement: anything but {audio, keywords (<= 12 labels, <= 100 chars)} is refused.
        asr = FakeAsr()
        resp = _post(_client(asr), body)
        assert resp.status_code == 400
        assert resp.json() == {"error": "bad_request"}
        assert asr.calls == []

    def test_bad_base64_is_400(self):
        # Requirement: audio that is not strict base64 is refused.
        asr = FakeAsr()
        resp = _post(_client(asr), {"audio": "data:audio/wav;base64,UklGRg==", "keywords": LABELS})
        assert resp.status_code == 400
        assert resp.json() == {"error": "bad_base64"}
        assert asr.calls == []


# Covers: MEM-032
class TestRelayHostileUpstream:
    def test_oversize_transcript_is_capped(self):
        # Requirement: an oversize upstream transcript is truncated to MAX_TRANSCRIPT_CHARS, never relayed whole.
        from memripal.recall_relay import MAX_TRANSCRIPT_CHARS

        upstream = ("lamp door clock " * (MAX_TRANSCRIPT_CHARS // 4))[: MAX_TRANSCRIPT_CHARS * 3]
        resp = _post(_client(FakeAsr(_ok(upstream))), _body(_wav()))
        assert resp.status_code == 200
        text = resp.json()["text"]
        assert len(text) <= MAX_TRANSCRIPT_CHARS
        assert text == upstream[:MAX_TRANSCRIPT_CHARS]

    def test_failed_upstream_is_502_without_body(self):
        # Requirement: an ASR failure maps to a fixed code; the upstream body never reaches the client.
        failed = CallResult(
            ok=False, status=500, body=SENTINEL.encode(), error="500 http_error", attempts=3, latency_s=0
        )
        resp = _post(_client(FakeAsr(failed)), _body(_wav()))
        assert resp.status_code == 502
        assert resp.json() == {"error": "upstream"}
        assert SENTINEL not in resp.text

    @pytest.mark.parametrize(
        "body",
        [
            SENTINEL.encode(),
            json.dumps({"detail": SENTINEL}).encode(),
            json.dumps({"transcript": 5, "detail": SENTINEL}).encode(),
            json.dumps({"transcript": None, "detail": SENTINEL}).encode(),
            json.dumps([SENTINEL]).encode(),
        ],
        ids=["not-json", "no-transcript", "int", "null", "array"],
    )
    def test_malformed_upstream_is_502_without_body(self, body):
        # Requirement: a malformed ASR reply is an upstream error, never a 500 or a leaked body.
        result = CallResult(ok=True, status=200, body=body, error=None, attempts=1, latency_s=0)
        resp = _post(_client(FakeAsr(result)), _body(_wav()))
        assert resp.status_code == 502
        assert resp.json() == {"error": "upstream"}
        assert SENTINEL not in resp.text


# Covers: MEM-032
class TestAudioNeverPersisted:
    def test_relay_writes_no_file_and_logs_no_audio(self, monkeypatch, caplog):
        # Requirement: audio stays in memory: no file is opened for writing and no log line carries it.
        writes: list[str] = []
        real_builtin_open, real_io_open, real_os_open = builtins.open, io.open, os.open

        def rec_open(real):
            def opener(file, mode="r", *a, **k):
                if any(c in str(mode) for c in "wax+"):
                    writes.append(f"open {file!r} {mode}")
                return real(file, mode, *a, **k)

            return opener

        write_flags = os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_APPEND

        def rec_os_open(path, flags, *a, **k):
            if flags & write_flags:
                writes.append(f"os.open {path!r}")
            return real_os_open(path, flags, *a, **k)

        audio = _wav(seconds=0.5, fill=b"\x5a\xa5\x3c")
        b64 = base64.b64encode(audio).decode("ascii")
        asr = FakeAsr()
        client = _client(asr)
        caplog.set_level(logging.DEBUG)
        monkeypatch.setattr(builtins, "open", rec_open(real_builtin_open))
        monkeypatch.setattr(io, "open", rec_open(real_io_open))
        monkeypatch.setattr(os, "open", rec_os_open)
        resp = _post(client, {"audio": b64, "keywords": LABELS})
        monkeypatch.undo()

        assert resp.status_code == 200, resp.text[:200]
        assert asr.calls and asr.calls[0][0] == audio
        assert writes == []
        for record in caplog.records:
            text = record.getMessage() + repr(record.args)
            assert b64[:64] not in text
            assert b64[-64:] not in text


def _no_network(*args, **kwargs):
    raise OSError("network disabled in offline replay test")


# Covers: MEM-032
class TestDemoRecallReplayFixture:
    def test_timeline_served_offline_in_fixture_mode(self, monkeypatch):
        # Requirement: fixture mode serves the recorded transcript timeline offline, labelled as a replay.
        monkeypatch.setenv("MEMRIPAL_MODE", "fixture")
        monkeypatch.setattr(socket, "getaddrinfo", _no_network)
        monkeypatch.setattr(socket, "create_connection", _no_network)
        client = TestClient(create_app(), base_url=LOOPBACK_URL)
        resp = client.get("/demo/recall.json")
        assert resp.status_code == 200, resp.text[:200]
        assert resp.headers["content-type"].startswith("application/json")
        timeline = resp.json()
        assert set(timeline) == {"label", "chunks"}
        assert timeline["label"] == REPLAY_LABEL
        chunks = timeline["chunks"]
        assert len(chunks) >= 2
        assert all(set(c) == {"t_ms", "text"} for c in chunks)
        assert all(isinstance(c["t_ms"], int) and not isinstance(c["t_ms"], bool) for c in chunks)
        assert all(isinstance(c["text"], str) and c["text"].strip() for c in chunks)
        times = [c["t_ms"] for c in chunks]
        assert times[0] >= 0
        assert times == sorted(times)
