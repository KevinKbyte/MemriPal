"""Meta Model API HTTP client: Spark chat, SAM segmentation, image edits, ASR (MEM-006, MEM-010)."""

import base64
import io
import json
import random
import re
import time
import wave
from collections.abc import Callable
from dataclasses import dataclass

import httpx

from memripal.backend import MissingApiKey

DEFAULT_BASE_URL = "https://api.meta.ai/v1"
RETRYABLE_STATUSES = frozenset({429, 500, 503})
RETRY_AFTER_STATUSES = frozenset({429, 503})
RETRY_AFTER_CAP_S = 60
MAX_RESPONSE_BYTES = 32 * 1024 * 1024
MAX_AUDIO_BYTES = 32 * 1024 * 1024
# Only connect-phase failures are safe to retry: after that the paid request may have landed.
RETRYABLE_TRANSPORT = (httpx.ConnectError, httpx.ConnectTimeout)
# CallResult.error values for transport timeouts (the "transport: <name>" form _send builds).
TIMEOUT_ERRORS = frozenset(
    "transport: " + exc.__name__
    for exc in (httpx.ConnectTimeout, httpx.ReadTimeout, httpx.WriteTimeout, httpx.PoolTimeout)
)
_SAFE_CODE = re.compile(r"[A-Za-z0-9_.-]{1,64}")


@dataclass(frozen=True)
class CallResult:
    ok: bool
    status: int | None
    body: bytes
    error: str | None
    attempts: int
    latency_s: float


def _error_code(body: bytes) -> str:
    # Only the server's short error code is surfaced: the message may echo request data.
    try:
        code = json.loads(body)["error"]["code"]
    except (ValueError, KeyError, TypeError):
        return "http_error"
    return code if isinstance(code, str) and _SAFE_CODE.fullmatch(code) else "http_error"


def _read_capped(response: httpx.Response) -> bytes | None:
    """Body bytes, or None once it exceeds MAX_RESPONSE_BYTES (checked before and while reading)."""
    length = response.headers.get("Content-Length", "")
    if length.isdigit() and int(length) > MAX_RESPONSE_BYTES:
        return None
    chunks, size = [], 0
    for chunk in response.iter_bytes():
        size += len(chunk)
        if size > MAX_RESPONSE_BYTES:
            return None
        chunks.append(chunk)
    return b"".join(chunks)


def _check_wav_format(wav_bytes: bytes) -> None:
    """Raise ValueError unless the header is mono 16-bit WAV at 16 or 24 kHz (header only, no frames)."""
    try:
        with wave.open(io.BytesIO(wav_bytes), "rb") as wav:
            channels, sampwidth, rate = wav.getnchannels(), wav.getsampwidth(), wav.getframerate()
    except (wave.Error, EOFError) as exc:
        raise ValueError("transcribe requires RIFF WAV audio") from exc
    if channels != 1 or sampwidth != 2 or rate not in (16000, 24000):
        raise ValueError(
            f"transcribe requires mono 16-bit WAV at 16 or 24 kHz, got "
            f"{channels} ch, {sampwidth * 8}-bit, {rate} Hz"
        )


def _retry_after(response: httpx.Response) -> float | None:
    if response.status_code not in RETRY_AFTER_STATUSES:
        return None
    try:
        seconds = int(response.headers.get("Retry-After", ""))
    except ValueError:
        return None
    return float(min(max(seconds, 0), RETRY_AFTER_CAP_S))


