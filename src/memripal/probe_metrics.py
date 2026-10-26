"""SAM box parsing, memory-locus selection and image-edit drift metrics (MEM-007)."""

import math
import re
from dataclasses import dataclass, replace
from io import BytesIO

from PIL import Image, ImageChops, ImageStat

_TOKEN = re.compile(r"<\|box;([^|]*)\|>")
_INT_KEYS = ("x1", "y1", "x2", "y2", "w", "h")


@dataclass(frozen=True)
class Box:
    x1: int
    y1: int
    x2: int
    y2: int
    w: int
    h: int
    confidence: float | None = None

    @property
    def area(self) -> int:
        return (self.x2 - self.x1) * (self.y2 - self.y1)


def _parse_token(body: str) -> Box | None:
    fields = dict(pair.split("=", 1) for pair in body.split(";") if "=" in pair)
    try:
        ints = {k: int(fields[k]) for k in _INT_KEYS}
        conf = float(fields["c"]) if "c" in fields else None
    except (KeyError, ValueError):
        return None
    return Box(**ints, confidence=conf)


def parse_boxes(text: str) -> list[Box]:
    return [b for b in (_parse_token(m.group(1)) for m in _TOKEN.finditer(text)) if b is not None]


def largest(boxes: list[Box]) -> Box | None:
    return max(boxes, key=lambda b: b.area, default=None)


def iou(a: Box, b: Box) -> float:
    iw = max(0, min(a.x2, b.x2) - max(a.x1, b.x1))
    ih = max(0, min(a.y2, b.y2) - max(a.y1, b.y1))
    inter = iw * ih
    union = a.area + b.area - inter
    return inter / union if union > 0 else 0.0


def scaled_to(box: Box, img_w: int, img_h: int) -> Box:
    """Map a box from SAM's reported frame (box.w x box.h) onto an img_w x img_h image."""
    if box.w <= 0 or box.h <= 0 or (box.w, box.h) == (img_w, img_h):
        return box
    sx, sy = img_w / box.w, img_h / box.h
    return replace(
        box,
        x1=round(box.x1 * sx),
        y1=round(box.y1 * sy),
        x2=round(box.x2 * sx),
        y2=round(box.y2 * sy),
        w=img_w,
        h=img_h,
    )


def keep_loci(per_phrase: dict[str, list[Box]], img_w: int, img_h: int) -> list[tuple[str, Box]]:
    total = img_w * img_h
    candidates = []
    for phrase, boxes in per_phrase.items():
        best = largest(boxes)
        # Integer comparison keeps the 0.5% / 40% bounds exactly inclusive.
        if best is not None and best.area * 1000 >= 5 * total and best.area * 10 <= 4 * total:
            candidates.append((phrase, best))
    candidates.sort(key=lambda pb: pb[1].area, reverse=True)
    kept: list[tuple[str, Box]] = []
    for phrase, b in candidates:
        if all(iou(b, k) <= 0.5 for _, k in kept):
            kept.append((phrase, b))
    return kept


def _decode_rgb(data: bytes) -> Image.Image:
    return Image.open(BytesIO(data)).convert("RGB")


def drift_outside_bbox(orig: bytes, edited: bytes, box: Box, scale: float = 1.5) -> float:
    a = _decode_rgb(orig)
    b = _decode_rgb(edited)
    if b.size != a.size:
        b = b.resize(a.size, Image.Resampling.BILINEAR)
    sb = scaled_to(box, a.width, a.height)
    cx, cy = (sb.x1 + sb.x2) / 2, (sb.y1 + sb.y2) / 2
    hw, hh = (sb.x2 - sb.x1) * scale / 2, (sb.y2 - sb.y1) * scale / 2
    left, top = max(0, math.floor(cx - hw)), max(0, math.floor(cy - hh))
    right, bottom = min(a.width, math.ceil(cx + hw)), min(a.height, math.ceil(cy + hh))
    mask = Image.new("L", a.size, 255)
    if right > left and bottom > top:
        mask.paste(0, (left, top, right, bottom))
    stat = ImageStat.Stat(ImageChops.difference(a, b), mask)
    count = stat.count[0]
    return sum(stat.sum) / (3 * count) if count else 0.0


def _crop_span(lo: int, hi: int, size: int, min_side: int) -> tuple[int, int]:
    pad = 0.25 * (hi - lo)
    a, b = lo - pad, hi + pad
    target = min(max(b - a, min(min_side, size)), size)
    a = (a + b) / 2 - target / 2
    a = min(max(a, 0.0), size - target)
    return round(a), round(a + target)


def crop_for_edit(jpeg: bytes, box: Box, min_side: int = 512) -> bytes:
    img = _decode_rgb(jpeg)
    sb = scaled_to(box, img.width, img.height)
    left, right = _crop_span(sb.x1, sb.x2, img.width, min_side)
    top, bottom = _crop_span(sb.y1, sb.y2, img.height, min_side)
    buf = BytesIO()
    img.crop((left, top, right, bottom)).save(buf, format="JPEG", quality=95)
    return buf.getvalue()
