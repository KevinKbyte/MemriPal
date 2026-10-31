"""POST /baseline router (MEM-053): passcode-gated, budget- and concurrency-capped Mapillary baseline."""

import json
import threading
from collections.abc import Callable
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from memripal.baseline import BaselineFailed, NoBaseline
from memripal.place import valid_coords

BODY_CAP = 1024
BODY_KEYS = {"lat", "lon"}
DEFAULT_MAX_CONCURRENT = 4


def _error(status: int, code: str) -> JSONResponse:
    return JSONResponse({"error": code}, status_code=status)


async def _read_capped(request: Request, cap: int) -> bytes | None:
    body = bytearray()
    async for chunk in request.stream():
        body += chunk
        if len(body) > cap:
            return None
    return bytes(body)


def _coords(raw: bytes) -> tuple[float, float] | None:
    """Exactly {lat, lon} as finite in-range numbers, rounded to 4 dp; None otherwise."""
    try:
        body = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(body, dict) or set(body) != BODY_KEYS or not valid_coords(body["lat"], body["lon"]):
        return None
    return round(body["lat"], 4), round(body["lon"], 4)


def baseline_router(
    provider: Any,
    passcode_error: Callable[[Request], JSONResponse | None],
    *,
    call_budget: int | None = None,
    max_concurrent: int = DEFAULT_MAX_CONCURRENT,
) -> APIRouter:
    router = APIRouter()
    # A threading lock, not asyncio: each lookup runs in the threadpool and requests may span event loops.
    lock = threading.Lock()
    state = {"spent": 0, "in_flight": 0}

    @router.post("/baseline")
    async def post_baseline(request: Request) -> JSONResponse:
        # Before the body: an unauthenticated caller gets no validation hints and spends no budget.
        if (denied := passcode_error(request)) is not None:
            return denied
        raw = await _read_capped(request, BODY_CAP)
        if raw is None:
            return _error(413, "too_large")
        coords = _coords(raw)
        if coords is None:
            return _error(400, "bad_coords")
        with lock:
            if call_budget is not None and state["spent"] >= call_budget:
                return _error(429, "budget_exhausted")
            if state["in_flight"] >= max_concurrent:
                return _error(429, "busy")
            state["spent"] += 1
            state["in_flight"] += 1
        try:
            result = await run_in_threadpool(provider.lookup, *coords)
        except NoBaseline:
            return _error(404, "no_baseline")
        except BaselineFailed:
            return _error(502, "upstream")
        finally:
            with lock:
                state["in_flight"] -= 1
        return JSONResponse(result)

    return router
