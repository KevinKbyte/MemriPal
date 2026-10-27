# Covers: MEM-019
# Requirement: the speech-to-text provider is chosen by MEMRIPAL_STT_PROVIDER (default "meta"; "local"
# selects a local Whisper server; unknown values fail at startup with ValueError). The local client only
# talks to a loopback host, posts one multipart request to /v1/audio/transcriptions and returns the
# transcript text; empty audio is rejected, and any failed or malformed reply raises SttCallFailed
# without leaking the response body.

import json

import httpx
import memripal.stt_provider as stt_provider
import pytest

LocalWhisperClient = stt_provider.LocalWhisperClient
SttCallFailed = stt_provider.SttCallFailed
local_stt_client_from_env = stt_provider.local_stt_client_from_env
select_stt_provider = stt_provider.select_stt_provider

BASE_URL = "http://127.0.0.1:8080"
WAV = b"RIFF\x24\x00\x00\x00WAVEfmt fake-wav-bytes"
SENTINEL = "SENTINEL-BODY-do-not-leak-7f3a"


def _client(handler, base_url: str = BASE_URL) -> LocalWhisperClient:
    return LocalWhisperClient(base_url, transport=httpx.MockTransport(handler))


class TestSelectSttProvider:
    def test_default_selects_meta(self, monkeypatch):
        monkeypatch.delenv("MEMRIPAL_STT_PROVIDER", raising=False)
        assert select_stt_provider() == "meta"

    def test_local_selected_from_env(self, monkeypatch):
        monkeypatch.setenv("MEMRIPAL_STT_PROVIDER", "local")
        assert select_stt_provider() == "local"

    @pytest.mark.parametrize("value", ["openai", "LOCAL", ""])
    def test_unknown_provider_raises_value_error(self, monkeypatch, value):
        monkeypatch.setenv("MEMRIPAL_STT_PROVIDER", value)
        with pytest.raises(ValueError):
            select_stt_provider()


class TestLocalWhisperClientTranscribe:
    def test_one_multipart_post_returns_text(self):
        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            request.read()
            seen.append(request)
            return httpx.Response(200, json={"text": "the keys are on the shelf"})

        text = _client(handler).transcribe(WAV)

        assert text == "the keys are on the shelf"
        assert len(seen) == 1
        request = seen[0]
        assert request.method == "POST"
        assert request.url.host == "127.0.0.1"
        assert request.url.port == 8080
        assert request.url.path == "/v1/audio/transcriptions"
        assert request.headers["content-type"].startswith("multipart/form-data")
        body = request.content
        assert b'name="file"' in body
        assert b'name="model"' in body
        assert WAV in body

    def test_empty_audio_raises_value_error_without_request(self):
        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(200, json={"text": "x"})

        with pytest.raises(ValueError):
            _client(handler).transcribe(b"")
        assert seen == []


class TestLocalWhisperClientLoopbackOnly:
    @pytest.mark.parametrize("base_url", ["http://example.com", "http://10.0.0.5"])
    def test_non_loopback_host_rejected(self, base_url):
        with pytest.raises(ValueError):
            LocalWhisperClient(base_url, transport=httpx.MockTransport(lambda r: httpx.Response(200)))

    @pytest.mark.parametrize("base_url", ["http://127.0.0.1:8080", "http://localhost:8080"])
    def test_loopback_host_accepted(self, base_url):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"text": "ok"})

        assert _client(handler, base_url).transcribe(WAV) == "ok"


class TestLocalWhisperClientFailures:
    @pytest.mark.parametrize("status", [400, 404, 500, 503])
    def test_non_2xx_raises_stt_call_failed_without_body(self, status):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(status, json={"text": SENTINEL, "error": SENTINEL})

        with pytest.raises(SttCallFailed) as excinfo:
            _client(handler).transcribe(WAV)
        assert SENTINEL not in str(excinfo.value)

    @pytest.mark.parametrize(
        "body",
        [
            SENTINEL.encode(),
            ('{"text": "' + SENTINEL).encode(),
            json.dumps({"error": SENTINEL}).encode(),
            json.dumps({"text": 123, "detail": SENTINEL}).encode(),
            json.dumps({"text": None, "detail": SENTINEL}).encode(),
            json.dumps([SENTINEL]).encode(),
        ],
    )
    def test_malformed_json_raises_stt_call_failed_without_body(self, body):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, content=body, headers={"Content-Type": "application/json"})

        with pytest.raises(SttCallFailed) as excinfo:
            _client(handler).transcribe(WAV)
        assert SENTINEL not in str(excinfo.value)

    def test_stt_call_failed_is_runtime_error(self):
        assert issubclass(SttCallFailed, RuntimeError)


class TestLocalSttClientFromEnv:
    def test_missing_url_raises_value_error(self, monkeypatch):
        monkeypatch.delenv("MEMRIPAL_LOCAL_STT_URL", raising=False)
        with pytest.raises(ValueError):
            local_stt_client_from_env()

    def test_url_from_env_builds_client(self, monkeypatch):
        monkeypatch.setenv("MEMRIPAL_LOCAL_STT_URL", BASE_URL)
        assert isinstance(local_stt_client_from_env(), LocalWhisperClient)
