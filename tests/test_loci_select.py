# Covers: MEM-013
# Requirement: SAM boxes become at most 12 memory loci. Hostile or degenerate boxes
# (outside the image, negative, zero-width, absurd ints, empty frame) are dropped after
# scaling to the image; every box must cover 0.5%-40% of the image (inclusive); each
# phrase's largest box is its primary, near-duplicates (IoU > 0.5) and crowded loci
# (centroids closer than 5% of the image diagonal) collapse to the larger; same-type
# spare boxes fill in only while fewer than 10 loci remain; the result is capped at 12
# by area. Repeated head nouns get positional labels (left/right, left/middle/right,
# "<noun> 1..k") while the SAM phrase stays unchanged, and loci are numbered in a
# row-aware reading order (rows top to bottom, a new row past 10% of image height,
# left to right within a row) with a rectangle outline.
import dataclasses

import pytest

# Package-level import keeps ruff's first-party grouping stable before and after loci.py exists.
from memripal import loci
from memripal.probe_metrics import Box

Locus = loci.Locus
disambiguate = loci.disambiguate
route_order = loci.route_order
sanitize_box = loci.sanitize_box
select_loci = loci.select_loci

W = H = 1000  # diagonal ~1414.2 px; 5% spacing ~70.7 px; 0.5% area = 5000; 40% = 400000


def box(x1, y1, x2, y2, w=W, h=H) -> Box:
    return Box(x1=x1, y1=y1, x2=x2, y2=y2, w=w, h=h)


def grid_box(i: int, side: int) -> Box:
    """Square box in cell i of a 5x5 grid of 200 px cells: never overlapping, centroids >= 200 px apart."""
    col, row = i % 5, i // 5
    x1, y1 = 20 + 200 * col, 20 + 200 * row
    return box(x1, y1, x1 + side, y1 + side)


def spread(n: int, start_cell: int = 0, prefix: str = "thing") -> dict[str, list[Box]]:
    """n well-separated phrases with distinct areas (larger side for higher index)."""
    return {f"{prefix} {i}": [grid_box(start_cell + i, 72 + 4 * i)] for i in range(n)}


def phrases_of(selected) -> list[str]:
    return [p for p, _ in selected]


def centroid(b: Box) -> tuple[float, float]:
    return (b.x1 + b.x2) / 2, (b.y1 + b.y2) / 2


class TestSanitizeBox:
    # Covers: MEM-013

    def test_in_frame_box_is_kept(self):
        b = box(10, 20, 110, 220)
        out = sanitize_box(b, W, H)
        assert out is not None
        assert (out.x1, out.y1, out.x2, out.y2) == (10, 20, 110, 220)

    def test_box_is_scaled_from_sam_frame_to_image(self):
        out = sanitize_box(box(100, 50, 200, 150, w=500, h=500), W, H)
        assert out is not None
        assert (out.x1, out.y1, out.x2, out.y2) == (200, 100, 400, 300)
        assert (out.w, out.h) == (W, H)

    def test_box_touching_image_edges_is_kept(self):
        out = sanitize_box(box(0, 0, W, H), W, H)
        assert out is not None
        assert (out.x1, out.y1, out.x2, out.y2) == (0, 0, W, H)

    @pytest.mark.parametrize(
        "hostile",
        [
            pytest.param(box(10, 10, W + 1, 100), id="x2-past-width"),
            pytest.param(box(10, 10, 100, H + 1), id="y2-past-height"),
            pytest.param(box(-1, 10, 100, 100), id="negative-x1"),
            pytest.param(box(10, -5, 100, 100), id="negative-y1"),
            pytest.param(box(50, 10, 50, 100), id="x1-equals-x2"),
            pytest.param(box(10, 60, 100, 60), id="y1-equals-y2"),
            pytest.param(box(100, 10, 50, 100), id="inverted-x"),
            pytest.param(box(10, 10, 10**18, 10**18), id="absurd-ints"),
            pytest.param(box(10, 10, 100, 100, w=0, h=H), id="zero-width-frame"),
            pytest.param(box(10, 10, 100, 100, w=W, h=0), id="zero-height-frame"),
            pytest.param(box(10, 10, 100, 100, w=-500, h=H), id="negative-frame"),
            pytest.param(box(100, 100, 600, 200, w=500, h=500), id="out-of-frame-after-scaling"),
        ],
    )
    def test_hostile_or_degenerate_box_is_dropped(self, hostile):
        assert sanitize_box(hostile, W, H) is None


