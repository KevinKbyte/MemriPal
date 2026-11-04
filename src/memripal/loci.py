"""Memory loci: SAM boxes -> labelled, numbered loci (MEM-013) and the find_loci pipeline (MEM-014)."""

import math
import time
import unicodedata
from collections.abc import Callable
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from dataclasses import dataclass
from typing import Any

from memripal.backend import PROMPT_ARGS, BackendCallFailed, ModelBackend, ModelRequest
from memripal.byok import ByokKeyRejected
from memripal.imaging import Processed
from memripal.meta_spend_guard import MetaSpendCapReached
from memripal.probe import PHRASE_SCHEMA
from memripal.probe_metrics import Box, _is_valid, iou, largest, parse_boxes, scaled_to

SPARK_MODEL = "muse-spark-1.3"
SAM_MODEL = "sam-3.1"
SPARK_GEN_PARAMS = {"max_completion_tokens": 1024}
MIN_LOCI = 10
MAX_PHRASES = 30
MAX_PHRASE_LEN = 40
MAX_SAM_TEXT_BYTES = 256 * 1024
REASK_MIN_REMAINING_S = 15.0


@dataclass(frozen=True)
class Locus:
    n: int
    label: str
    phrase: str
    box: Box
    outline: list[tuple[int, int]]


def locus_json(lc: Locus) -> dict:
    return {
        "n": lc.n,
        "label": lc.label,
        "phrase": lc.phrase,
        "box": {"x1": lc.box.x1, "y1": lc.box.y1, "x2": lc.box.x2, "y2": lc.box.y2},
        "outline": [[x, y] for x, y in lc.outline],
    }


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


Pt = tuple[int, int]


def _c2(b: Box) -> Pt:
    """Doubled centroid: integer coordinates keep every orientation test exact."""
    return (b.x1 + b.x2, b.y1 + b.y2)


def _orient(a: Pt, b: Pt, c: Pt) -> int:
    v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    return (v > 0) - (v < 0)


def _on_box(a: Pt, b: Pt, p: Pt) -> bool:
    return min(a[0], b[0]) <= p[0] <= max(a[0], b[0]) and min(a[1], b[1]) <= p[1] <= max(a[1], b[1])


def _legs_meet(p1: Pt, p2: Pt, q1: Pt, q2: Pt) -> bool:
    """Closed legs share a point, ignoring a coincident shared endpoint (two loci at one centroid)."""
    shared = {p1, p2} & {q1, q2}
    if shared:
        s = next(iter(shared))
        po, qo = (p2 if p1 == s else p1), (q2 if q1 == s else q1)
        if po == s or qo == s:
            return False
        d1, d2 = (po[0] - s[0], po[1] - s[1]), (qo[0] - s[0], qo[1] - s[1])
        return d1[0] * d2[1] == d1[1] * d2[0] and d1[0] * d2[0] + d1[1] * d2[1] > 0
    o1, o2 = _orient(p1, p2, q1), _orient(p1, p2, q2)
    o3, o4 = _orient(q1, q2, p1), _orient(q1, q2, p2)
    if o1 * o2 < 0 and o3 * o4 < 0:
        return True
    return (
        (o1 == 0 and _on_box(p1, p2, q1))
        or (o2 == 0 and _on_box(p1, p2, q2))
        or (o3 == 0 and _on_box(q1, q2, p1))
        or (o4 == 0 and _on_box(q1, q2, p2))
    )


def _meetings(c: list[Pt]) -> list[tuple[int, int]]:
    n = len(c) - 1
    return [(i, j) for i in range(n) for j in range(i + 2, n) if _legs_meet(c[i], c[i + 1], c[j], c[j + 1])]


def _uncross(ordered: list[tuple[str, str, Box]]) -> list[tuple[str, str, Box]]:
    """2-opt from the reading order: reverse the stretch between two meeting legs when that shortens the walk.

    Each reversal strictly shortens the walk, so the loop ends. A proper crossing always shortens; a
    degenerate collinear or touching meeting that no reversal shortens falls back to a walk sorted top to
    bottom, then left to right, which is y-monotone and so never meets itself.
    """
    path = list(ordered)
    while True:
        c = [_c2(it[2]) for it in path]
        hits = _meetings(c)
        if not hits:
            return path
        for i, j in hits:
            a, b, d, e = c[i], c[i + 1], c[j], c[j + 1]
            if math.dist(a, d) + math.dist(b, e) < math.dist(a, b) + math.dist(d, e) - 1e-9:
                path[i + 1 : j + 1] = path[i + 1 : j + 1][::-1]
                break
        else:
            return sorted(ordered, key=lambda it: (_c2(it[2])[1], _c2(it[2])[0]))


def route_order(items: list[tuple[str, str, Box]], img_h: int) -> list[Locus]:
    rows: list[list[tuple[str, str, Box]]] = []
    first_y = 0.0
    for it in sorted(items, key=lambda t: _centroid(t[2])[1]):
        cy = _centroid(it[2])[1]
        if not rows or cy - first_y > img_h / 10:
            rows.append([])
            first_y = cy
        rows[-1].append(it)
    ordered = _uncross([it for row in rows for it in sorted(row, key=lambda t: _centroid(t[2])[0])])
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


