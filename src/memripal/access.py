"""Judges-only access gate (MEM-103, ADR 0056): a shared key traded at /access for an HttpOnly cookie.

Pure ASGI so it can sit inside SecurityHeaders/TrustedHost and outside ApiGuard and the body cap:
an unauthenticated request is refused before it spends a rate-limit event or a concurrency slot."""

import hashlib
import hmac
import os
import time
from pathlib import Path
from urllib.parse import parse_qs

from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from starlette.datastructures import Headers

from memripal import ratelimit as rl

COOKIE = "memripal_access"
COOKIE_MAX_AGE_S = 14 * 24 * 3600
LOGIN_BODY_CAP = 1024
DEFAULT_MAX_FAILS = 20
NO_STORE = {"Cache-Control": "no-store"}
ERROR_MARKER = "<!--error-->"
ERROR_HTML = '<p class="notice" role="alert">That key did not work. Try again.</p>'
# Exact matches only: a prefix match would let /static/map or a crafted path ride along unauthenticated.
EXEMPT_ASSETS = frozenset(
    {
        "/static/manifest.webmanifest",
        "/static/icon.svg",
        "/static/assets/icon-192.png",
        "/static/assets/icon-512.png",
        "/static/style.css",
        "/static/theme-painterly.css",
    }
)


class _LoginTooLarge(Exception):
    pass


def access_key() -> str | None:
    """MEMRIPAL_ACCESS_KEY stripped (Secret Manager values end in a newline); blank counts as unset."""
    return os.environ.get("MEMRIPAL_ACCESS_KEY", "").strip() or None


def cookie_value(key: str) -> str:
    # Derived, never the key itself, so the cookie leaks nothing and dies when the key rotates.
    return hmac.new(key.encode("utf-8"), b"memripal-access-v1", hashlib.sha256).hexdigest()


def has_access(headers: Headers, key: str | None) -> bool:
    """True when the request carries a valid access cookie for `key`."""
    if key is None:
        return False
    expected = cookie_value(key).encode("ascii")
    for raw in headers.getlist("cookie"):
        for part in raw.split(";"):
            name, _, value = part.partition("=")
            if name.strip() == COOKIE and hmac.compare_digest(value.strip().encode("latin-1"), expected):
                return True
    return False


def lockout_from_env(env_int, clock) -> rl.SlidingWindow:
    """Per-IP failed-key lockout, looser than the passcode one: a whole venue can share one IP."""
    max_fails = env_int("MEMRIPAL_ACCESS_MAX_FAILS", 1) or DEFAULT_MAX_FAILS
    window = env_int("MEMRIPAL_LOCKOUT_S", 1) or rl.DEFAULT_LOCKOUT_S
    return rl.SlidingWindow(max_fails, window, clock or time.monotonic)


def _json(status: int, code: str) -> JSONResponse:
    return JSONResponse({"error": code}, status_code=status, headers=NO_STORE)


async def _read_login(scope, receive) -> bytes:
    """The request body, raising _LoginTooLarge past LOGIN_BODY_CAP (declared or streamed)."""
    length = Headers(scope=scope).get("content-length")
    if length is not None and length.isascii() and length.isdigit() and int(length) > LOGIN_BODY_CAP:
        raise _LoginTooLarge
    body = b""
    while True:
        # An http.disconnect carries no body and no more_body, so it ends the loop too.
        message = await receive()
        body += message.get("body", b"")
        if len(body) > LOGIN_BODY_CAP:
            raise _LoginTooLarge
        if not message.get("more_body", False):
            return body


class AccessGate:
    """Refuses every non-exempt request without the access cookie; serves and handles /access itself."""

    def __init__(self, app, key: str | None, limiter, lockout, trust_xff: bool, page: Path) -> None:
        self.app = app
        self.key = key
        self.lockout = lockout
        self.trust_xff = trust_xff
        # K_SERVICE is set only on Cloud Run: a missing key there must fail closed, never open.
        self.cloud_run = bool(os.environ.get("K_SERVICE"))
        self.page = page.read_text(encoding="utf-8")
        # POST /access never reaches the inner ApiGuard, so the login handler gets its own guard on the
        # shared limiter; /access is not a capped route, so it takes no concurrency slot.
        self.login = rl.ApiGuard(self._login, limiter=limiter, concurrency=1, trust_xff=trust_xff)

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http" or (self.key is None and not self.cloud_run):
            return await self.app(scope, receive, send)
        method, path = scope["method"], scope["path"]
        if method in ("GET", "HEAD") and (path == "/healthz" or path in EXEMPT_ASSETS):
            return await self.app(scope, receive, send)
        if self.key is None:
            return await _json(503, "access_unconfigured")(scope, receive, send)
        if path == "/access" and method == "GET":
            return await self._page(200)(scope, receive, send)
        if path == "/access" and method == "POST":
            return await self.login(scope, receive, send)
        headers = Headers(scope=scope)
        if not has_access(headers, self.key):
            if method == "GET" and "text/html" in headers.get("accept", ""):
                redirect = RedirectResponse("/access", status_code=303, headers=NO_STORE)
                return await redirect(scope, receive, send)
            return await _json(401, "access_required")(scope, receive, send)
        # The cookie also rides on requests from same-site sibling hosts; browsers always send
        # Sec-Fetch-Site, while other clients send none and carry no judge cookie.
        site = headers.get("sec-fetch-site")
        if method == "POST" and site is not None and site != "same-origin":
            return await _json(403, "cross_site")(scope, receive, send)
        await self.app(scope, receive, send)

    def _page(self, status: int) -> HTMLResponse:
        error = ERROR_HTML if status == 401 else ""
        return HTMLResponse(self.page.replace(ERROR_MARKER, error), status_code=status, headers=NO_STORE)

    async def _login(self, scope, receive, send) -> None:
        ip = rl.client_ip(scope, self.trust_xff)
        if (retry := self.lockout.retry_after(ip)) is not None:
            locked = rl.retry_error("too_many_attempts", retry)
            locked.headers.update(NO_STORE)
            return await locked(scope, receive, send)
        try:
            body = await _read_login(scope, receive)
        except _LoginTooLarge:
            return await _json(413, "too_large")(scope, receive, send)
        # The key comes from the form body only; the query string is never read.
        sent = parse_qs(body.decode("utf-8", errors="replace")).get("key", [""])[0].strip()
        if not hmac.compare_digest(sent.encode("utf-8"), str(self.key).encode("utf-8")):
            self.lockout.record(ip)
            return await self._page(401)(scope, receive, send)
        self.lockout.clear(ip)
        resp = RedirectResponse("/", status_code=303, headers=NO_STORE)
        resp.set_cookie(
            COOKIE, cookie_value(str(self.key)), max_age=COOKIE_MAX_AGE_S, path="/",
            secure=True, httponly=True, samesite="lax",
        )  # fmt: skip
        await resp(scope, receive, send)
