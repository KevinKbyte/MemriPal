"""Bring your own Meta key past the spend cap (MEM-122): per-request backend, client and guard on that key.

The key arrives only in header HEADER and lives only in this request's objects: never a ContextVar, the shared
backend/guard, a log line, the live cache, the spend state (its dir is an HMAC of the key) or a response.
"""

import hashlib
import hmac
import json
import math
import os
import re
from pathlib import Path
from typing import Any, NamedTuple

import httpx
from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.datastructures import MutableHeaders

from memripal.backend import BackendCallFailed, MetaBackend, _atomic_write
from memripal.meta_client import DEFAULT_BASE_URL, CallResult, MetaClient
from memripal.meta_spend_guard import _COSTS, _LOCK, MetaSpendCapReached, MetaSpendGuard

HEADER = "X-Memripal-Meta-Key"
# What happened to the key, for the page: "invalid", "limit" or "rejected:<model>"; absent when all went well.
OUTCOME_HEADER = "X-Memripal-Byok"
CAP_ENV = "MEMRIPAL_BYOK_SPEND_CAP_USD"
DEFAULT_CAP_USD = 5.0
MAX_KEY_CHARS = 512
# Meta answers these when the key is wrong, lacks access to the model, or the model is unknown to the key.
REJECTED_STATUSES = frozenset({401, 403, 404})
# Only these mean the key itself is bad; any other answer (404 included) shows Meta knows the key.
BAD_KEY_STATUSES = frozenset({401, 403})
LIMIT_CODE = "byok_limit_reached"
REJECTED_CODE = "byok_key_rejected"
BAD_KEY_CODE = "bad_meta_key"
# Domain-separates this HMAC from the record signatures made with the same secret (MEM-036).
_DIR_LABEL = b"memripal-byok-spend-v1\x00"
_MODEL = re.compile(r"[a-z0-9][a-z0-9.\-]{0,63}")
_SCOPE_KEY = "memripal.byok"


class ByokLimitReached(MetaSpendCapReached):
    """The visitor's own key reached its BYOK limit; still a MetaSpendCapReached for the call sites."""


class ByokKeyRejected(BackendCallFailed):
    """Meta refused the visitor's key (401/403/404) for `model`; the message names the model only."""

    def __init__(self, model: str) -> None:
        super().__init__(f"key refused for {model}")
        self.model = model


def key_ok(raw: object) -> bool:
    """1-512 printable ASCII chars, no whitespace: anything else is refused before any upstream call."""
    return isinstance(raw, str) and 0 < len(raw) <= MAX_KEY_CHARS and all("!" <= c <= "~" for c in raw)


def cap_from_env() -> float:
    raw = os.environ.get(CAP_ENV, "").strip()
    cap = float(raw) if raw else DEFAULT_CAP_USD
    if not math.isfinite(cap) or cap < 0:
        raise ValueError(f"{CAP_ENV} must be a finite number >= 0")
    return cap


def spend_dir(key: str, *, secret: bytes, spend_root: Path) -> Path:
    """<spend root>/byok/<HMAC-SHA256(secret, label + key)>: stable per key, reveals nothing of it."""
    digest = hmac.new(secret, _DIR_LABEL + key.encode("ascii"), hashlib.sha256).hexdigest()
    return Path(spend_root) / "byok" / digest


class ByokOutcome:
    """Per-request flags the page is told about; holds no key."""

    def __init__(self) -> None:
        self.limit = False
        self.rejected_model: str | None = None

    def header(self) -> str | None:
        if self.limit:
            return "limit"
        if self.rejected_model is not None and _MODEL.fullmatch(self.rejected_model):
            return "rejected:" + self.rejected_model
        return None

    def __repr__(self) -> str:
        return f"ByokOutcome(limit={self.limit}, rejected_model={self.rejected_model!r})"


# Spend charged on a key Meta has not accepted yet, per state file: memory only, read and written under _LOCK
# (the shared guards' lock), so it counts against the cap for every concurrent request on that key.
_UNCONFIRMED: dict[Path, float] = {}


class _ByokGuard(MetaSpendGuard):
    """A provisional guard keeps a new key's charges in _UNCONFIRMED until settle(): a key Meta refuses
    (401/403) never creates its spend dir, so random keys cannot fill the disk (review 2026-11-04)."""

    def __init__(self, state_dir: Path, *, cap_usd: float, outcome=None, provisional: bool = False) -> None:
        super().__init__(state_dir, cap_usd=cap_usd)
        self._outcome = outcome
        self._provisional = provisional
        self._held = 0.0

    def charge(self, kind: str) -> None:
        cost = _COSTS[kind]
        with _LOCK:
            stored = self.spent_usd
            unconfirmed = _UNCONFIRMED.get(self._path, 0.0)
            if stored + unconfirmed + cost > self.cap_usd:
                if self._outcome is not None:
                    self._outcome.limit = True
                raise ByokLimitReached(f"BYOK limit of ${self.cap_usd:.2f} reached: {kind} refused")
            if self._provisional and not self._path.exists():
                _UNCONFIRMED[self._path] = unconfirmed + cost
                self._held += cost
            else:
                _atomic_write(self._path, json.dumps({"spent_usd": stored + cost}).encode("ascii"))

    def settle(self, *, accepted: bool) -> None:
        """Release this guard's unconfirmed charges: stored if Meta accepted the key, else dropped."""
        with _LOCK:
            held, self._held = self._held, 0.0
            if not held:
                return
            left = _UNCONFIRMED.pop(self._path, 0.0) - held
            if left > 1e-9:
                _UNCONFIRMED[self._path] = left
            if accepted:
                _atomic_write(self._path, json.dumps({"spent_usd": self.spent_usd + held}).encode("ascii"))


