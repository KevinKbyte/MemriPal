"""Screenshot the route review design preview per width and theme; fail on page/console errors (MEM-081).

Usage: uv run --no-project --with playwright python scripts/screenshot_review_design.py <url> <outdir>
         [--width NAME=WxH]... [--theme light|dark]...
<url> is the preview, e.g. http://localhost:8765/docs/design/review/preview.html.
Defaults: widths 375=375x812 1000=1000x800; themes light dark. A flag replaces its default list.
Prints "ERR <msg>" per error then "shots=<n> errors=<m>". Exits 0 when clean, 1 on any error, 2 on bad usage.
"""

import argparse
import sys
from collections.abc import Callable
from pathlib import Path
from typing import NamedTuple

DEFAULT_WIDTHS = [("375", (375, 812)), ("1000", (1000, 800))]
DEFAULT_THEMES = ["light", "dark"]

Width = tuple[str, tuple[int, int]]  # (name, (width, height))


class Shot(NamedTuple):
    url: str
    filename: str
    viewport: tuple[int, int]
    color_scheme: str


def parse_width(text: str) -> Width:
    name, sep, dims = text.partition("=")
    if not name or not sep:
        raise ValueError(text)
    parts = dims.split("x")
    if len(parts) != 2:
        raise ValueError(text)
    w, h = int(parts[0]), int(parts[1])
    if w <= 0 or h <= 0:
        raise ValueError(text)
    return name, (w, h)


def shot_plan(url: str, widths: list[Width], themes: list[str]) -> list[Shot]:
    # The theme is emulated via prefers-color-scheme, so every shot loads the same url.
    return [Shot(url, f"review-{name}-{t}.png", viewport, t) for name, viewport in widths for t in themes]


def run(plan: list[Shot], outdir: str) -> list[str]:
    # Lazy import: the module (parse_width, shot_plan) must load where playwright is absent.
    from playwright.sync_api import sync_playwright

    out = Path(outdir)
    out.mkdir(parents=True, exist_ok=True)
    errors: list[str] = []

    def on_console(msg) -> None:
        if msg.type == "error":
            errors.append(msg.text)

    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", args=["--disable-gpu"])
        try:
            for shot in plan:
                page = browser.new_page(
                    viewport={"width": shot.viewport[0], "height": shot.viewport[1]},
                    color_scheme=shot.color_scheme,
                    reduced_motion="reduce",
                )
                page.on("pageerror", lambda exc: errors.append(str(exc)))
                page.on("console", on_console)
                page.goto(shot.url, wait_until="networkidle")
                # full_page pins position:sticky elements (the Undo snackbar) over the wrong content, so
                # the viewport itself grows to the page height and a plain viewport shot is taken.
                height = page.evaluate("() => document.documentElement.scrollHeight")
                page.set_viewport_size({"width": shot.viewport[0], "height": int(height)})
                page.screenshot(path=str(out / shot.filename), full_page=False)
                page.close()
        finally:
            browser.close()
    # A run that reports success must have produced every planned PNG.
    errors += [f"missing {shot.filename}" for shot in plan if not (out / shot.filename).is_file()]
    return errors


def main(argv: list[str], run: Callable[[list[Shot], str], list[str]] = run) -> int:
    parser = argparse.ArgumentParser(prog="screenshot_review_design.py")
    parser.add_argument("url")
    parser.add_argument("outdir")
    parser.add_argument("--width", action="append", type=parse_width)
    parser.add_argument("--theme", action="append", choices=DEFAULT_THEMES)
    args = parser.parse_args(argv)  # bad usage: usage line on stderr, SystemExit(2)
    plan = shot_plan(args.url, args.width or DEFAULT_WIDTHS, args.theme or DEFAULT_THEMES)
    errors = run(plan, args.outdir)
    for e in errors:
        print("ERR", e)
    print(f"shots={len(plan)} errors={len(errors)}")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
