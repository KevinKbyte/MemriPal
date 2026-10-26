"""Model backends: offline fixture replay and the live Meta Model API (MEM-002, MEM-003, MEM-014)."""

import contextlib
import functools
import hashlib
import json
import os
import re
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Protocol

# Bump when any prompt changes so stale recorded responses stop matching.
PROMPT_VERSION = "v1"

EXT = {"segment": ".txt", "spark_json": ".json", "image_edit": ".webp"}

_PHOTO_SHA = re.compile(r"[0-9a-f]{64}")


class MissingApiKey(RuntimeError):
    """Raised when meta mode is selected without META_API_KEY in the environment."""


class FixtureMissing(LookupError):
    """Raised when fixture mode has no recorded response for a key."""


class BackendCallFailed(RuntimeError):
    """A live call failed or returned an incomplete/schema-invalid response; message holds no key or body."""


def _check_photo_sha(photo_sha: object) -> None:
    if not isinstance(photo_sha, str) or not _PHOTO_SHA.fullmatch(photo_sha):
        raise ValueError("photo_sha must be 64 lowercase hex chars")


def _sha256_json(value: object) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class CacheKey:
    """MEM-003 logical key; the fields are fixed by the committed fixtures and their tests."""

    method: str
    photo_sha: str
    subject: str
    attempt: int = 0
    prompt_version: str = PROMPT_VERSION

    def __post_init__(self) -> None:
        _check_photo_sha(self.photo_sha)

    def digest(self) -> str:
        return _sha256_json(asdict(self))


@dataclass(frozen=True)
class RequestKey:
    """Derived from a ModelRequest (MEM-014): CacheKey's fields plus all else that shapes the answer."""

    method: str
    photo_sha: str
    subject: str
    attempt: int
    model: str
    prompt_template_id: str
    gen_params_digest: str
    schema_digest: str
    prompt_version: str
    templates_digest: str

    def __post_init__(self) -> None:
        _check_photo_sha(self.photo_sha)

    def digest(self) -> str:
        return _sha256_json(asdict(self))


@functools.cache
def _templates_digest() -> str:
    # Lazy: probe imports meta_client, which imports this module (cycle at module top).
    from memripal.probe import PHRASE_PROMPT, PHRASE_SCHEMA, _reask_prompt

    return _sha256_json([PHRASE_PROMPT, PHRASE_SCHEMA, _reask_prompt(["{exclude}"])])


@dataclass(frozen=True)
class ModelRequest:
    """Everything a live call needs; the cache key is derived from it, never supplied alongside it."""

    method: str
    image_jpeg: bytes
    subject: str
    attempt: int
    model: str
    prompt_template_id: str
    gen_params: dict
    schema: dict | None

    def __post_init__(self) -> None:
        for name in ("method", "subject", "model", "prompt_template_id"):
            if not isinstance(getattr(self, name), str):
                raise TypeError(f"ModelRequest.{name} must be a str")
        if self.method not in EXT:
            raise ValueError(f"unknown request method: {self.method!r}")
        if not isinstance(self.image_jpeg, bytes):
            raise TypeError("ModelRequest.image_jpeg must be bytes")
        if not self.image_jpeg:
            raise ValueError("ModelRequest.image_jpeg must be non-empty")

    def cache_key(self) -> RequestKey:
        return RequestKey(
            method=self.method,
            photo_sha=hashlib.sha256(self.image_jpeg).hexdigest(),
            subject=self.subject,
            attempt=self.attempt,
            model=self.model,
            prompt_template_id=self.prompt_template_id,
            gen_params_digest=_sha256_json(self.gen_params),
            schema_digest=_sha256_json(self.schema),
            # Read at call time so a prompt bump invalidates keys without re-importing.
            prompt_version=PROMPT_VERSION,
            templates_digest=_templates_digest(),
        )


class ResponseCache:
    """Write-through store laid out as root/<method>/<digest><ext>."""

    def __init__(self, root: Path) -> None:
        self.root = Path(root)

    def path_for(self, key: CacheKey | RequestKey) -> Path:
        if key.method not in EXT:
            raise ValueError(f"unknown cache method: {key.method!r}")
        return self.root / key.method / f"{key.digest()}{EXT[key.method]}"

    def put(self, key: CacheKey | RequestKey, body: bytes) -> Path:
        """Atomic (temp file in the target dir, then os.replace): a failure keeps the old entry, no temp."""
        path = self.path_for(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".", suffix=".tmp")
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(body)
            os.replace(tmp, path)
        except BaseException:
            with contextlib.suppress(FileNotFoundError):
                os.unlink(tmp)
            raise
        return path

    def get(self, key: CacheKey | RequestKey) -> bytes | None:
        path = self.path_for(key)
        return path.read_bytes() if path.is_file() else None


def _decode(method: str, body: bytes) -> Any:
    if method == "segment":
        return body.decode("utf-8")
    if method == "spark_json":
        return json.loads(body)
    return body


class ModelBackend(Protocol):
    mode: str

    def call(self, req: ModelRequest) -> Any: ...

    def segment(self, photo_sha: str, phrase: str, attempt: int = 0) -> str: ...

    def spark_json(self, photo_sha: str, subject: str, attempt: int = 0) -> dict: ...

    def image_edit(self, photo_sha: str, subject: str, attempt: int = 0) -> bytes: ...


