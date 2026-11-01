"""Screenshot the route design preview per screen, width and theme; fail on page/console errors (MEM-067).

Usage: uv run --no-project --with playwright python scripts/screenshot_design.py <base_url> <outdir>
         [--screen S]... [--width NAME=WxH]... [--theme light|dark]...
<base_url> is preview.html's URL; screens 5-9 load from its sibling preview-2.html.
Defaults: screens 1 2 3 4 5,6 7 8 9; widths phone=375x812 wide=1000x800; themes light dark.
A flag replaces its default list. Prints "ERR <msg>" per error then "shots=<n> errors=<m>".
Exits 0 when clean, 1 on any page/console error, 2 on bad usage.
"""

import argparse
import sys
from collections.abc import Callable
from pathlib import Path
from typing import NamedTuple

DEFAULT_SCREENS = ["1", "2", "3", "4", "5,6", "7", "8", "9"]
DEFAULT_WIDTHS = [("phone", (375, 812)), ("wide", (1000, 800))]
DEFAULT_THEMES = ["light", "dark"]
SETTLE_MS = 300
PAGE_2 = "preview-2.html"
PAGE_2_SCREENS = {"5", "6", "7", "8", "9"}

Width = tuple[str, tuple[int, int]]  # (name, (width, height))


class Shot(NamedTuple):
    url: str
    filename: str
    viewport: tuple[int, int]


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


def page_url(base_url: str, screen: str) -> str:
    """preview.html (base_url) renders S1-S4; its sibling preview-2.html renders S5-S9."""
    if screen.split(",")[0] in PAGE_2_SCREENS:
        return base_url.rsplit("/", 1)[0] + "/" + PAGE_2
    return base_url


def shot_plan(base_url: str, screens: list[str], widths: list[Width], themes: list[str]) -> list[Shot]:
    # A screen like "5,6" is passed through as the preview's s= value; commas become dashes in the filename.
    return [
        Shot(
            page_url(base_url, s) + "?s=" + s + ("&theme=dark" if t == "dark" else ""),
            f"s{s.replace(',', '-')}_{name}_{t}.png",
            viewport,
        )
        for name, viewport in widths
        for t in themes
        for s in screens
    ]


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
            # Shots must settle (ADR 0036 amendment 2026-11-01): lm-float animates infinitely otherwise.
            page = browser.new_page(reduced_motion="reduce")
            page.on("pageerror", lambda exc: errors.append(str(exc)))
            page.on("console", on_console)
            viewport = None
            for shot in plan:
                if shot.viewport != viewport:
                    viewport = shot.viewport
                    page.set_viewport_size({"width": viewport[0], "height": viewport[1]})
                page.goto(shot.url, wait_until="networkidle")
                page.wait_for_timeout(SETTLE_MS)
                page.screenshot(path=str(out / shot.filename), full_page=True)
        finally:
            browser.close()
    # A run that reports success must have produced every planned PNG.
    errors += [f"missing {shot.filename}" for shot in plan if not (out / shot.filename).is_file()]
    return errors


def main(argv: list[str], run: Callable[[list[Shot], str], list[str]] = run) -> int:
    parser = argparse.ArgumentParser(prog="screenshot_design.py")
    parser.add_argument("base_url")
    parser.add_argument("outdir")
    parser.add_argument("--screen", action="append")
    parser.add_argument("--width", action="append", type=parse_width)
    parser.add_argument("--theme", action="append", choices=DEFAULT_THEMES)
    args = parser.parse_args(argv)  # bad usage: usage line on stderr, SystemExit(2)
    plan = shot_plan(
        args.base_url,
        args.screen or DEFAULT_SCREENS,
        args.width or DEFAULT_WIDTHS,
        args.theme or DEFAULT_THEMES,
    )
    errors = run(plan, args.outdir)
    for e in errors:
        print("ERR", e)
    print(f"shots={len(plan)} errors={len(errors)}")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
