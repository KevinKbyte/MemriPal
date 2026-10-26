# Covers: MEM-007
# Requirement: SAM box tokens are parsed (any key order, optional confidence, malformed
# tokens and inverted, zero-area, negative-coordinate or non-positive-frame boxes
# skipped); usable memory loci are chosen as each phrase's largest box within
# 0.5%-40% of the image area, de-duplicated by IoU > 0.5 and ordered largest first; edit
# drift is the mean RGB difference outside a 1.5x-scaled box (edited image resized to
# the original); and edit crops pad the box by 25%, grow toward a minimum side and stay
# inside the image.
from io import BytesIO

import pytest
from PIL import Image

from memripal.probe_metrics import (
    Box,
    crop_for_edit,
    drift_outside_bbox,
    iou,
    keep_loci,
    largest,
    parse_boxes,
)


def box(x1, y1, x2, y2, w=1000, h=1000, c=None) -> Box:
    return Box(x1=x1, y1=y1, x2=x2, y2=y2, w=w, h=h, confidence=c)


def png(size, color, patch=None) -> bytes:
    """Uniform RGB PNG, optionally with a rectangle (x1, y1, x2, y2, color) painted on it."""
    img = Image.new("RGB", size, color)
    if patch is not None:
        x1, y1, x2, y2, pcolor = patch
        img.paste(pcolor, (x1, y1, x2, y2))
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def jpeg(size, color=(120, 130, 140)) -> bytes:
    buf = BytesIO()
    Image.new("RGB", size, color).save(buf, format="JPEG")
    return buf.getvalue()


class TestParseBoxes:
    # Covers: MEM-007

    def test_single_token(self):
        boxes = parse_boxes("<|box;x1=353;y1=382;x2=453;y2=427;w=537;h=561|>")
        assert boxes == [Box(x1=353, y1=382, x2=453, y2=427, w=537, h=561, confidence=None)]

    def test_any_key_order_with_confidence(self):
        boxes = parse_boxes("<|box;c=0.91;h=561;w=537;y2=427;x2=453;y1=382;x1=353|>")
        assert len(boxes) == 1
        b = boxes[0]
        assert (b.x1, b.y1, b.x2, b.y2, b.w, b.h) == (353, 382, 453, 427, 537, 561)
        assert b.confidence == pytest.approx(0.91)

    def test_multiple_tokens_amid_text(self):
        text = (
            "found: <|box;x1=1;y1=2;x2=11;y2=12;w=100;h=100|> and "
            "<|box;x1=20;y1=20;x2=60;y2=50;w=100;h=100;c=0.5|> done"
        )
        boxes = parse_boxes(text)
        assert [(b.x1, b.confidence) for b in boxes] == [(1, None), (20, pytest.approx(0.5))]

    def test_token_missing_required_key_is_skipped(self):
        text = "<|box;x1=1;y1=2;x2=11;y2=12;w=100|><|box;x1=5;y1=5;x2=9;y2=9;w=10;h=10|>"
        boxes = parse_boxes(text)
        assert len(boxes) == 1
        assert boxes[0].x1 == 5

    @pytest.mark.parametrize("text", ["", "no boxes here"])
    def test_empty_or_tokenless(self, text):
        assert parse_boxes(text) == []

    def test_area(self):
        assert box(10, 20, 40, 70).area == 30 * 50

    @pytest.mark.parametrize(
        "fields",
        [
            "x1=60;y1=10;x2=40;y2=50;w=100;h=100",  # x2 < x1
            "x1=10;y1=50;x2=40;y2=20;w=100;h=100",  # y2 < y1
            "x1=60;y1=50;x2=40;y2=20;w=100;h=100",  # both inverted (positive "area")
            "x1=40;y1=10;x2=40;y2=50;w=100;h=100",  # zero width
            "x1=10;y1=50;x2=40;y2=50;w=100;h=100",  # zero height
            "x1=10;y1=10;x2=40;y2=50;w=0;h=100",  # w = 0
            "x1=10;y1=10;x2=40;y2=50;w=100;h=-5",  # h < 0
            "x1=-10;y1=10;x2=40;y2=50;w=100;h=100",  # negative x1
            "x1=10;y1=-1;x2=40;y2=50;w=100;h=100",  # negative y1
        ],
        ids=["x_inverted", "y_inverted", "both_inverted", "zero_width", "zero_height", "w_zero",
             "h_negative", "x1_negative", "y1_negative"],
    )
    def test_inverted_degenerate_or_negative_box_is_rejected(self, fields):
        text = f"<|box;{fields}|><|box;x1=5;y1=5;x2=9;y2=9;w=10;h=10|>"
        assert parse_boxes(text) == [box(5, 5, 9, 9, w=10, h=10)]

    def test_box_touching_frame_origin_is_valid(self):
        assert parse_boxes("<|box;x1=0;y1=0;x2=1;y2=1;w=1;h=1|>") == [box(0, 0, 1, 1, w=1, h=1)]


