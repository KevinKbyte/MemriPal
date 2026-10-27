"""Speech-to-text provider toggle and the off-by-default local Whisper adapter (MEM-019, ADR 0015)."""

import ipaddress
import os

import httpx

STT_PROVIDERS = ("meta", "local")
_MODEL = "whisper-1"


class SttCallFailed(RuntimeError):
    """The local STT call failed or returned a malformed reply; message never holds the response body."""


def select_stt_provider() -> str:
    provider = os.environ.get("MEMRIPAL_STT_PROVIDER", "meta")
    if provider not in STT_PROVIDERS:
        raise ValueError(f"MEMRIPAL_STT_PROVIDER must be one of {STT_PROVIDERS}, got {provider!r}")
    return provider


def _is_loopback(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


class LocalWhisperClient:
    """Client for an OpenAI-compatible Whisper server; loopback-only so audio never leaves the machine."""

    def __init__(self, base_url: str, *, transport: httpx.BaseTransport | None = None) -> None:
        host = httpx.URL(base_url).host
        if not _is_loopback(host):
            raise ValueError(f"local STT server must be on a loopback host, got {host!r}")
        self._url = base_url.rstrip("/") + "/v1/audio/transcriptions"
        self._http = httpx.Client(transport=transport, timeout=60.0)

    def transcribe(self, wav_bytes: bytes) -> str:
        if not wav_bytes:
            raise ValueError("cannot transcribe empty audio")
        response = self._http.post(
            self._url,
            files={"file": ("audio.wav", wav_bytes, "audio/wav")},
            data={"model": _MODEL},
        )
        if not response.is_success:
            raise SttCallFailed(f"local STT call failed with HTTP {response.status_code}")
        try:
            data = response.json()
        except ValueError:
            # from None: the decode error's context carries the raw body.
            raise SttCallFailed("local STT reply was not JSON") from None
        text = data.get("text") if isinstance(data, dict) else None
        if not isinstance(text, str):
            raise SttCallFailed("local STT reply had no string 'text' field")
        return text


def local_stt_client_from_env() -> LocalWhisperClient:
    # Environment only, like META_API_KEY: never read .env files.
    url = os.environ.get("MEMRIPAL_LOCAL_STT_URL", "")
    if not url:
        raise ValueError("local stt provider requires MEMRIPAL_LOCAL_STT_URL")
    return LocalWhisperClient(url)
