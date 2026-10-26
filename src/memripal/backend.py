"""Model backends: offline fixture replay and the live Meta Model API (MEM-002, MEM-003)."""

import hashlib
import json
import os
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Protocol

# Bump when any prompt changes so stale recorded responses stop matching.
PROMPT_VERSION = "v1"

EXT = {"segment": ".txt", "spark_json": ".json", "image_edit": ".webp"}


class MissingApiKey(RuntimeError):
    """Raised when meta mode is selected without META_API_KEY in the environment."""


class FixtureMissing(LookupError):
    """Raised when fixture mode has no recorded response for a key."""


@dataclass(frozen=True)
class CacheKey:
    method: str
    photo_sha: str
    subject: str
    attempt: int = 0
    prompt_version: str = PROMPT_VERSION

    def digest(self) -> str:
        payload = json.dumps(asdict(self), sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()


class ResponseCache:
    """Write-through store laid out as root/<method>/<digest><ext>."""

    def __init__(self, root: Path) -> None:
        self.root = Path(root)

    def path_for(self, key: CacheKey) -> Path:
        if key.method not in EXT:
            raise ValueError(f"unknown cache method: {key.method!r}")
        return self.root / key.method / f"{key.digest()}{EXT[key.method]}"

    def put(self, key: CacheKey, body: bytes) -> Path:
        path = self.path_for(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
        return path

    def get(self, key: CacheKey) -> bytes | None:
        path = self.path_for(key)
        return path.read_bytes() if path.is_file() else None


class ModelBackend(Protocol):
    mode: str

    def segment(self, photo_sha: str, phrase: str, attempt: int = 0) -> str: ...

    def spark_json(self, photo_sha: str, subject: str, attempt: int = 0) -> dict: ...

    def image_edit(self, photo_sha: str, subject: str, attempt: int = 0) -> bytes: ...


class FixtureBackend:
    """Replays recorded responses from a ResponseCache root; never touches the network."""

    mode = "fixture"

    def __init__(self, root: Path) -> None:
        self.cache = ResponseCache(root)

    def _replay(self, method: str, photo_sha: str, subject: str, attempt: int) -> bytes:
        key = CacheKey(method=method, photo_sha=photo_sha, subject=subject, attempt=attempt)
        body = self.cache.get(key)
        if body is None:
            raise FixtureMissing(f"no recorded {method} response for digest {key.digest()}")
        return body

    def segment(self, photo_sha: str, phrase: str, attempt: int = 0) -> str:
        return self._replay("segment", photo_sha, phrase, attempt).decode("utf-8")

    def spark_json(self, photo_sha: str, subject: str, attempt: int = 0) -> dict:
        return json.loads(self._replay("spark_json", photo_sha, subject, attempt))

    def image_edit(self, photo_sha: str, subject: str, attempt: int = 0) -> bytes:
        return self._replay("image_edit", photo_sha, subject, attempt)


class MetaBackend:
    """Live Meta Model API backend; calls land in S1."""

    mode = "meta"

    def __init__(self, api_key: str) -> None:
        self._api_key = api_key

    # Explicit so the key can never surface through a default dataclass/object repr.
    def __repr__(self) -> str:
        return "MetaBackend()"

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
        return MetaBackend(api_key)
    raise ValueError(f"unknown MEMRIPAL_MODE {mode!r}; expected 'fixture' or 'meta'")
