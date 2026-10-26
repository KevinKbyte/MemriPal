# Covers: MEM-010
# Requirement: MetaClient.transcribe sends a WAV clip to Meta speech-to-text
# (muse-voice-transcribe-1.0) as a multipart POST to /v1/asr/transcribe with a Bearer header,
# a `request` JSON part {"mode", "model", "audioEncoding": "WAV"} plus "keywords" /
# "languageBias" only when given, and an `audio` part holding the exact WAV bytes; it shares
# post()'s retry semantics (429/500/503 and connect-phase errors retried, at most 3 attempts,
# never a 4xx) and the MAX_RESPONSE_BYTES response cap; it rejects None, empty or over-32-MiB
# audio, and anything that is not a mono 16-bit PCM WAV at 16 or 24 kHz (non-RIFF bytes,
# stereo, 8-bit, 44.1 kHz), with ValueError before any request is sent; and transcript_text(body) returns the
# response's "transcript" string, raising a clear error when the field is missing.
import json
import struct
import wave
from email import policy
from email.parser import BytesParser
from io import BytesIO

import httpx
import pytest

from memripal import meta_client
from memripal.meta_client import MetaClient

# Built by concatenation so this file never matches the pre-commit secret scanner (MEM-004).
KEY = "fake" + "-asr-" + "v" * 24
ASR_URL = "https://api.meta.ai/v1/asr/transcribe"
CAP = 32 * 1024 * 1024


def _wav(seconds: float = 0.1, rate: int = 16000, channels: int = 1, sampwidth: int = 2) -> bytes:
    buf = BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(sampwidth)
        w.setframerate(rate)
        w.writeframes(b"\x00" * (sampwidth * channels * int(rate * seconds)))
    return buf.getvalue()