def byok_guard(
    key: str, *, secret: bytes, spend_root: Path, cap_usd: float, outcome=None, provisional: bool = False
) -> MetaSpendGuard:
    """The key's own guard; a new guard for the same key reads the same state, so the limit holds."""
    state_dir = spend_dir(key, secret=secret, spend_root=spend_root)
    return _ByokGuard(state_dir, cap_usd=cap_usd, outcome=outcome, provisional=provisional)


def _model_of(content: dict) -> str:
    if isinstance(content.get("json"), dict):
        return str(content["json"].get("model", ""))
    request = (content.get("files") or {}).get("request")  # /asr/transcribe: model sits in the JSON part
    try:
        return str(json.loads(request[1]).get("model", ""))
    except (TypeError, ValueError, IndexError, AttributeError):
        return ""


class _ByokClient(MetaClient):
    """A MetaClient on the visitor's key that turns a refused key into ByokKeyRejected naming the model."""

    def __init__(self, api_key: str, *, outcome: ByokOutcome, spend_guard: _ByokGuard, **kwargs: Any) -> None:
        super().__init__(api_key, spend_guard=spend_guard, **kwargs)
        self._outcome = outcome
        self._byok_guard = spend_guard

    def _send(self, path: str, **content: Any) -> CallResult:
        # Stored unless Meta answered 401/403; a call that raised may still have been billed, so it is stored.
        accepted = True
        try:
            result = super()._send(path, **content)
            accepted = result.status not in BAD_KEY_STATUSES
        finally:
            self._byok_guard.settle(accepted=accepted)
        if result.status in REJECTED_STATUSES:
            model = _model_of(content)
            self._outcome.rejected_model = model
            raise ByokKeyRejected(model)
        return result


class ByokSession:
    """One request's backend + ASR client on the visitor's key; close() releases its HTTP client."""

    def __init__(self, backend: MetaBackend, client: MetaClient, outcome: ByokOutcome) -> None:
        self.backend = backend
        self.asr_client = client
        self.outcome = outcome

    def close(self) -> None:
        self.asr_client.close()

    def __repr__(self) -> str:
        return "ByokSession()"


def open_session(
    key: str,
    *,
    secret: bytes,
    spend_root: Path,
    cap_usd: float,
    transport: httpx.BaseTransport | None = None,
) -> ByokSession:
    """A fresh backend on `key`: Meta's own base URL, its own guard, no chat fallback, no cache root."""
    outcome = ByokOutcome()
    guard = _ByokGuard(
        spend_dir(key, secret=secret, spend_root=spend_root),
        cap_usd=cap_usd,
        outcome=outcome,
        provisional=True,
    )
    client = _ByokClient(
        key, base_url=DEFAULT_BASE_URL, transport=transport, spend_guard=guard, outcome=outcome
    )
    # cache_root=None: a visitor's paid answers (and photos) never land in the shared live cache.
    backend = MetaBackend(key, client=client, chat_fallback=None, cache_root=None)
    return ByokSession(backend, client, outcome)


class ByokConfig(NamedTuple):
    """Read once in create_app: HMAC secret (the record key), spend root, cap, and a test transport."""

    secret: bytes
    spend_root: Path
    cap_usd: float
    transport: httpx.BaseTransport | None = None

    def __repr__(self) -> str:
        return "ByokConfig()"


def session_for(request: Request, config: ByokConfig) -> tuple[ByokSession | None, JSONResponse | None]:
    """(None, None) without HEADER; (None, 400 bad_meta_key) for a bad or repeated key, before any call;
    else a fresh session on the key, handed to ByokOutcomeHeader to name its outcome and close it."""
    if HEADER not in request.headers:
        return None, None
    sent = request.headers.getlist(HEADER)
    if len(sent) != 1 or not key_ok(sent[0]):
        bad = JSONResponse({"error": BAD_KEY_CODE}, status_code=400, headers={OUTCOME_HEADER: "invalid"})
        return None, bad
    session = open_session(
        sent[0], secret=config.secret, spend_root=config.spend_root, cap_usd=config.cap_usd,
        transport=config.transport,
    )  # fmt: skip
    holder = request.scope.get(_SCOPE_KEY)
    if isinstance(holder, list):
        holder.append(session)
    return session, None


class ByokOutcomeHeader:
    """Sets OUTCOME_HEADER from the request's BYOK session (if any); closes it once the response is sent."""

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        sessions: list[ByokSession] = []
        scope[_SCOPE_KEY] = sessions

        async def send_with_header(message):
            if message["type"] == "http.response.start":
                for session in sessions:
                    if (value := session.outcome.header()) is not None:
                        MutableHeaders(scope=message)[OUTCOME_HEADER] = value
            await send(message)

        try:
            await self.app(scope, receive, send_with_header)
        finally:
            for session in sessions:
                session.close()
            sessions.clear()