class TestLargestAndIou:
    # Covers: MEM-007

    def test_largest_empty(self):
        assert largest([]) is None

    def test_largest_picks_max_area(self):
        small, big = box(0, 0, 10, 10), box(0, 0, 50, 50)
        assert largest([small, big, box(0, 0, 20, 20)]) == big

    def test_iou_identical(self):
        assert iou(box(0, 0, 10, 10), box(0, 0, 10, 10)) == pytest.approx(1.0)

    def test_iou_disjoint_and_touching(self):
        assert iou(box(0, 0, 10, 10), box(20, 20, 30, 30)) == pytest.approx(0.0)
        assert iou(box(0, 0, 10, 10), box(10, 0, 20, 10)) == pytest.approx(0.0)

    def test_iou_half_overlap(self):
        assert iou(box(0, 0, 10, 10), box(5, 0, 15, 10)) == pytest.approx(50 / 150)

    def test_iou_symmetric(self):
        a, b = box(0, 0, 30, 20), box(10, 5, 50, 40)
        assert iou(a, b) == pytest.approx(iou(b, a))


class TestKeepLoci:
    # Covers: MEM-007  (1000x1000 image: 0.5% = 5000 px, 40% = 400000 px)

    def test_area_boundaries_inclusive(self):
        per = {
            "min_ok": [box(0, 0, 50, 100)],  # 5000 exactly
            "too_small": [box(900, 890, 949, 992)],  # 49*102 = 4998
            "max_ok": [box(0, 200, 800, 700)],  # 400000 exactly
            "too_big": [box(0, 0, 401, 1000)],  # 401000
        }
        kept = keep_loci(per, 1000, 1000)
        assert [p for p, _ in kept] == ["max_ok", "min_ok"]

    def test_takes_largest_box_per_phrase(self):
        small, big = box(0, 0, 100, 100), box(500, 500, 700, 700)
        kept = keep_loci({"lamp": [small, big]}, 1000, 1000)
        assert kept == [("lamp", big)]

    def test_largest_out_of_range_drops_phrase(self):
        kept = keep_loci({"wall": [box(0, 0, 100, 100), box(0, 0, 1000, 900)]}, 1000, 1000)
        assert kept == []

    def test_dedupe_iou_above_half_keeps_larger(self):
        big = box(0, 0, 200, 200)  # 40000
        dup = box(0, 0, 200, 180)  # IoU 0.9
        kept = keep_loci({"shelf": [dup], "bookcase": [big]}, 1000, 1000)
        assert kept == [("bookcase", big)]

    def test_iou_exactly_half_is_kept(self):
        a = box(0, 0, 100, 100)  # 10000
        b = box(0, 0, 100, 50)  # 5000, IoU 0.5
        kept = keep_loci({"a": [a], "b": [b]}, 1000, 1000)
        assert [p for p, _ in kept] == ["a", "b"]

    def test_descending_area_order(self):
        per = {
            "s": [box(0, 0, 100, 60)],
            "l": [box(300, 300, 600, 600)],
            "m": [box(700, 0, 900, 200)],
        }
        kept = keep_loci(per, 1000, 1000)
        assert [p for p, _ in kept] == ["l", "m", "s"]

    def test_inverted_box_never_kept_even_with_in_range_area(self):
        inverted = box(600, 600, 400, 400)  # (x2-x1)*(y2-y1) = 40000 = 4%, but not a real box
        assert keep_loci({"ghost": [inverted]}, 1000, 1000) == []

    def test_empty_inputs(self):
        assert keep_loci({}, 1000, 1000) == []
        assert keep_loci({"nothing": []}, 1000, 1000) == []

    def test_uses_given_image_dims(self):
        # 6000 px is 0.6% of 1000x1000 (kept) but 0.15% of 2000x2000 (dropped)
        per = {"cup": [box(0, 0, 60, 100)]}
        assert len(keep_loci(per, 1000, 1000)) == 1
        assert keep_loci(per, 2000, 2000) == []


