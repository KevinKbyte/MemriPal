"""Meta Model API HTTP client: Spark chat, SAM segmentation, image edits (MEM-006)."""

import base64
import json
import random
import time
from collections.abc import Callable
from dataclasses import dataclass

import httpx

from memripal.backend import MissingApiKey

DEFAULT_BASE_URL = "https://api.meta.ai/v1"
RETRYABLE_STATUSES = frozenset({429, 500, 503})
RETRY_AFTER_STATUSES = frozenset({429, 503})
RETRY_AFTER_CAP_S = 60


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
    return code if isinstance(code, str) and code else "http_error"


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
        api_key: str,
        *,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = 60.0,
        transport: httpx.BaseTransport | None = None,
        sleep: Callable[[float], None] = time.sleep,
        rand: Callable[[], float] = random.random,
        max_retries: int = 2,
    ) -> None:
        if not api_key:
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
        return text.replace(self._api_key, "***")

    def post(self, path: str, payload: dict) -> CallResult:
        url = self._base_url + path
        headers = {"Authorization": "Bearer " + self._api_key}
        start = time.perf_counter()
        attempt = 0
        while True:
            attempt += 1
            retry_after = None
            try:
                response = self._http.post(url, json=payload, headers=headers)
            except httpx.TransportError as exc:
                status, body = None, b""
                error = "transport: " + type(exc).__name__
                retryable = True
            else:
                status, body = response.status_code, response.content
                if 200 <= status < 300:
                    error = None
                    retryable = False
                else:
                    error = f"{status} {_error_code(body)}"
                    retryable = status in RETRYABLE_STATUSES
                    retry_after = _retry_after(response)
            if not retryable or attempt > self._max_retries:
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
        self, *, image_data_url: str, prompt: str, size: str | None = None, model: str = "muse-image-1.0"
    ) -> CallResult:
        payload: dict = {
            "model": model,
            "prompt": prompt,
            "images": [{"image_url": image_data_url}],
            "n": 1,
            "output_format": "webp",
        }
        if size is not None:
            payload["size"] = size
        return self.post("/images/edits", payload)


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