class MetaClient:
    def __init__(
        self,
        api_key: str | None,
        *,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = 60.0,
        transport: httpx.BaseTransport | None = None,
        sleep: Callable[[float], None] = time.sleep,
        rand: Callable[[], float] = random.random,
        max_retries: int = 2,
    ) -> None:
        # None (not "") opts out of auth for a keyless local OpenAI-compatible server (MEM-026).
        if api_key is not None and not api_key:
            raise MissingApiKey("MetaClient requires a non-empty API key")
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._sleep = sleep
        self._rand = rand
        self._max_retries = max_retries
        self._http = httpx.Client(transport=transport, timeout=timeout)

    # Explicit so the key can never surface through a default object repr.
    def __repr__(self) -> str:
        return "MetaClient()"

    __str__ = __repr__

    def _redact(self, text: str) -> str:
        return text.replace(self._api_key, "***") if self._api_key else text

    def post(self, path: str, payload: dict) -> CallResult:
        return self._send(path, json=payload)

    def _send(self, path: str, *, retries: int | None = None, **content) -> CallResult:
        """`retries` overrides max_retries for this request only; None keeps the client's."""
        max_retries = self._max_retries if retries is None else retries
        url = self._base_url + path
        headers = {"Authorization": "Bearer " + self._api_key} if self._api_key else {}
        start = time.perf_counter()
        attempt = 0
        while True:
            attempt += 1
            retry_after = None
            try:
                with self._http.stream("POST", url, headers=headers, **content) as response:
                    status = response.status_code
                    capped = _read_capped(response)
                    retry_after = _retry_after(response)
            except httpx.TransportError as exc:
                status, body = None, b""
                error = "transport: " + type(exc).__name__
                retryable = isinstance(exc, RETRYABLE_TRANSPORT)
            else:
                body = capped if capped is not None else b""
                if capped is None:
                    error = f"{status} response_too_large"
                    retryable = False
                elif 200 <= status < 300:
                    error = None
                    retryable = False
                else:
                    error = f"{status} {_error_code(body)}"
                    retryable = status in RETRYABLE_STATUSES
            if not retryable or attempt > max_retries:
                return CallResult(
                    ok=error is None,
                    status=status,
                    body=body,
                    error=None if error is None else self._redact(error),
                    attempts=attempt,
                    latency_s=time.perf_counter() - start,
                )
            base = retry_after if retry_after is not None else 0.5 * 2 ** (attempt - 1)
            self._sleep(base + self._rand() * 0.5)

    def chat_json(
        self,
        *,
        prompt: str,
        schema: dict,
        schema_name: str,
        image_data_url: str | None = None,
        max_completion_tokens: int = 1024,
        model: str = "muse-spark-1.3",
    ) -> CallResult:
        content: list[dict] = [{"type": "text", "text": prompt}]
        if image_data_url is not None:
            content.append({"type": "image_url", "image_url": {"url": image_data_url}})
        payload = {
            "model": model,
            "max_completion_tokens": max_completion_tokens,
            "messages": [{"role": "user", "content": content}],
            "response_format": {
                "type": "json_schema",
                "json_schema": {"name": schema_name, "strict": True, "schema": schema},
            },
        }
        return self.post("/chat/completions", payload)

    def segment(self, *, image_data_url: str, phrase: str, model: str = "sam-3.1") -> CallResult:
        content = [
            {"type": "input_text", "text": phrase},
            {"type": "input_image", "image_url": image_data_url},
        ]
        payload = {
            "model": model,
            "input": [{"type": "message", "role": "user", "content": content}],
            "metadata": {"include_confidence": "true"},
        }
        return self.post("/responses", payload)

    def image_edit(
        self,
        *,
        image_data_url: str,
        prompt: str,
        size: str | None = None,
        model: str = "muse-image-1.0",
        timeout: float | None = None,
    ) -> CallResult:
        """`timeout` (seconds) overrides the client default for this request only; None keeps the default."""
        payload: dict = {
            "model": model,
            "prompt": prompt,
            "images": [{"image_url": image_data_url}],
            "n": 1,
            "output_format": "webp",
        }
        if size is not None:
            payload["size"] = size
        # Omitted rather than None: httpx reads timeout=None as "no timeout at all".
        per_request = {} if timeout is None else {"timeout": timeout}
        # Never retried: an edit is slow and paid, and the scene slot is held for the whole call.
        return self._send("/images/edits", json=payload, retries=0, **per_request)

    def image_generate(
        self,
        *,
        prompt: str,
        model: str = "muse-image-1.0",
        output_format: str = "webp",
        timeout: float | None = None,
    ) -> CallResult:
        """Text-to-image (MEM-043 G1); decode the reply with `image_bytes(result.body)`.

        Payload is exactly {model, prompt, n, output_format}: the API 400s on unknown fields, so no
        `seed`, and no `size` because its valid values are unverified (Q23 default; MEM-038).
        `timeout` (seconds) overrides the client default for this request only; None keeps the default.
        """
        payload = {"model": model, "prompt": prompt, "n": 1, "output_format": output_format}
        per_request = {} if timeout is None else {"timeout": timeout}
        # Never retried: generation is paid and a retry after a 5xx may double-bill.
        return self._send("/images/generations", json=payload, retries=0, **per_request)

    def transcribe(
        self,
        wav_bytes: bytes,
        *,
        mode: str = "PUSH_TO_TALK",
        model: str = "muse-voice-transcribe-1.0",
        keywords: list[str] | None = None,
        language_bias: str | None = None,
    ) -> CallResult:
        """Speech-to-text; the API accepts only mono 16-bit WAV at 16 or 24 kHz."""
        if not wav_bytes:
            raise ValueError("transcribe requires non-empty WAV bytes")
        if len(wav_bytes) > MAX_AUDIO_BYTES:
            raise ValueError("WAV audio exceeds the 32 MiB limit")
        _check_wav_format(wav_bytes)
        request: dict = {"mode": mode, "model": model, "audioEncoding": "WAV"}
        if keywords is not None:
            request["keywords"] = keywords
        if language_bias is not None:
            request["languageBias"] = language_bias
        files = {
            "request": (None, json.dumps(request).encode(), "application/json"),
            "audio": ("audio.wav", wav_bytes, "audio/wav"),
        }
        return self._send("/asr/transcribe", files=files)


def transcript_text(body: bytes) -> str:
    return json.loads(body)["transcript"]


def chat_content_json(body: bytes) -> dict:
    return json.loads(json.loads(body)["choices"][0]["message"]["content"])


def responses_text(body: bytes) -> str:
    data = json.loads(body)
    if "output_text" in data:
        return data["output_text"]
    return "".join(
        part.get("text", "") for item in data.get("output", []) for part in item.get("content", [])
    )


def image_bytes(body: bytes) -> bytes:
    return base64.b64decode(json.loads(body)["data"][0]["b64_json"])


def to_data_url(jpeg: bytes) -> str:
    return "data:image/jpeg;base64," + base64.b64encode(jpeg).decode("ascii")
