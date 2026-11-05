"""POST /chat router: the Pal bubble's live chat reply (MEM-142, ADR 0084)."""

import logging
from collections.abc import Callable
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from memripal.bodies import _error, _read_capped
from memripal.pal_chat import FIXTURE_REPLY, pal_chat_from_env, parse_chat_body

# 4000 chars + 40 history turns, room for JSON escaping.
CHAT_BODY_CAP = 512 * 1024

logger = logging.getLogger(__name__)


def make_pal_chat_router(
    model_route: Callable[[Request], tuple[Any, Any, JSONResponse | None]],
    backend: Any,
    pal_chat: Callable[[str, list], str] | None,
) -> APIRouter:
    """`model_route` is create_app's passcode + BYOK resolver, so /chat shares /split's guard.
    `pal_chat` None = fixture mode's canned reply, else the env providers (BYOK visitor's key first)."""
    router = APIRouter()
    default_chat = pal_chat_from_env() if pal_chat is None and backend.mode != "fixture" else None

    @router.post("/chat")
    async def post_chat(request: Request) -> JSONResponse:
        model, client, error = model_route(request)
        if error is not None:
            return error
        media_type = request.headers.get("content-type", "").split(";")[0].strip().lower()
        if media_type != "application/json":
            return _error(415, "unsupported_media_type")
        raw = await _read_capped(request, CHAT_BODY_CAP)
        if raw is None:
            return _error(413, "too_large")
        parsed = parse_chat_body(raw)
        if parsed is None:
            return _error(400, "bad_request")
        message, history = parsed
        if pal_chat is None and default_chat is None:
            return JSONResponse({"text": FIXTURE_REPLY})
        try:
            if pal_chat is not None:
                text = await run_in_threadpool(pal_chat, message, history)
            else:
                # A BYOK session's client is the visitor's own Meta key (MEM-122).
                byok_client = client if model is not backend else None
                text = await run_in_threadpool(default_chat, message, history, byok_client)
        except Exception as exc:  # BackendCallFailed or any provider error: never leak its text
            logger.warning("POST /chat failed: %s", type(exc).__name__)
            return _error(502, "chat_unavailable")
        if not isinstance(text, str) or not text.strip():
            return _error(502, "chat_unavailable")
        return JSONResponse({"text": text.strip()})

    return router