class TestSelectLociFilters:
    # Covers: MEM-013

    def test_empty_input_selects_nothing(self):
        assert select_loci({}, W, H) == []

    def test_phrase_with_no_boxes_is_skipped(self):
        assert select_loci({"lamp": []}, W, H) == []

    @pytest.mark.parametrize(
        ("b", "kept"),
        [
            pytest.param(box(0, 0, 50, 100), True, id="exactly-0.5pct"),
            pytest.param(box(0, 0, 51, 98), False, id="just-below-0.5pct"),
            pytest.param(box(0, 0, 400, 1000), True, id="exactly-40pct"),
            pytest.param(box(0, 0, 401, 998), False, id="just-above-40pct"),
        ],
    )
    def test_area_bounds_are_inclusive(self, b, kept):
        assert (select_loci({"lamp": [b]}, W, H) == [("lamp", b)]) is kept

    def test_primary_is_the_largest_box_of_a_phrase(self):
        small, big = grid_box(0, 80), grid_box(12, 120)
        assert select_loci({"lamp": [small, big]}, W, H, min_loci=1) == [("lamp", big)]

    def test_iou_over_half_keeps_the_larger(self):
        big, overlap = box(0, 0, 600, 600), box(0, 0, 600, 400)
        assert select_loci({"rug": [big], "floor": [overlap]}, W, H) == [("rug", big)]

    def test_centroids_3pct_of_diagonal_apart_collapse_to_larger(self):
        # No overlap (IoU 0); centroids 43 px apart = 3.0% of the diagonal.
        a, b = box(100, 100, 140, 250), box(142, 100, 184, 250)
        assert select_loci({"cup": [a], "mug": [b]}, W, H) == [("mug", b)]

    def test_centroids_6pct_of_diagonal_apart_both_kept(self):
        # Centroids 86 px apart = 6.1% of the diagonal.
        a, b = box(100, 100, 140, 250), box(185, 100, 227, 250)
        assert sorted(phrases_of(select_loci({"cup": [a], "mug": [b]}, W, H))) == ["cup", "mug"]


class TestSelectLociDuplicatesAndCap:
    # Covers: MEM-013

    def test_three_books_fill_in_when_short_of_ten(self):
        per_phrase = spread(7)
        books = [grid_box(10, 100), grid_box(12, 110), grid_box(14, 120)]
        per_phrase["book"] = books
        selected = select_loci(per_phrase, W, H)
        assert len(selected) == 10
        assert {b for p, b in selected if p == "book"} == set(books)
        assert phrases_of(selected).count("book") == 3

    def test_spares_unused_when_primaries_reach_min(self):
        per_phrase = spread(9)
        per_phrase["book"] = [grid_box(15, 100), grid_box(17, 110), grid_box(19, 120)]
        selected = select_loci(per_phrase, W, H)
        assert len(selected) == 10
        assert phrases_of(selected).count("book") == 1

    def test_twelve_other_phrases_leave_at_most_one_book(self):
        per_phrase = spread(12)
        per_phrase["book"] = [grid_box(20, 100), grid_box(22, 110), grid_box(24, 120)]
        selected = select_loci(per_phrase, W, H)
        assert len(selected) <= 12
        assert phrases_of(selected).count("book") <= 1

    def test_spare_duplicating_a_kept_locus_is_not_added(self):
        per_phrase = spread(7)
        primary = grid_box(10, 120)
        near_copy = box(primary.x1 + 2, primary.y1 + 2, primary.x2, primary.y2)
        far = grid_box(14, 100)
        per_phrase["book"] = [primary, near_copy, far]
        selected = select_loci(per_phrase, W, H)
        assert [b for p, b in selected if p == "book"].count(near_copy) == 0
        assert {b for p, b in selected if p == "book"} == {primary, far}

    def test_spare_failing_area_filter_is_not_added(self):
        per_phrase = spread(7)
        per_phrase["book"] = [grid_box(10, 120), grid_box(14, 40)]  # 1600 px < 0.5%
        selected = select_loci(per_phrase, W, H)
        assert phrases_of(selected).count("book") == 1

    def test_more_than_twelve_survivors_capped_to_twelve_largest(self):
        per_phrase = spread(15)
        selected = select_loci(per_phrase, W, H)
        assert len(selected) == 12
        assert sorted(phrases_of(selected)) == sorted(f"thing {i}" for i in range(3, 15))

    def test_hostile_boxes_dropped_and_survivors_capped(self):
        per_phrase = spread(14)
        hostile = [
            box(10, 10, W + 1, 100),
            box(-1, 10, 100, 100),
            box(50, 10, 50, 100),
            box(1, 1, 90, 90, w=0),
        ]
        raw = {**per_phrase, **{f"bad {i}": [b] for i, b in enumerate(hostile)}}
        clean = {p: [s for b in bs if (s := sanitize_box(b, W, H)) is not None] for p, bs in raw.items()}
        selected = select_loci(clean, W, H)
        assert len(selected) == 12
        assert not any(p.startswith("bad") for p in phrases_of(selected))

    def test_max_loci_is_configurable(self):
        assert len(select_loci(spread(6), W, H, max_loci=3)) == 3