class TestDrift:
    # Covers: MEM-007  (100x100 image, box 40..60 -> 1.5x scaled box 35..65)

    def test_identical_images_zero(self):
        img = png((100, 100), (100, 100, 100))
        assert drift_outside_bbox(img, img, box(40, 40, 60, 60, 100, 100)) == pytest.approx(0.0)

    def test_identical_jpeg_zero(self):
        img = jpeg((100, 100))
        assert drift_outside_bbox(img, img, box(40, 40, 60, 60, 100, 100)) == pytest.approx(0.0)

    def test_change_only_inside_scaled_box_zero(self):
        orig = png((100, 100), (100, 100, 100))
        edited = png((100, 100), (100, 100, 100), patch=(37, 37, 63, 63, (255, 0, 0)))
        assert drift_outside_bbox(orig, edited, box(40, 40, 60, 60, 100, 100)) == pytest.approx(0.0)

    def test_change_outside_positive(self):
        orig = png((100, 100), (100, 100, 100))
        edited = png((100, 100), (100, 100, 100), patch=(0, 0, 10, 10, (255, 255, 255)))
        assert drift_outside_bbox(orig, edited, box(40, 40, 60, 60, 100, 100)) > 0.0

    def test_uniform_shift_mean_over_rgb_channels(self):
        orig = png((100, 100), (100, 100, 100))
        edited = png((100, 100), (130, 100, 100))  # red +30 only -> mean over 3 channels = 10
        assert drift_outside_bbox(orig, edited, box(40, 40, 60, 60, 100, 100)) == pytest.approx(10.0)

    def test_differently_sized_edit_is_resized(self):
        orig = png((100, 100), (100, 100, 100))
        same_color_bigger = png((200, 160), (100, 100, 100))
        shifted_bigger = png((200, 160), (110, 110, 110))
        b = box(40, 40, 60, 60, 100, 100)
        assert drift_outside_bbox(orig, same_color_bigger, b) == pytest.approx(0.0)
        assert drift_outside_bbox(orig, shifted_bigger, b) == pytest.approx(10.0)

    def test_all_pixels_inside_zero(self):
        orig = png((100, 100), (0, 0, 0))
        edited = png((100, 100), (255, 255, 255))
        assert drift_outside_bbox(orig, edited, box(0, 0, 100, 100, 100, 100)) == pytest.approx(0.0)

    def test_scaled_box_clamped_at_edge(self):
        # box 0..20 scaled 1.5x about centre 10 -> -5..25, clamped to 0..25
        orig = png((100, 100), (100, 100, 100))
        edited = png((100, 100), (100, 100, 100), patch=(0, 0, 23, 23, (0, 255, 0)))
        assert drift_outside_bbox(orig, edited, box(0, 0, 20, 20, 100, 100)) == pytest.approx(0.0)

    def test_scale_parameter_respected(self):
        # patch pixels 31..33 lie outside the 1.5x box (35..65) but inside the 2.0x box (30..70)
        orig = png((100, 100), (100, 100, 100))
        edited = png((100, 100), (100, 100, 100), patch=(31, 31, 34, 34, (255, 255, 255)))
        b = box(40, 40, 60, 60, 100, 100)
        assert drift_outside_bbox(orig, edited, b) > 0.0
        assert drift_outside_bbox(orig, edited, b, scale=2.0) == pytest.approx(0.0)


def _decode(data: bytes) -> Image.Image:
    img = Image.open(BytesIO(data))
    img.load()
    return img


class TestCropForEdit:
    # Covers: MEM-007

    def test_output_is_jpeg(self):
        out = crop_for_edit(jpeg((2000, 1500)), box(900, 700, 1000, 800, 2000, 1500))
        assert out[:2] == b"\xff\xd8"
        assert _decode(out).format == "JPEG"

    def test_small_box_grown_to_min_side(self):
        out = _decode(crop_for_edit(jpeg((2000, 1500)), box(900, 700, 1000, 800, 2000, 1500)))
        w, h = out.size
        assert w >= 512 and h >= 512
        assert w < 2000 and h < 1500

    def test_custom_min_side(self):
        out = _decode(crop_for_edit(jpeg((2000, 1500)), box(900, 700, 1000, 800, 2000, 1500), min_side=300))
        w, h = out.size
        assert 300 <= w < 512 and 300 <= h < 512

    def test_large_box_gets_25_percent_margin(self):
        # 800x600 box + 25% each side -> 1200x900, fits inside 2000x1500
        out = _decode(crop_for_edit(jpeg((2000, 1500)), box(500, 400, 1300, 1000, 2000, 1500)))
        w, h = out.size
        assert abs(w - 1200) <= 2 and abs(h - 900) <= 2

    def test_clamped_to_small_image(self):
        out = _decode(crop_for_edit(jpeg((300, 200)), box(0, 0, 100, 100, 300, 200)))
        assert out.size == (300, 200)

    def test_corner_box_stays_within_bounds(self):
        out = _decode(crop_for_edit(jpeg((2000, 1500)), box(0, 0, 100, 100, 2000, 1500)))
        w, h = out.size
        assert 512 <= w <= 2000 and 512 <= h <= 1500

    def test_crop_contains_box_content(self):
        img = Image.new("RGB", (2000, 1500), (0, 0, 255))
        img.paste((255, 0, 0), (900, 700, 1000, 800))
        buf = BytesIO()
        img.save(buf, format="JPEG", quality=95)
        out = _decode(crop_for_edit(buf.getvalue(), box(900, 700, 1000, 800, 2000, 1500))).convert("RGB")
        w, h = out.size
        r, g, b = out.getpixel((w // 2, h // 2))
        assert r > 200 and b < 60
