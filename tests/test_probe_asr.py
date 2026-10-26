# Covers: MEM-011
# Requirement: the live probe optionally checks Meta speech-to-text: without `audio_wav`
# (absent or None) the report keeps exactly the 5 plan checks, no "asr" key and no ASR call;
# with a WAV clip it transcribes it once, adds checks asr_ok, asr_transcript_nonempty and
# asr_has_duration plus an "asr" object {transcript, audioDurationMs, latency_s, status,
# error} and an "asr" entry in calls; a failed, malformed or empty-input ASR call is
# recorded (asr_ok false, error set) without crashing or changing the image checks; a
# boolean duration is not a duration; asr_ok agrees with the recorded asr call's ok; and
# probe_live.py --audio <wav> passes the file's bytes to run_probe (missing file -> exit 2).
import importlib.util
import itertools
import json
import struct
import wave
from io import BytesIO
from pathlib import Path

import httpx
import pytest
from test_probe import ALL_PHRASES, EXPECTED_CHECKS, PHOTO, FakeMeta

import memripal.meta_client
import memripal.probe
from memripal.meta_client import MetaClient
from memripal.probe import run_probe

REPO_ROOT = Path(__file__).resolve().parents[1]
PROBE_SCRIPT = REPO_ROOT / "scripts" / "probe_live.py"

# Built by concatenation so this file never matches the pre-commit secret scanner (MEM-004).
KEY = "fake" + "-probeasr-" + "w" * 24
ASR_CHECKS = {"asr_ok", "asr_transcript_nonempty", "asr_has_duration"}
ASR_KEYS = {"transcript", "audioDurationMs", "latency_s", "status", "error"}


def _wav(seconds: float = 0.1, rate: int = 16000) -> bytes:
    buf = BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(struct.pack("<h", 0) * int(rate * seconds))
    return buf.getvalue()


WAV = _wav()
DEFAULT_ASR = {
    "sessionId": "s",
    "transcript": "toothbrush on the armchair",
    "audioDurationMs": 100,
    "turns": [],
}


class AsrMeta(FakeMeta):
    """FakeMeta plus the multipart /asr/transcribe endpoint with a configurable answer."""

    def __init__(self, rounds, *, asr_status=200, asr_body=None, **kw):
        super().__init__(rounds, **kw)
        self.asr_status = asr_status
        self.asr_body = DEFAULT_ASR if asr_body is None else asr_body
        self.asr_calls: list[bytes] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/asr/transcribe"):
            self.asr_calls.append(request.read())
            if self.asr_status != 200:
                error = {"message": "x", "type": "t", "param": None, "code": "asr_err"}
                return httpx.Response(self.asr_status, json={"error": error})
            if isinstance(self.asr_body, bytes):
                return httpx.Response(200, content=self.asr_body)
            return httpx.Response(200, json=self.asr_body)
        return super().__call__(request)


def probe(fake: FakeMeta, **kw) -> dict:
    client = MetaClient(KEY, transport=httpx.MockTransport(fake), sleep=lambda s: None, rand=lambda: 0.0)
    clock = itertools.count(0.0, 0.25).__next__
    return run_probe(client, PHOTO, clock=clock, **kw)


class TestProbeWithoutAudio:
    # Covers: MEM-011

    @pytest.mark.parametrize("kw", [{}, {"audio_wav": None}], ids=["absent", "none"])
    def test_report_shape_unchanged_and_no_asr_call(self, kw):
        fake = AsrMeta([ALL_PHRASES[:12]])
        r = probe(fake, **kw)
        assert set(r["checks"]) == EXPECTED_CHECKS
        assert "asr" not in r
        assert fake.asr_calls == []
        assert all(c["kind"] != "asr" for c in r["calls"])
        assert len(r["calls"]) == 1 + 12 + 1 + 2


class TestProbeWithAudio:
    # Covers: MEM-011

    def setup_method(self):
        self.fake = AsrMeta([ALL_PHRASES[:12]])
        self.report = probe(self.fake, audio_wav=WAV)

    def test_one_asr_call_carries_wav(self):
        assert len(self.fake.asr_calls) == 1
        assert WAV in self.fake.asr_calls[0]

    def test_checks_gain_asr_keys_all_true(self):
        checks = self.report["checks"]
        assert set(checks) == EXPECTED_CHECKS | ASR_CHECKS
        assert checks["asr_ok"] is True
        assert checks["asr_transcript_nonempty"] is True
        assert checks["asr_has_duration"] is True
        assert checks["image_output_dims"] == [640, 480]

    def test_asr_object(self):
        asr = self.report["asr"]
        assert set(asr) == ASR_KEYS
        assert asr["transcript"] == "toothbrush on the armchair"
        assert asr["audioDurationMs"] == 100
        assert isinstance(asr["latency_s"], float)
        assert asr["latency_s"] >= 0.0
        assert asr["status"] == 200
        assert asr["error"] is None

    def test_asr_call_recorded_and_report_serialisable_without_key(self):
        asr_calls = [c for c in self.report["calls"] if c["kind"] == "asr"]
        assert len(asr_calls) == 1
        assert asr_calls[0]["ok"] is True
        dumped = json.dumps(self.report)
        assert KEY not in dumped


