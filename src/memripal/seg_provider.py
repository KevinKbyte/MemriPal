"""Segmentation provider toggle and the off-by-default Modal SAM adapter (MEM-016, ADR 0006)."""

import json
import os
import sys

import httpx

from memripal.backend import BackendCallFailed
from memripal.meta_client import to_data_url

SEG_PROVIDERS = ("meta", "modal")
_BOX_KEYS = ("x1", "y1", "x2", "y2")


def select_seg_provider() -> str:
    provider = os.environ.get("MEMRIPAL_SEG_PROVIDER", "meta")
    if provider not in SEG_PROVIDERS:
        raise ValueError(f"MEMRIPAL_SEG_PROVIDER must be one of {SEG_PROVIDERS}, got {provider!r}")
    return provider


def _number(value: object) -> float | None:
    # bool is an int subclass; a JSON true must not become coordinate 1.
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    # json.loads accepts NaN/Infinity and unbounded ints, which round()/float() would raise on;
    # the comparison is False for NaN/inf and exact (no overflow) for huge ints.
    if not abs(value) <= sys.float_info.max:
        return None
    return float(value)


def _box_token(box: object, w: int, h: int) -> str:
    if not isinstance(box, dict):
        return ""
    coords = [_number(box.get(k)) for k in _BOX_KEYS]
    score = _number(box.get("score"))
    if score is None or any(c is None for c in coords):
        return ""
    x1, y1, x2, y2 = (round(c) for c in coords)
    return f"<|box;x1={x1};y1={y1};x2={x2};y2={y2};w={w};h={h};c={score}|>"


def boxes_json_to_tokens(body: bytes) -> str:
    """SAM-style token text from `{"boxes": [{x1,y1,x2,y2,score}], "w", "h"}`; malformed parts are dropped."""
    try:
        data = json.loads(body)
    except ValueError:
        return ""
    if not isinstance(data, dict) or not isinstance(data.get("boxes"), list):
        return ""
    w, h = _number(data.get("w")), _number(data.get("h"))
    if w is None or h is None:
        return ""
    return "".join(_box_token(box, round(w), round(h)) for box in data["boxes"])


class ModalSegClient:
    """Client for our own Modal-hosted SAM endpoint; output feeds probe_metrics.parse_boxes unchanged."""

    def __init__(
        self,
        base_url: str,
        token: str,
        *,
        timeout: float = 60.0,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._url = base_url.rstrip("/")
        self._token = token
        self._http = httpx.Client(transport=transport, timeout=timeout)

    # Explicit so the token can never surface through a default object repr.
    def __repr__(self) -> str:
        return "ModalSegClient()"

    __str__ = __repr__

    def segment(self, image_jpeg: bytes, phrase: str) -> str:
        try:
            response = self._http.post(
                self._url,
                headers={"Authorization": "Bearer " + self._token},
                json={"image": to_data_url(image_jpeg), "phrase": phrase},
            )
            response.raise_for_status()
        except httpx.HTTPError:
            # Raised, not "", so a failure is never cached as zero boxes (ADR 0018); from None
            # because httpx error text can carry the URL and the response body.
            raise BackendCallFailed("segment call failed") from None
        return boxes_json_to_tokens(response.content)


def modal_seg_client_from_env() -> ModalSegClient:
    # Environment only, like META_API_KEY: never read .env files. Names per the S2.5 plan.
    url = os.environ.get("MEMRIPAL_MODAL_SEG_URL", "")
    token = os.environ.get("MODAL_SEG_TOKEN", "")
    if not url or not token:
        raise ValueError("modal seg provider requires MEMRIPAL_MODAL_SEG_URL and MODAL_SEG_TOKEN")
    return ModalSegClient(url, token)
