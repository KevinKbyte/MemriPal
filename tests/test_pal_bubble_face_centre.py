# Covers: MEM-138
# Requirement: King Memri's face in the Pal chat bubble renders at its full 84x84px crop with the head
# centred in the 56px disc (50x50 padding box inside the 3px ring), at phone (375px) and desktop (1280px)
# widths; the global `img { max-width: 100%; height: auto; }` rule in static/style.css must not shrink it.

from pathlib import Path

import pytest
from shooter_support import require_chrome

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "static"
SVG = STATIC / "assets" / "pal-still.svg"
# Head centre of pal-still.svg in its 512x512 viewBox.
HEAD_X, HEAD_Y, VIEWBOX = 256.0, 222.5, 512.0
FACE_PX = 84.0
BORDER_PX = 3.0
DISC_PX = 50.0


def _html() -> str:
    css = (
        (STATIC / "style.css").read_text(encoding="utf-8")
        + "\n"
        + (STATIC / "pal_bubble.css").read_text(encoding="utf-8")
    )
    return (
        '<!doctype html><html><head><meta charset="utf-8"><style>\n'
        + css
        + "\n.pal-bubble { left: 100px; top: 100px; }\n</style></head><body>"
        + f'<button class="pal-bubble"><img class="pal-bubble-face" alt="" src="{SVG.as_uri()}"></button>'
        + "</body></html>"
    )


@pytest.mark.parametrize("width", [375, 1280])
def test_pal_bubble_face_is_full_size_and_head_centred_in_disc(width, tmp_path):
    require_chrome()
    from playwright.sync_api import sync_playwright

    page_file = tmp_path / "bubble.html"
    page_file.write_text(_html(), encoding="utf-8")
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome")
        try:
            page = browser.new_page(viewport={"width": width, "height": 800})
            page.goto(page_file.as_uri())
            page.wait_for_function("document.querySelector('.pal-bubble-face').complete")
            face = page.locator(".pal-bubble-face").bounding_box()
            bubble = page.locator(".pal-bubble").bounding_box()
        finally:
            browser.close()

    assert face is not None and bubble is not None
    assert face["width"] == pytest.approx(FACE_PX, abs=0.5), f"face width {face['width']}"
    assert face["height"] == pytest.approx(FACE_PX, abs=0.5), f"face height {face['height']}"

    head_x = face["x"] + face["width"] * HEAD_X / VIEWBOX
    head_y = face["y"] + face["height"] * HEAD_Y / VIEWBOX
    disc_x = bubble["x"] + BORDER_PX + DISC_PX / 2
    disc_y = bubble["y"] + BORDER_PX + DISC_PX / 2
    assert head_x == pytest.approx(disc_x, abs=1.0), f"head x {head_x} vs disc centre {disc_x}"
    assert head_y == pytest.approx(disc_y, abs=1.0), f"head y {head_y} vs disc centre {disc_y}"