class FixtureBackend:
    """Replays recorded responses from a ResponseCache root; never touches the network."""

    mode = "fixture"

    def __init__(self, root: Path) -> None:
        self.cache = ResponseCache(root)

    def _replay(self, key: CacheKey | RequestKey) -> bytes:
        body = self.cache.get(key)
        if body is None:
            raise FixtureMissing(f"no recorded {key.method} response for digest {key.digest()}")
        return body

    def call(self, req: ModelRequest) -> Any:
        return _decode(req.method, self._replay(req.cache_key()))

    # MEM-003 shims: no image bytes here, so they replay by the legacy CacheKey the committed fixtures use.
    def _legacy(self, method: str, photo_sha: str, subject: str, attempt: int) -> bytes:
        return self._replay(CacheKey(method=method, photo_sha=photo_sha, subject=subject, attempt=attempt))

    def segment(self, photo_sha: str, phrase: str, attempt: int = 0) -> str:
        return self._legacy("segment", photo_sha, phrase, attempt).decode("utf-8")

    def spark_json(self, photo_sha: str, subject: str, attempt: int = 0) -> dict:
        return json.loads(self._legacy("spark_json", photo_sha, subject, attempt))

    def image_edit(self, photo_sha: str, subject: str, attempt: int = 0) -> bytes:
        return self._legacy("image_edit", photo_sha, subject, attempt)


_JSON_TYPES = {
    "object": dict,
    "array": list,
    "string": str,
    "integer": int,
    "number": (int, float),
    "boolean": bool,
    "null": type(None),
}
_SCHEMA_KEYWORDS = {"type", "properties", "required", "additionalProperties", "items"}


def _schema_valid(value: Any, schema: dict) -> bool:
    """The strict json_schema subset our prompts use; any other keyword fails closed."""
    if set(schema) - _SCHEMA_KEYWORDS:
        return False
    kind = _JSON_TYPES.get(schema.get("type", ""), object)
    if not isinstance(value, kind) or (isinstance(value, bool) and kind in (int, (int, float))):
        return False
    if isinstance(value, dict):
        props = schema.get("properties", {})
        if any(name not in value for name in schema.get("required", [])):
            return False
        if schema.get("additionalProperties") is False and set(value) - set(props):
            return False
        return all(_schema_valid(v, props[k]) for k, v in value.items() if k in props)
    if isinstance(value, list) and "items" in schema:
        return all(_schema_valid(v, schema["items"]) for v in value)
    return True


def _prompt_for(template_id: str) -> str:
    from memripal.probe import PHRASE_PROMPT

    prompts = {"phrase": PHRASE_PROMPT}
    if template_id not in prompts:
        raise ValueError(f"unknown prompt template: {template_id!r}")
    return prompts[template_id]


class MetaBackend:
    """Live Meta Model API backend; write-through to `cache_root` when given (MEM-014)."""

    mode = "meta"

    def __init__(self, api_key: str, *, cache_root: Path | None = None, client: Any = None) -> None:
        self._api_key = api_key
        self.cache = ResponseCache(cache_root) if cache_root is not None else None
        if client is None:
            # Lazy: meta_client imports MissingApiKey from this module.
            from memripal.meta_client import MetaClient

            client = MetaClient(api_key)
        self._client = client

    # Explicit so the key can never surface through a default dataclass/object repr.
    def __repr__(self) -> str:
        return "MetaBackend()"

    def call(self, req: ModelRequest) -> Any:
        from memripal.meta_client import chat_content_json, responses_text, to_data_url

        image_url = to_data_url(req.image_jpeg)
        if req.method == "segment":
            result = self._client.segment(
                image_data_url=image_url, phrase=req.subject, model=req.model, **req.gen_params
            )
            parse, valid = responses_text, lambda v: isinstance(v, str)
        elif req.method == "spark_json":
            result = self._client.chat_json(
                prompt=_prompt_for(req.prompt_template_id),
                schema=req.schema,
                schema_name=req.subject,
                image_data_url=image_url,
                model=req.model,
                **req.gen_params,
            )
            parse = chat_content_json

            def valid(v: Any) -> bool:
                return isinstance(v, dict) and (req.schema is None or _schema_valid(v, req.schema))
        else:
            raise NotImplementedError(f"live {req.method} lands in a later slice")
        if not result.ok:
            # CallResult.error is "<status> <safe code>" and already key-redacted; the body is never quoted.
            raise BackendCallFailed(f"{req.method} call failed: {result.error}")
        try:
            value = parse(result.body)
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            raise BackendCallFailed(f"{req.method} response incomplete or malformed") from exc
        if not valid(value):
            raise BackendCallFailed(f"{req.method} response does not match its schema")
        if self.cache is not None:
            body = value.encode("utf-8") if isinstance(value, str) else json.dumps(value).encode("utf-8")
            self.cache.put(req.cache_key(), body)
        return value

    def segment(self, photo_sha: str, phrase: str, attempt: int = 0) -> str:
        raise NotImplementedError("S1")

    def spark_json(self, photo_sha: str, subject: str, attempt: int = 0) -> dict:
        raise NotImplementedError("S1")

    def image_edit(self, photo_sha: str, subject: str, attempt: int = 0) -> bytes:
        raise NotImplementedError("S1")


def select_backend(mode: str | None, fixtures_root: Path) -> ModelBackend:
    if mode is None:
        mode = os.environ.get("MEMRIPAL_MODE", "fixture")
    if mode == "fixture":
        return FixtureBackend(fixtures_root)
    if mode == "meta":
        # Environment only: never fall back to .env or ~/.secrets files.
        api_key = os.environ.get("META_API_KEY", "")
        if not api_key:
            raise MissingApiKey("meta mode requires META_API_KEY in the environment")
        return MetaBackend(api_key, cache_root=fixtures_root)
    raise ValueError(f"unknown MEMRIPAL_MODE {mode!r}; expected 'fixture' or 'meta'")
