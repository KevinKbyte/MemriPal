"""POST /station router (MEM-049); create_app wires it in a later slice (criterion 14)."""

import base64
import threading
from collections.abc import Callable

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from memripal.backend import BackendCallFailed, FixtureMissing, ModelBackend

# Shared with app.py so /station's upload types, size check and budget refusal match /loci's.
from memripal.bodies import UPLOAD_TYPES, BudgetExhausted, _call_failed, _error, _length_error, _read_capped
from memripal.imaging import MAX_UPLOAD_BYTES, ImageRejected, process_upload
from memripal.station import BadReply, BlurFailed, parse_used_names, run_station

USED_NAMES_HEADER = "X-Memripal-Used-Names"
DEFAULT_MAX_CONCURRENT = 2


def make_station_router(
    backend: ModelBackend,
    passcode_error: Callable[[Request], JSONResponse | None],
    *,
    max_concurrent: int = DEFAULT_MAX_CONCURRENT,
) -> APIRouter:
    if max_concurrent < 1:
        raise ValueError("max_concurrent must be >= 1")
    slots = threading.BoundedSemaphore(max_concurrent)
    router = APIRouter()

    @router.post("/station")
    async def post_station(request: Request) -> JSONResponse:
        # Before the body: an unauthenticated caller gets no validation hints and spends no calls.
        if (refusal := passcode_error(request)) is not None:
            return refusal
        media_type = request.headers.get("content-type", "").split(";")[0].strip().lower()
        if media_type not in UPLOAD_TYPES:
            return _error(415, "unsupported_media_type")
        if (length_error := _length_error(request, MAX_UPLOAD_BYTES)) is not None:
            return length_error
        used_names = parse_used_names(request.headers.get(USED_NAMES_HEADER))
        if used_names is None:
            return _error(400, "bad_used_names")
        if not slots.acquire(blocking=False):
            return _error(429, "busy")
        try:
            data = await _read_capped(request)
            if data is None:
                return _error(413, "too_large")
            # Pillow decode and the model calls block, so keep them off the event loop.
            processed = await run_in_threadpool(process_upload, data)
            result = await run_in_threadpool(run_station, backend, processed, used_names)
        except ImageRejected as exc:
            return _error(exc.status, str(exc))
        except BlurFailed:
            return _error(502, "blur_failed")
        except BadReply:
            return _error(502, "bad_reply")
        except FixtureMissing:
            return _error(404, "fixture_missing")
        except BackendCallFailed as exc:
            return _call_failed(exc)
        except BudgetExhausted:
            return _error(429, "budget_exhausted")
        finally:
            slots.release()
        box = result.box
        return JSONResponse(
            {
                "image": "data:image/jpeg;base64," + base64.b64encode(result.photo.jpeg).decode("ascii"),
                "width": result.photo.width,
                "height": result.photo.height,
                "photo_sha": result.photo.sha,
                "name": result.name,
                "profile": result.profile,
                "box": None if box is None else {"x1": box.x1, "y1": box.y1, "x2": box.x2, "y2": box.y2},
            }
        )

    return router
