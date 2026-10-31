"""Per-IP rate limit, failed-passcode lockout and per-route concurrency caps (MEM-034).

Split out of app.py to keep it under its line budget. All state is in-memory and per app instance."""

import asyncio
import ipaddress
import math
import os
import threading
import time
from collections import deque
from collections.abc import Callable

from fastapi.responses import JSONResponse
from starlette.datastructures import Headers

RATE_WINDOW_S = 60
DEFAULT_RATE_PER_MIN = 30
DEFAULT_MAX_FAILS = 5
DEFAULT_LOCKOUT_S = 300
DEFAULT_ROUTE_CONCURRENCY = 4
LIMITED_ROUTES = frozenset({"/loci", "/split", "/associate", "/scenes", "/recall/audio", "/place"})
CAPPED_ROUTES = ("/loci", "/split", "/associate", "/recall/audio")
# Short and bounded: a burst past the cap is refused fast instead of queueing behind a stalled upstream.
SLOT_WAIT_S = 1.0
SLOT_POLL_S = 0.05


class SlidingWindow:
    """Per-key event times; a key is over the limit while `limit` events fall within `window_s` seconds."""

    def __init__(self, limit: int, window_s: float, clock: Callable[[], float]) -> None:
        self.limit = limit
        self.window_s = window_s
        self.clock = clock
        # Touched only from the event loop (middleware and async route bodies), so no lock is needed.
        self._events: dict[str, deque[float]] = {}
        self._next_sweep = -math.inf

    def retry_after(self, key: str) -> int | None:
        """Whole seconds (>= 1) until `key` is under the limit again, or None when it already is."""
        now = self.clock()
        events = self._events.get(key)
        if events is None:
            return None
        while events and events[0] + self.window_s <= now:
            events.popleft()
        if not events:
            del self._events[key]
            return None
        if len(events) < self.limit:
            return None
        # Refused events are never recorded, so the oldest one is the first to free a slot.
        return max(1, math.ceil(events[0] + self.window_s - now))

    def record(self, key: str) -> None:
        now = self.clock()
        # Amortized sweep, at most once per window: a one-off client's key would otherwise live forever.
        if now >= self._next_sweep:
            # ev[-1] is safe: no key holds an empty deque (retry_after deletes emptied keys, clear pops).
            self._events = {k: ev for k, ev in self._events.items() if ev[-1] + self.window_s > now}
            self._next_sweep = now + self.window_s
        self._events.setdefault(key, deque()).append(now)

    def clear(self, key: str) -> None:
        self._events.pop(key, None)

    def __len__(self) -> int:
        return len(self._events)


def from_env(env_int: Callable[[str, int], int | None], clock: Callable[[], float] | None):
    """(rate limiter, passcode lockout, route concurrency, trust X-Forwarded-For), read once at startup."""
    clock = clock or time.monotonic
    rate = SlidingWindow(env_int("MEMRIPAL_RATE_PER_MIN", 1) or DEFAULT_RATE_PER_MIN, RATE_WINDOW_S, clock)
    max_fails = env_int("MEMRIPAL_PASSCODE_MAX_FAILS", 1) or DEFAULT_MAX_FAILS
    lockout = SlidingWindow(max_fails, env_int("MEMRIPAL_LOCKOUT_S", 1) or DEFAULT_LOCKOUT_S, clock)
    concurrency = env_int("MEMRIPAL_ROUTE_CONCURRENCY", 1) or DEFAULT_ROUTE_CONCURRENCY
    # K_SERVICE is set only on Cloud Run, whose front end appends the real peer to X-Forwarded-For.
    return rate, lockout, concurrency, bool(os.environ.get("K_SERVICE"))


def client_key(addr: str) -> str:
    """IPv6 clients keyed by their /64 (one subscriber's allocation), IPv4 per address, unparsable as-is."""
    try:
        ip = ipaddress.ip_address(addr)
    except ValueError:
        return addr
    if ip.version == 6 and ip.ipv4_mapped:
        return str(ip.ipv4_mapped)
    if ip.version == 6:
        return str(ipaddress.ip_network(f"{ip}/64", strict=False))
    return str(ip)


def client_ip(scope, trust_xff: bool) -> str:
    """Key of the rightmost X-Forwarded-For entry on Cloud Run (leftmost are client-supplied), else peer."""
    if trust_xff:
        values = Headers(scope=scope).getlist("x-forwarded-for")
        entries = [e.strip() for v in values for e in v.split(",") if e.strip()]
        if entries:
            # Assumes direct *.run.app ingress; behind an external HTTPS LB the rightmost entry is the LB.
            return client_key(entries[-1])
    client = scope.get("client")
    return client_key(client[0]) if client else ""


def retry_error(code: str, retry: int) -> JSONResponse:
    return JSONResponse({"error": code}, status_code=429, headers={"Retry-After": str(retry)})


class ApiGuard:
    """Rate-limits every POST API route per client IP, then holds a bounded slot on the paid routes."""

    def __init__(self, app, limiter: SlidingWindow, concurrency: int, trust_xff: bool) -> None:
        self.app = app
        self.limiter = limiter
        self.trust_xff = trust_xff
        self.slots = {route: threading.BoundedSemaphore(concurrency) for route in CAPPED_ROUTES}

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http" or scope["method"] != "POST" or scope["path"] not in LIMITED_ROUTES:
            return await self.app(scope, receive, send)
        ip = client_ip(scope, self.trust_xff)
        if (retry := self.limiter.retry_after(ip)) is not None:
            return await retry_error("rate_limited", retry)(scope, receive, send)
        self.limiter.record(ip)
        slot = self.slots.get(scope["path"])
        if slot is None:
            return await self.app(scope, receive, send)
        # Non-blocking polls keep the event loop free and bind the semaphore to no particular loop.
        waited = 0.0
        while not slot.acquire(blocking=False):
            if waited >= SLOT_WAIT_S:
                return await JSONResponse({"error": "busy"}, status_code=503)(scope, receive, send)
            await asyncio.sleep(SLOT_POLL_S)
            waited += SLOT_POLL_S
        try:
            await self.app(scope, receive, send)
        finally:
            slot.release()