class TestProbeAsrFailures:
    # Covers: MEM-011

    def test_http_error_recorded_and_image_checks_unaffected(self):
        fake = AsrMeta([ALL_PHRASES[:12]], asr_status=400)
        r = probe(fake, audio_wav=WAV)
        assert r["checks"]["asr_ok"] is False
        assert r["checks"]["asr_transcript_nonempty"] is False
        assert r["checks"]["asr_has_duration"] is False
        assert r["asr"]["status"] == 400
        assert r["asr"]["error"].startswith("400")
        assert r["asr"]["transcript"] is None
        assert r["checks"]["schema_image_ok"] is True
        assert r["checks"]["image_output_dims"] == [640, 480]
        json.dumps(r)

    def test_asr_runs_even_when_spark_fails(self):
        fake = AsrMeta([ALL_PHRASES[:12]], phrase_status=400)
        r = probe(fake, audio_wav=WAV)
        assert r["checks"]["schema_image_ok"] is False
        assert r["checks"]["asr_ok"] is True
        assert len(fake.asr_calls) == 1

    def test_empty_transcript_fails_nonempty_check(self):
        fake = AsrMeta([ALL_PHRASES[:12]], asr_body={"transcript": "", "audioDurationMs": 100})
        r = probe(fake, audio_wav=WAV)
        assert r["checks"]["asr_ok"] is True
        assert r["checks"]["asr_transcript_nonempty"] is False
        assert r["asr"]["transcript"] == ""

    def test_missing_transcript_gives_null_transcript_without_crash(self):
        fake = AsrMeta([ALL_PHRASES[:12]], asr_body={"audioDurationMs": 100})
        r = probe(fake, audio_wav=WAV)
        assert r["asr"]["transcript"] is None
        assert r["checks"]["asr_transcript_nonempty"] is False
        assert r["checks"]["asr_has_duration"] is True
        json.dumps(r)

    def test_missing_duration_fails_duration_check(self):
        fake = AsrMeta([ALL_PHRASES[:12]], asr_body={"transcript": "hello"})
        r = probe(fake, audio_wav=WAV)
        assert r["asr"]["audioDurationMs"] is None
        assert r["checks"]["asr_has_duration"] is False
        assert r["checks"]["asr_transcript_nonempty"] is True

    def test_unparseable_body_recorded_without_crash(self):
        fake = AsrMeta([ALL_PHRASES[:12]], asr_body=b"not json {")
        r = probe(fake, audio_wav=WAV)
        assert r["asr"]["transcript"] is None
        assert r["asr"]["audioDurationMs"] is None
        assert r["checks"]["asr_transcript_nonempty"] is False
        assert r["checks"]["asr_has_duration"] is False
        json.dumps(r)

    def test_empty_audio_recorded_as_failure_without_request(self):
        fake = AsrMeta([ALL_PHRASES[:12]])
        r = probe(fake, audio_wav=b"")
        assert fake.asr_calls == []
        assert r["checks"]["asr_ok"] is False
        assert isinstance(r["asr"]["error"], str) and r["asr"]["error"]
        assert r["asr"]["status"] is None
        assert r["checks"]["image_output_dims"] == [640, 480]
        json.dumps(r)


class Asr201Meta(AsrMeta):
    """AsrMeta whose /asr/transcribe succeeds with a non-200 2xx status."""

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/asr/transcribe"):
            self.asr_calls.append(request.read())
            return httpx.Response(201, json=self.asr_body)
        return super().__call__(request)


class TestProbeAsrResultConsistency:
    # Covers: MEM-011

    @pytest.mark.parametrize("flag", [True, False], ids=["true", "false"])
    def test_bool_duration_is_not_a_duration(self, flag):
        fake = AsrMeta([ALL_PHRASES[:12]], asr_body={"transcript": "hello", "audioDurationMs": flag})
        r = probe(fake, audio_wav=WAV)
        assert r["asr"]["audioDurationMs"] is None
        assert r["checks"]["asr_has_duration"] is False
        assert r["checks"]["asr_transcript_nonempty"] is True

    def test_asr_ok_agrees_with_recorded_call_ok_on_2xx(self):
        fake = Asr201Meta([ALL_PHRASES[:12]])
        r = probe(fake, audio_wav=WAV)
        asr_call = next(c for c in r["calls"] if c["kind"] == "asr")
        assert asr_call["ok"] is True
        assert r["asr"]["transcript"] == "toothbrush on the armchair"
        assert r["checks"]["asr_ok"] is asr_call["ok"]


def _load_script():
    spec = importlib.util.spec_from_file_location("probe_live_under_test", PROBE_SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TestProbeLiveAudioFlag:
    # Covers: MEM-011

    def _run(self, monkeypatch, tmp_path, extra: list[str]):
        seen: list[dict] = []

        def fake_run_probe(client, photo, **kw):
            seen.append(kw)
            return {"kept_count": 0, "checks": {}}

        monkeypatch.setenv("META_API_KEY", KEY)
        monkeypatch.setattr(memripal.probe, "run_probe", fake_run_probe)
        monkeypatch.setattr(memripal.meta_client, "MetaClient", lambda key: object())
        photo = tmp_path / "p.jpg"
        photo.write_bytes(PHOTO)
        code = _load_script().main(["--photo", str(photo), "--out", str(tmp_path / "out"), *extra])
        return code, seen

    def test_audio_bytes_passed_through(self, monkeypatch, tmp_path):
        wav = tmp_path / "clip.wav"
        wav.write_bytes(WAV)
        code, seen = self._run(monkeypatch, tmp_path, ["--audio", str(wav)])
        assert code == 0
        assert len(seen) == 1
        assert seen[0]["audio_wav"] == WAV

    def test_no_audio_flag_passes_no_audio(self, monkeypatch, tmp_path):
        code, seen = self._run(monkeypatch, tmp_path, [])
        assert code == 0
        assert seen[0].get("audio_wav") is None

    def test_missing_audio_file_exits_2_without_probing(self, monkeypatch, tmp_path, capsys):
        code, seen = self._run(monkeypatch, tmp_path, ["--audio", str(tmp_path / "nope.wav")])
        assert code == 2
        assert seen == []
        assert "audio" in capsys.readouterr().err