@dataclass(frozen=True)
class LociResult:
    loci: list[Locus]
    phrases: list[str]
    reask_used: bool


def _clean_phrases(raw: Any, seen: set[str], room: int) -> list[str]:
    """Model output is untrusted: keep short, printable, case-fold-unique strings, at most `room`."""
    items = raw.get("phrases") if isinstance(raw, dict) else None
    out: list[str] = []
    for item in items if isinstance(items, list) else []:
        if len(out) >= room:
            break
        if not isinstance(item, str):
            continue
        phrase = item.strip()
        folded = phrase.casefold()
        if not phrase or len(phrase) > MAX_PHRASE_LEN or folded in seen:
            continue
        if any(unicodedata.category(c) == "Cc" for c in phrase):
            continue
        seen.add(folded)
        out.append(phrase)
    return out


def _spark_request(processed: Processed, subject: str, template_id: str, gen_params: dict) -> ModelRequest:
    return ModelRequest(
        method="spark_json",
        image_jpeg=processed.jpeg,
        subject=subject,
        attempt=0,
        model=SPARK_MODEL,
        prompt_template_id=template_id,
        gen_params=gen_params,
        schema=PHRASE_SCHEMA,
    )


def _segment(backend: ModelBackend, processed: Processed, phrase: str) -> list[Box]:
    req = ModelRequest(
        method="segment",
        image_jpeg=processed.jpeg,
        subject=phrase,
        attempt=0,
        model=SAM_MODEL,
        prompt_template_id="sam-phrase",
        gen_params={},
        schema=None,
    )
    try:
        text = backend.call(req)
    except (MetaSpendCapReached, ByokKeyRejected):
        # Every later SAM call would be refused too: surface the cap or the refused BYOK key (MEM-122),
        # never a silently empty result.
        raise
    except BackendCallFailed:
        return []
    if not isinstance(text, str) or len(text.encode("utf-8")) > MAX_SAM_TEXT_BYTES:
        return []
    boxes = (sanitize_box(b, processed.width, processed.height) for b in parse_boxes(text))
    return [b for b in boxes if b is not None]


def find_loci(
    backend: ModelBackend,
    processed: Processed,
    *,
    workers: int = 6,
    deadline_s: float = 90.0,
    on_progress: Callable[..., None] | None = None,
    clock: Callable[[], float] = time.monotonic,
) -> LociResult:
    """Spark phrases -> SAM per phrase -> select, one re-ask if short (MEM-014).

    Only the first Spark call's BackendCallFailed propagates; failed SAM calls and a failed re-ask degrade.
    """
    deadline = clock() + deadline_s
    seen: set[str] = set()
    phrases: list[str] = []
    per_phrase: dict[str, list[Box]] = {}

    first = backend.call(_spark_request(processed, "phrases", "phrase", dict(SPARK_GEN_PARAMS)))
    # Not a `with` block: its exit would wait on SAM calls still running past the deadline.
    pool = ThreadPoolExecutor(max_workers=workers)
    try:

        def segment_all(new: list[str]) -> None:
            phrases.extend(new)
            futures: dict[Future, str] = {pool.submit(_segment, backend, processed, p): p for p in new}
            done_boxes: dict[str, list[Box]] = {}
            pending = set(futures)
            while pending and clock() < deadline:
                done, pending = wait(
                    pending, timeout=max(0.0, deadline - clock()), return_when=FIRST_COMPLETED
                )
                for fut in done:
                    done_boxes[futures[fut]] = fut.result()
                    if on_progress is not None:
                        on_progress(futures[fut])
            # Phrase order, not completion order, so selection (and replay) is deterministic.
            for p in new:
                per_phrase[p] = done_boxes.get(p, [])

        def select() -> list[tuple[str, Box]]:
            return select_loci(per_phrase, processed.width, processed.height)

        segment_all(_clean_phrases(first, seen, MAX_PHRASES))
        selected = select()
        reask_used = False
        if len(selected) < MIN_LOCI and deadline - clock() >= REASK_MIN_REMAINING_S:
            reask_used = True
            gen_params = {**SPARK_GEN_PARAMS, PROMPT_ARGS: {"exclude": [p for p, _ in selected]}}
            try:
                more = backend.call(_spark_request(processed, "phrases-reask", "phrase-reask", gen_params))
            except BackendCallFailed:
                # The re-ask only tops up: a failure keeps the first round's loci, like a failed SAM call.
                more = None
            new = _clean_phrases(more, seen, MAX_PHRASES - len(phrases))
            if new:
                segment_all(new)
                selected = select()
    finally:
        pool.shutdown(wait=False, cancel_futures=True)
    return LociResult(
        loci=route_order(disambiguate(selected), processed.height),
        phrases=phrases,
        reask_used=reask_used,
    )
