"""Support for the design-shooter tests (design_gate.py real_shoot, screenshot_design.py run).

install_fake_playwright: a stand-in playwright.sync_api that models media emulation like a real browser.
Every page it loads is treated as a fixture whose body is REDUCE_BG under
`@media (prefers-reduced-motion: reduce)` and MOTION_BG otherwise; a page's emulated media is set by
`browser.new_page(reduced_motion=...)`, `browser.new_context(reduced_motion=...).new_page()` or
`page.emulate_media(reduced_motion=...)`, and its screenshot writes the colour that media selects
(read back with body_bg).
With install_fake_playwright(monkeypatch, gpu_raster_noise=True) it also models GPU raster: a browser
launched without '--disable-gpu' in `args` writes screenshots carrying a never-repeating raster token,
so the same page shot twice differs in bytes; launched with it, screenshot bytes depend only on the
page and its media.

REDUCED_MOTION_HTML / require_chrome / centre_rgb: the same fixture for the opt-in real-browser tests.
"""

import itertools
import sys
import types
import urllib.parse
import urllib.request
from pathlib import Path

import pytest

PNG = b"\x89PNG\r\n\x1a\n"
REDUCE_BG = "#00ff00"
MOTION_BG = "#ff0000"
# Playwright's accepted values; anything else raises, as in a real browser.
REDUCED_MOTION_VALUES = ("reduce", "no-preference", "null", None)
# GPU raster noise: each GPU-on screenshot takes the next token, so no two are byte-identical.
_RASTER_TOKENS = itertools.count()

REDUCED_MOTION_HTML = (
    '<!doctype html>\n<html><head><meta charset="utf-8"><style>\n'
    "html, body { margin: 0; height: 100%; }\n"
    f"body {{ background: {MOTION_BG}; }}\n"
    f"@media (prefers-reduced-motion: reduce) {{ body {{ background: {REDUCE_BG}; }} }}\n"
    "</style></head><body></body></html>\n"
)


def _reduced_motion(value):
    if value not in REDUCED_MOTION_VALUES:
        raise ValueError(f"reduced_motion: expected 'reduce', 'no-preference' or 'null', got {value!r}")
    return value


class FakePage:
    def __init__(self, visited: list[str], reduced_motion=None, gpu_raster=False):
        self.visited = visited
        self.width = 0
        self.gpu_raster = gpu_raster
        self.reduced_motion = _reduced_motion(reduced_motion)

    def on(self, event, handler):
        pass

    def emulate_media(self, **kwargs):
        if "reduced_motion" in kwargs:
            self.reduced_motion = _reduced_motion(kwargs["reduced_motion"])

    def set_viewport_size(self, size):
        self.width = size["width"]

    def goto(self, url, **kwargs):
        # A real browser raises on a missing file:// page (net::ERR_FILE_NOT_FOUND).
        path = Path(urllib.request.url2pathname(urllib.parse.urlparse(url).path))
        if not path.is_file():
            raise RuntimeError(f"net::ERR_FILE_NOT_FOUND at {url}")
        self.visited.append(url)

    def wait_for_timeout(self, ms):
        pass

    def screenshot(self, path, **kwargs):
        bg = REDUCE_BG if self.reduced_motion == "reduce" else MOTION_BG
        noise = f"\ngpu-raster={next(_RASTER_TOKENS)}" if self.gpu_raster else ""
        Path(path).write_bytes(PNG + f"{Path(path).name}{noise}\nbody-bg={bg}".encode("ascii"))

    def add_script_tag(self, **kwargs):
        pass

    def evaluate(self, expression, arg=None):
        return self.width if "scrollWidth" in expression else []


class _FakeContext:
    def __init__(self, visited: list[str], reduced_motion, gpu_raster=False):
        self.visited = visited
        self.reduced_motion = _reduced_motion(reduced_motion)
        self.gpu_raster = gpu_raster

    def new_page(self):
        return FakePage(self.visited, self.reduced_motion, self.gpu_raster)

    def close(self):
        pass


class _FakeBrowser:
    def __init__(self, visited: list[str], gpu_raster=False):
        self.visited = visited
        self.gpu_raster = gpu_raster

    def new_page(self, **kwargs):
        return FakePage(self.visited, kwargs.get("reduced_motion"), self.gpu_raster)

    def new_context(self, **kwargs):
        return _FakeContext(self.visited, kwargs.get("reduced_motion"), self.gpu_raster)

    def close(self):
        pass


class FakePlaywright:
    def __init__(self, visited: list[str], gpu_raster_noise=False):
        self.visited = visited
        self.gpu_raster_noise = gpu_raster_noise
        self.chromium = types.SimpleNamespace(launch=self._launch)

    def _launch(self, **kwargs):
        gpu_on = "--disable-gpu" not in (kwargs.get("args") or [])
        return _FakeBrowser(self.visited, gpu_raster=self.gpu_raster_noise and gpu_on)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def install_fake_playwright(monkeypatch, gpu_raster_noise=False) -> list[str]:
    """Patch playwright.sync_api into sys.modules; returns the list of page URLs actually loaded.

    gpu_raster_noise: browsers launched without '--disable-gpu' in `args` shoot non-repeating bytes.
    """
    visited: list[str] = []
    sync_api = types.ModuleType("playwright.sync_api")
    sync_api.sync_playwright = lambda: FakePlaywright(visited, gpu_raster_noise)
    monkeypatch.setitem(sys.modules, "playwright", types.ModuleType("playwright"))
    monkeypatch.setitem(sys.modules, "playwright.sync_api", sync_api)
    return visited


def body_bg(png_path: Path) -> str:
    """The body colour a fake screenshot captured ("" if the file is not a fake screenshot)."""
    _, sep, bg = png_path.read_bytes().partition(b"\nbody-bg=")
    return bg.decode("ascii") if sep else ""


def require_chrome():
    """Skip unless playwright is importable and its Chrome channel launches."""
    pytest.importorskip("playwright")
    sync_api = pytest.importorskip("playwright.sync_api")
    try:
        with sync_api.sync_playwright() as p:
            p.chromium.launch(channel="chrome").close()
    except Exception as exc:  # any launch failure means no usable Chrome here
        pytest.skip(f"Chrome channel launch failed: {type(exc).__name__}: {exc}")


def centre_rgb(png_path: Path) -> tuple[int, int, int]:
    from PIL import Image

    with Image.open(png_path) as img:
        rgb = img.convert("RGB")
        return rgb.getpixel((rgb.width // 2, rgb.height // 2))


def is_reduce_bg(rgb: tuple[int, int, int]) -> bool:
    """REDUCE_BG (pure green) vs MOTION_BG (pure red), tolerant of colour-profile rounding."""
    r, g, b = rgb
    return g >= 200 and r <= 55 and b <= 55
