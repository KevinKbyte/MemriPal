"""Spark fallback signal (MEM-107): a request whose Spark call fell back to Meta says so in a header."""

from contextvars import ContextVar

from starlette.datastructures import MutableHeaders

HEADER = "X-Memripal-Chat-Fallback"

# None outside an HTTP request, so a note from a script or test run is dropped instead of leaking
# into a later request. Starlette's run_in_threadpool copies the context, so sync routes share the list.
_noted: ContextVar[list[str] | None] = ContextVar("memripal_chat_fallback", default=None)


def note_chat_fallback(provider: str) -> None:
    """Record that this request's Spark call fell back from `provider`; a no-op outside a request."""
    noted = _noted.get()
    if noted is not None:
        noted.append(provider)


class ChatFallbackHeader:
    """Gives each HTTP request a fresh fallback list; sets HEADER to the first provider noted in it."""

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        noted: list[str] = []
        token = _noted.set(noted)

        async def send_with_header(message):
            if message["type"] == "http.response.start" and noted:
                MutableHeaders(scope=message)[HEADER] = noted[0]
            await send(message)

        try:
            await self.app(scope, receive, send_with_header)
        finally:
            _noted.reset(token)
