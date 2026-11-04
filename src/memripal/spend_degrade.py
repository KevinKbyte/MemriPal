"""Degrade past the Meta spend cap (MEM-121): replay saved results, and name the cap in a response header."""

from collections.abc import Iterable
from contextvars import ContextVar
from pathlib import Path
from typing import Any

from starlette.datastructures import MutableHeaders

from memripal.backend import ModelBackend, ModelRequest, ResponseCache, _decode
from memripal.meta_spend_guard import MetaSpendCapReached

HEADER = "X-Memripal-Spend-Cap"
SAVED, BACKUP, CAPPED = "saved", "backup", "capped"
# Most severe wins: a request that was refused anywhere says so, even if another call was served.
_RANK = {BACKUP: 0, SAVED: 1, CAPPED: 2}

# None outside an HTTP request, so a note from a script or test is dropped (the chat_fallback pattern).
_noted: ContextVar[list[str] | None] = ContextVar("memripal_spend_cap", default=None)


def note_spend_cap(state: str) -> None:
    """Record that this request met the cap (`saved`, `backup` or `capped`); a no-op outside a request."""
    noted = _noted.get()
    if noted is not None and state in _RANK:
        noted.append(state)


class SpendCapHeader:
    """Gives each HTTP request a fresh list; sets HEADER to the most severe state noted in it."""

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        noted: list[str] = []
        token = _noted.set(noted)

        async def send_with_header(message):
            if message["type"] == "http.response.start" and noted:
                MutableHeaders(scope=message)[HEADER] = max(noted, key=_RANK.__getitem__)
            await send(message)

        try:
            await self.app(scope, receive, send_with_header)
        finally:
            _noted.reset(token)


class SavedResultsBackend:
    """Wraps a live backend: a call the spend cap refuses replays the same request key from `roots`, in order.

    Roots are ResponseCache trees (the live cache, then the committed fixture replay). A miss re-raises the
    refusal, so routes keep their cap code. Everything else passes through to the wrapped backend.
    """

    def __init__(self, backend: ModelBackend, roots: Iterable[Path]) -> None:
        self._backend = backend
        self._caches = [ResponseCache(Path(root)) for root in roots]

    def __getattr__(self, name: str) -> Any:
        return getattr(self._backend, name)

    def call(self, req: ModelRequest) -> Any:
        try:
            return self._backend.call(req)
        except MetaSpendCapReached:
            key = req.cache_key()
            for cache in self._caches:
                body = cache.get(key)
                if body is not None:
                    note_spend_cap(SAVED)
                    return _decode(req.method, body)
            note_spend_cap(CAPPED)
            raise


def with_saved_results(backend: ModelBackend, roots: Iterable[Path]) -> SavedResultsBackend:
    """A per-instance wrapper, cheap to build per request (a BYOK backend can take its own roots)."""
    return SavedResultsBackend(backend, roots)
