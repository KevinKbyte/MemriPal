"""Memory-locus selection: SAM boxes -> labelled, numbered loci (MEM-013). Pure, no model calls."""

import math
from dataclasses import dataclass

from memripal.probe_metrics import Box, _is_valid, iou, largest, scaled_to


@dataclass(frozen=True)
class Locus:
    n: int
    label: str
    phrase: str
    box: Box
    outline: list[tuple[int, int]]


def sanitize_box(box: Box, img_w: int, img_h: int) -> Box | None:
    # scaled_to passes a non-positive frame through unscaled, so reject it here first.
    if box.w <= 0 or box.h <= 0:
        return None
    s = scaled_to(box, img_w, img_h)
    if 0 <= s.x1 < s.x2 <= img_w and 0 <= s.y1 < s.y2 <= img_h:
        return s
    return None


def _area_ok(b: Box, total: int) -> bool:
    # Same integer math as keep_loci: 0.5% / 40% bounds exactly inclusive.
    return _is_valid(b) and b.area * 1000 >= 5 * total and b.area * 10 <= 4 * total


def _centroid(b: Box) -> tuple[float, float]:
    return (b.x1 + b.x2) / 2, (b.y1 + b.y2) / 2


def _by_area(pbs: list[tuple[str, Box]]) -> list[tuple[str, Box]]:
    return sorted(pbs, key=lambda pb: pb[1].area, reverse=True)


def select_loci(
    per_phrase: dict[str, list[Box]],
    img_w: int,
    img_h: int,
    *,
    min_loci: int = 10,
    max_loci: int = 12,
    spacing: float = 0.05,
) -> list[tuple[str, Box]]:
    total = img_w * img_h
    min_dist = spacing * math.hypot(img_w, img_h)
    primaries: list[tuple[str, Box]] = []
    spares: list[tuple[str, Box]] = []
    for phrase, boxes in per_phrase.items():
        ok = [b for b in boxes if _area_ok(b, total)]
        best = largest(ok)
        if best is None:
            continue
        primaries.append((phrase, best))
        spares.extend((phrase, b) for b in ok if b is not best)

    kept: list[tuple[str, Box]] = []

    def fits(b: Box) -> bool:
        cx, cy = _centroid(b)
        for _, k in kept:
            kx, ky = _centroid(k)
            if iou(b, k) > 0.5 or math.hypot(cx - kx, cy - ky) < min_dist:
                return False
        return True

    # Descending area makes "keep the larger" fall out of first-come greedy acceptance.
    for phrase, b in _by_area(primaries):
        if fits(b):
            kept.append((phrase, b))
    # D14: same-type spares fill in only while short of min_loci.
    for phrase, b in _by_area(spares):
        if len(kept) >= min_loci:
            break
        if fits(b):
            kept.append((phrase, b))
    return _by_area(kept)[:max_loci]


def disambiguate(selected: list[tuple[str, Box]]) -> list[tuple[str, str, Box]]:
    nouns = [(phrase.lower().split() or [""])[-1] for phrase, _ in selected]
    labels = list(nouns)
    for noun in set(nouns):
        same = [i for i, n in enumerate(nouns) if n == noun]
        idx = sorted(same, key=lambda i: _centroid(selected[i][1])[0])
        k = len(idx)
        if k < 2:
            continue
        if k == 2:
            names = [f"left {noun}", f"right {noun}"]
        elif k == 3:
            names = [f"left {noun}", f"middle {noun}", f"right {noun}"]
        else:
            names = [f"{noun} {j}" for j in range(1, k + 1)]
        for i, name in zip(idx, names, strict=True):
            labels[i] = name
    return [(label, phrase, b) for label, (phrase, b) in zip(labels, selected, strict=True)]


def route_order(items: list[tuple[str, str, Box]], img_h: int) -> list[Locus]:
    rows: list[list[tuple[str, str, Box]]] = []
    first_y = 0.0
    for it in sorted(items, key=lambda t: _centroid(t[2])[1]):
        cy = _centroid(it[2])[1]
        if not rows or cy - first_y > img_h / 10:
            rows.append([])
            first_y = cy
        rows[-1].append(it)
    ordered = [it for row in rows for it in sorted(row, key=lambda t: _centroid(t[2])[0])]
    return [
        Locus(
            n=n,
            label=label,
            phrase=phrase,
            box=b,
            outline=[(b.x1, b.y1), (b.x2, b.y1), (b.x2, b.y2), (b.x1, b.y2)],
        )
        for n, (label, phrase, b) in enumerate(ordered, start=1)
    ]
