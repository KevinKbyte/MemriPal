"""App-wide XSS control (MEM-042 C1): a strict CSP plus nosniff on every HTTP response."""

from starlette.datastructures import MutableHeaders

SECURITY_HEADERS = {
    "Content-Security-Policy": (
        # wasm-unsafe-eval: lets the SQLite wasm compile (item 159) without allowing JS eval.
        "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; img-src 'self' data: blob:; "
        "object-src 'none'; base-uri 'none'; "
        "form-action 'none'; frame-ancestors 'none'"
    ),
    "X-Content-Type-Options": "nosniff",
}


class SecurityHeaders:
    """Sets SECURITY_HEADERS on every HTTP response, replacing any earlier value."""

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        async def send_with_headers(message):
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                for name, value in SECURITY_HEADERS.items():
                    headers[name] = value
            await send(message)

        await self.app(scope, receive, send_with_headers)