def _wav_of_size(total: int, rate: int = 16000) -> bytes:
    """A valid mono 16-bit WAV whose total encoded length is exactly `total` bytes."""
    header = len(_wav(seconds=0, rate=rate))
    buf = BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(struct.pack("<h", 0) * ((total - header) // 2))
    return buf.getvalue()


WAV = _wav()


class Recorder:
    """MockTransport handler returning queued responses (or raising queued exceptions)."""

    def __init__(self, *responses):
        self.queue = list(responses)
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        request.read()
        self.requests.append(request)
        item = self.queue.pop(0) if len(self.queue) > 1 else self.queue[0]
        if isinstance(item, Exception):
            raise item
        return item


def ok(body: dict | None = None) -> httpx.Response:
    default = {"sessionId": "s", "transcript": "hello", "audioDurationMs": 100, "turns": []}
    return httpx.Response(200, json=body if body is not None else default)


def err(status: int, code: str = "server_error") -> httpx.Response:
    error = {"message": "nope", "type": "t", "param": None, "code": code}
    return httpx.Response(status, json={"error": error})


def make_client(rec: Recorder, rand_value: float = 0.0, **kw):
    sleeps: list[float] = []
    client = MetaClient(
        KEY, transport=httpx.MockTransport(rec), sleep=sleeps.append, rand=lambda: rand_value, **kw
    )
    return client, sleeps


def parts(request: httpx.Request) -> dict[str, tuple[str, bytes]]:
    """Multipart form parts by name -> (content type, raw bytes)."""
    head = b"Content-Type: " + request.headers["content-type"].encode() + b"\r\n\r\n"
    msg = BytesParser(policy=policy.HTTP).parsebytes(head + request.content)
    assert msg.is_multipart()
    out = {}
    for part in msg.iter_parts():
        name = part.get_param("name", header="content-disposition")
        out[name] = (part.get_content_type(), part.get_payload(decode=True))
    return out


def request_json(request: httpx.Request) -> dict:
    return json.loads(parts(request)["request"][1])


class TestTranscribeRequest:
    # Covers: MEM-010

    def test_multipart_post_to_asr_endpoint_with_bearer(self):
        rec = Recorder(ok())
        client, _ = make_client(rec)
        result = client.transcribe(WAV)
        req = rec.requests[0]
        assert req.method == "POST"
        assert str(req.url) == ASR_URL
        assert req.headers["authorization"] == "Bearer " + KEY
        assert req.headers["content-type"].startswith("multipart/form-data")
        assert result.ok is True
        assert result.status == 200

    def test_default_request_part_exact_and_omits_optional_keys(self):
        rec = Recorder(ok())
        client, _ = make_client(rec)
        client.transcribe(WAV)
        assert request_json(rec.requests[0]) == {
            "mode": "PUSH_TO_TALK",
            "model": "muse-voice-transcribe-1.0",
            "audioEncoding": "WAV",
        }

    def test_request_part_is_json_typed(self):
        rec = Recorder(ok())
        client, _ = make_client(rec)
        client.transcribe(WAV)
        assert parts(rec.requests[0])["request"][0] == "application/json"

    def test_audio_part_carries_exact_wav_bytes(self):
        rec = Recorder(ok())
        client, _ = make_client(rec)
        client.transcribe(WAV)
        assert parts(rec.requests[0])["audio"][1] == WAV

    def test_keywords_language_bias_mode_and_model_forwarded(self):
        rec = Recorder(ok())
        client, _ = make_client(rec)
        client.transcribe(
            WAV,
            mode="DIARIZATION",
            model="muse-voice-x",
            keywords=["loci", "MemriPal"],
            language_bias="en-US",
        )
        assert request_json(rec.requests[0]) == {
            "mode": "DIARIZATION",
            "model": "muse-voice-x",
            "audioEncoding": "WAV",
            "keywords": ["loci", "MemriPal"],
            "languageBias": "en-US",
        }

    def test_custom_base_url(self):
        rec = Recorder(ok())
        client, _ = make_client(rec, base_url="https://example.test/v9")
        client.transcribe(WAV)
        assert str(rec.requests[0].url) == "https://example.test/v9/asr/transcribe"

    def test_response_body_returned(self):
        rec = Recorder(ok({"transcript": "toothbrush", "audioDurationMs": 1234}))
        client, _ = make_client(rec)
        result = client.transcribe(WAV)
        assert json.loads(result.body) == {"transcript": "toothbrush", "audioDurationMs": 1234}


class TestTranscribeInputValidation:
    # Covers: MEM-010

    @pytest.mark.parametrize("audio", [None, b""], ids=["none", "empty"])
    def test_missing_audio_rejected_before_sending(self, audio):
        rec = Recorder(ok())
        client, _ = make_client(rec)
        with pytest.raises(ValueError):
            client.transcribe(audio)
        assert rec.requests == []

    def test_audio_over_32_mib_rejected_before_sending(self):
        rec = Recorder(ok())
        client, _ = make_client(rec)
        with pytest.raises(ValueError):
            client.transcribe(b"\x00" * (CAP + 1))
        assert rec.requests == []

    def test_audio_exactly_32_mib_is_sent(self):
        rec = Recorder(ok())
        client, _ = make_client(rec)
        audio = _wav_of_size(CAP)
        assert len(audio) == CAP
        assert client.transcribe(audio).ok is True
        assert len(rec.requests) == 1


class TestTranscribeWavFormatValidation:
    # Covers: MEM-010

    @pytest.mark.parametrize(
        "audio",
        [
            b"not a wav",
            _wav(rate=24000, channels=2, sampwidth=2),
            _wav(rate=24000, channels=1, sampwidth=1),
            _wav(rate=44100, channels=1, sampwidth=2),
        ],
        ids=["non_riff", "stereo_16bit_24k", "mono_8bit_24k", "mono_16bit_44100"],
    )
    def test_unsupported_audio_rejected_before_sending(self, audio):
        rec = Recorder(ok())
        client, _ = make_client(rec)
        with pytest.raises(ValueError):
            client.transcribe(audio)
        assert rec.requests == []

    @pytest.mark.parametrize("rate", [16000, 24000])
    def test_mono_16bit_supported_rate_is_sent_once(self, rate):
        rec = Recorder(ok())
        client, _ = make_client(rec)
        audio = _wav(rate=rate)
        assert client.transcribe(audio).ok is True
        assert len(rec.requests) == 1
        assert parts(rec.requests[0])["audio"][1] == audio


class TestTranscribeRetryAndCap:
    # Covers: MEM-010

    @pytest.mark.parametrize("status", [429, 500, 503])
    def test_retryable_status_then_success_resends_same_parts(self, status):
        rec = Recorder(err(status), ok())
        client, sleeps = make_client(rec, rand_value=0.4)
        result = client.transcribe(WAV)
        assert result.ok is True
        assert result.attempts == 2
        assert sleeps == [pytest.approx(0.5 + 0.2)]
        assert parts(rec.requests[1])["audio"][1] == WAV
        assert request_json(rec.requests[1])["model"] == "muse-voice-transcribe-1.0"

    def test_max_three_attempts(self):
        rec = Recorder(err(500), err(500), err(500), ok())
        client, sleeps = make_client(rec, rand_value=1.0)
        result = client.transcribe(WAV)
        assert result.ok is False
        assert result.attempts == 3
        assert len(rec.requests) == 3
        assert result.error == "500 server_error"

    @pytest.mark.parametrize("status", [400, 401, 406, 413])
    def test_non_retryable_status_returns_immediately(self, status):
        rec = Recorder(err(status, code="bad"), ok())
        client, sleeps = make_client(rec)
        result = client.transcribe(WAV)
        assert result.ok is False
        assert result.status == status
        assert result.attempts == 1
        assert sleeps == []
        assert result.error == f"{status} bad"

    def test_connect_error_retried_then_success(self):
        rec = Recorder(httpx.ConnectError("down"), ok())
        client, sleeps = make_client(rec)
        result = client.transcribe(WAV)
        assert result.ok is True
        assert result.attempts == 2
        assert len(sleeps) == 1

    def test_read_timeout_not_retried(self):
        rec = Recorder(httpx.ReadTimeout("slow"), ok())
        client, sleeps = make_client(rec)
        result = client.transcribe(WAV)
        assert result.ok is False
        assert result.status is None
        assert result.attempts == 1
        assert result.error == "transport: ReadTimeout"

    def test_response_over_cap_is_error_without_content(self):
        rec = Recorder(httpx.Response(200, content=b"a" * (meta_client.MAX_RESPONSE_BYTES + 1)), ok())
        client, sleeps = make_client(rec)
        result = client.transcribe(WAV)
        assert result.ok is False
        assert result.body == b""
        assert result.attempts == 1
        assert result.error == "200 response_too_large"

    def test_key_never_in_error(self):
        rec = Recorder(httpx.ConnectError("boom " + KEY))
        client, _ = make_client(rec)
        assert KEY not in client.transcribe(WAV).error


class TestTranscriptText:
    # Covers: MEM-010

    def test_extracts_transcript(self):
        body = json.dumps({"sessionId": "s", "transcript": "put it on the armchair", "turns": []}).encode()
        assert meta_client.transcript_text(body) == "put it on the armchair"

    def test_empty_transcript_is_empty_string(self):
        assert meta_client.transcript_text(json.dumps({"transcript": ""}).encode()) == ""

    def test_missing_transcript_raises(self):
        with pytest.raises((KeyError, ValueError)):
            meta_client.transcript_text(json.dumps({"audioDurationMs": 5}).encode())

    def test_non_json_body_raises(self):
        with pytest.raises(ValueError):
            meta_client.transcript_text(b"not json {")
