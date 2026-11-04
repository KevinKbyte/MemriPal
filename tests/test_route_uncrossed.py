# Covers: MEM-109
# Requirement: route_order numbers loci (and ADR 0051 sub-loci) along a walk that never crosses its own
# path, so the numbering is easy to remember (Kev, 2026-11-04). For every layout, no two non-adjacent legs
# of the 1 -> 2 -> ... -> n path between box centroids intersect: no proper crossing, no T-touch, no
# collinear overlap. Two loci at the exact same centroid may meet there (unavoidable). Every input locus
# appears exactly once, numbered 1..n, and the same input always yields the same order. Layouts whose
# MEM-013 row-aware reading order is already clean keep that order.
import random

import pytest

from memripal import loci
from memripal.probe_metrics import Box

route_order = loci.route_order
H = 1000


def at(label: str, cx: int, cy: int) -> tuple[str, str, Box]:
    return (label, label, Box(x1=cx - 10, y1=cy - 10, x2=cx + 10, y2=cy + 10, w=H, h=H))


def pts(layout: list[tuple[int, int]]) -> list[tuple[str, str, Box]]:
    return [at(f"p{i}", x, y) for i, (x, y) in enumerate(layout)]


def _c(b: Box) -> tuple[int, int]:
    return (b.x1 + b.x2, b.y1 + b.y2)  # doubled centroid: exact integer geometry


def _orient(a, b, c) -> int:
    v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    return (v > 0) - (v < 0)


def _on(a, b, p) -> bool:
    return min(a[0], b[0]) <= p[0] <= max(a[0], b[0]) and min(a[1], b[1]) <= p[1] <= max(a[1], b[1])


def _meets(p1, p2, q1, q2) -> bool:
    """Closed segments p1p2 and q1q2 share a point other than a coincident shared endpoint."""
    shared = {p1, p2} & {q1, q2}
    if shared:
        s = next(iter(shared))
        po = p2 if p1 == s else p1
        qo = q2 if q1 == s else q1
        if po == s or qo == s:
            return False  # a zero-length leg only touches at s
        d1 = (po[0] - s[0], po[1] - s[1])
        d2 = (qo[0] - s[0], qo[1] - s[1])
        # Beyond s they meet only if they run along the same ray.
        return d1[0] * d2[1] - d1[1] * d2[0] == 0 and d1[0] * d2[0] + d1[1] * d2[1] > 0
    o1, o2 = _orient(p1, p2, q1), _orient(p1, p2, q2)
    o3, o4 = _orient(q1, q2, p1), _orient(q1, q2, p2)
    if o1 * o2 < 0 and o3 * o4 < 0:
        return True
    return (
        (o1 == 0 and _on(p1, p2, q1))
        or (o2 == 0 and _on(p1, p2, q2))
        or (o3 == 0 and _on(q1, q2, p1))
        or (o4 == 0 and _on(q1, q2, p2))
    )


def crossings(ordered) -> list[tuple[int, int]]:
    c = [_c(lo.box) for lo in ordered]
    legs = list(zip(c, c[1:], strict=False))
    return [(i, j) for i in range(len(legs)) for j in range(i + 2, len(legs)) if _meets(*legs[i], *legs[j])]


def zigzag() -> list[tuple[int, int]]:
    # Rows jittered so row-major reading order sends long return legs across other legs.
    return [(100, 100), (900, 190), (500, 150), (150, 300), (850, 260), (480, 380), (120, 520), (880, 430)]