class TestDisambiguate:
    # Covers: MEM-013

    def test_empty(self):
        assert disambiguate([]) == []

    def test_unique_label_is_lowercased_last_word(self):
        b = grid_box(0, 100)
        assert disambiguate([("Brass Reading Lamp", b)]) == [("lamp", "Brass Reading Lamp", b)]

    def test_two_of_a_noun_get_left_and_right(self):
        right, left = grid_box(4, 100), grid_box(0, 100)
        out = disambiguate([("red book", right), ("blue book", left)])
        assert set(out) == {("right book", "red book", right), ("left book", "blue book", left)}

    def test_three_of_a_noun_get_left_middle_right(self):
        a, b, c = grid_box(2, 100), grid_box(4, 100), grid_box(0, 100)
        out = disambiguate([("book", a), ("book", b), ("book", c), ("lamp", grid_box(12, 100))])
        labels = {bx: label for label, _, bx in out}
        assert (labels[c], labels[a], labels[b]) == ("left book", "middle book", "right book")
        assert all(phrase == "book" for label, phrase, _ in out if label.endswith("book"))
        assert labels[grid_box(12, 100)] == "lamp"

    def test_more_than_three_numbered_left_to_right(self):
        boxes = [grid_box(3, 100), grid_box(0, 100), grid_box(4, 100), grid_box(1, 100)]
        out = disambiguate([("book", b) for b in boxes])
        by_x = sorted(out, key=lambda t: centroid(t[2])[0])
        assert [label for label, _, _ in by_x] == ["book 1", "book 2", "book 3", "book 4"]
        assert {phrase for _, phrase, _ in out} == {"book"}


def item(label: str, cx: int, cy: int) -> tuple[str, str, Box]:
    return (label, label, box(cx - 30, cy - 30, cx + 30, cy + 30))


class TestRouteOrder:
    # Covers: MEM-013

    def test_empty(self):
        assert route_order([], H) == []

    def test_two_jittered_rows_read_top_left_to_bottom_right(self):
        items = [
            item("f", 800, 650),
            item("b", 500, 230),
            item("d", 100, 600),
            item("c", 800, 200),
            item("e", 500, 580),
            item("a", 100, 260),
        ]
        loci = route_order(items, H)
        assert [(lo.n, lo.label) for lo in loci] == [
            (1, "a"),
            (2, "b"),
            (3, "c"),
            (4, "d"),
            (5, "e"),
            (6, "f"),
        ]

    def test_row_break_is_strictly_more_than_ten_percent(self):
        # 300 is exactly 10% below the row's first centroid (200): same row; 302 starts a new row.
        items = [item("first-y", 800, 200), item("same-row", 100, 300), item("next-row", 50, 302)]
        assert [lo.label for lo in route_order(items, H)] == ["same-row", "first-y", "next-row"]

    def test_locus_carries_phrase_box_and_rectangle_outline(self):
        b = box(10, 20, 110, 220)
        (lo,) = route_order([("left book", "book", b)], H)
        assert isinstance(lo, Locus)
        assert (lo.n, lo.label, lo.phrase, lo.box) == (1, "left book", "book", b)
        assert len(lo.outline) == 4
        assert set(lo.outline) == {(10, 20), (110, 20), (110, 220), (10, 220)}

    def test_locus_is_immutable(self):
        (lo,) = route_order([("lamp", "lamp", box(10, 20, 110, 220))], H)
        with pytest.raises(dataclasses.FrozenInstanceError):
            lo.n = 2