def grid(n: int) -> list[tuple[int, int]]:
    return [(100 + 200 * (i % n), 100 + 200 * (i // n)) for i in range(n * n)]


LAYOUTS = {
    "empty": [],
    "one": [(500, 500)],
    "two": [(100, 100), (900, 900)],
    "three": [(100, 100), (900, 120), (500, 900)],
    "zigzag": zigzag(),
    "grid3": grid(3),
    "grid4": grid(4),
    "row_jitter": [(100, 290), (500, 200), (900, 270), (100, 600), (500, 520), (900, 690)],
    "collinear_h": [(x, 500) for x in (700, 100, 900, 300, 500)],
    "collinear_v": [(500, y) for y in (700, 100, 900, 300, 500)],
    "collinear_diag": [(100 * k, 1000 - 100 * k) for k in (3, 9, 1, 6, 4, 8, 2, 7, 5)],
    "duplicates": [(300, 300), (300, 300), (700, 300), (500, 700), (500, 700), (300, 300)],
    "t_touch": [(100, 100), (900, 100), (500, 100), (500, 600), (200, 650)],
    "crossing_x": [(100, 100), (900, 900), (900, 120), (100, 880)],
}


def reading_order_labels(items) -> list[str]:
    """MEM-013 reference: rows top to bottom (new row past 10% of H), left to right within a row."""
    rows: list[list] = []
    first_y = 0.0
    for it in sorted(items, key=lambda t: (t[2].y1 + t[2].y2) / 2):
        cy = (it[2].y1 + it[2].y2) / 2
        if not rows or cy - first_y > H / 10:
            rows.append([])
            first_y = cy
        rows[-1].append(it)
    return [it[0] for row in rows for it in sorted(row, key=lambda t: (t[2].x1 + t[2].x2) / 2)]


class TestUncrossedRoute:
    # Covers: MEM-109

    @pytest.mark.parametrize("name", sorted(LAYOUTS))
    def test_route_never_crosses_itself(self, name):
        ordered = route_order(pts(LAYOUTS[name]), H)
        assert crossings(ordered) == [], [lo.label for lo in ordered]

    @pytest.mark.parametrize("seed", range(60))
    def test_random_layouts_never_cross(self, seed):
        rng = random.Random(seed)
        n = rng.randint(4, 12)
        layout = [(rng.randint(20, 980), rng.randint(20, 980)) for _ in range(n)]
        ordered = route_order(pts(layout), H)
        assert crossings(ordered) == [], layout

    @pytest.mark.parametrize("seed", range(20))
    def test_random_layouts_with_shared_rows_and_columns_never_cross(self, seed):
        # Coarse lattice coordinates force collinear triples, T-touches and duplicates.
        rng = random.Random(1000 + seed)
        n = rng.randint(4, 12)
        layout = [(100 * rng.randint(1, 5), 100 * rng.randint(1, 5)) for _ in range(n)]
        ordered = route_order(pts(layout), H)
        assert crossings(ordered) == [], layout

    @pytest.mark.parametrize("name", sorted(LAYOUTS))
    def test_every_locus_once_numbered_one_to_n(self, name):
        items = pts(LAYOUTS[name])
        ordered = route_order(items, H)
        assert [lo.n for lo in ordered] == list(range(1, len(items) + 1))
        assert sorted(lo.label for lo in ordered) == sorted(label for label, _, _ in items)

    def test_same_input_same_order(self):
        items = pts(zigzag())
        assert route_order(items, H) == route_order(list(items), H)

    def test_already_clean_layout_keeps_reading_order(self):
        items = pts(LAYOUTS["row_jitter"])
        assert crossings(route_order(items, H)) == []
        assert [lo.label for lo in route_order(items, H)] == reading_order_labels(items)

    def test_checker_flags_a_plain_x(self):
        # Guard the guard: the checker itself must see an X, a T-touch and a collinear overlap.
        def legs(layout):
            return [
                loci.Locus(n=i + 1, label="", phrase="", box=b, outline=[])
                for i, (_, _, b) in enumerate(pts(layout))
            ]

        assert crossings(legs([(100, 100), (900, 900), (900, 100), (100, 900)])) == [(0, 2)]
        assert crossings(legs([(100, 100), (900, 100), (500, 500), (500, 100)])) == [(0, 2)]
        assert crossings(legs([(100, 500), (600, 500), (700, 900), (300, 500), (900, 500)])) != []
