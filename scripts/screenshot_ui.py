"""Screenshot the UI before/after "Load demo", plus an imported backup's route view (MEM-017, MEM-073).

Fails on page/console errors.

Usage: uv run --no-project --with playwright python scripts/screenshot_ui.py <url> <outdir>
Exits 0 when clean (a /favicon.ico 404 is ignored), 1 on any other error, 2 on bad usage.
"""

import sys
from collections.abc import Callable
from pathlib import Path
from urllib.parse import urlsplit

USAGE = "usage: screenshot_ui.py <url> <outdir>"
DEMO_WAIT_MS = 4000
IMPORT_WAIT_MS = 2000
# A backup-v2 route of 3 named stations; importing it is the only way to create a route (ADR 0040).
ROUTE_BACKUP = Path(__file__).resolve().parents[1] / "fixtures" / "demo" / "route_backup.json"

Error = tuple[str, str]  # (message text, source URL)


def significant_errors(errors: list[Error]) -> list[Error]:
    # The app ships no favicon, so the browser's automatic /favicon.ico 404 is expected noise.
    return [e for e in errors if urlsplit(e[1]).path != "/favicon.ico"]


def run(url: str, outdir: str) -> list[Error]:
    # Lazy import: the module (and significant_errors) must load where playwright is absent.
    from playwright.sync_api import sync_playwright

    out = Path(outdir)
    out.mkdir(parents=True, exist_ok=True)
    errors: list[Error] = []

    def on_console(msg) -> None:
        if msg.type == "error":
            errors.append((msg.text, msg.location.get("url", "")))

    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome")
        try:
            page = browser.new_page(viewport={"width": 1100, "height": 900})
            page.on("pageerror", lambda exc: errors.append((str(exc), page.url)))
            page.on("console", on_console)
            page.goto(url)
            page.screenshot(path=str(out / "initial.png"), full_page=True)
            # MEM-025: the demo only shows place chips when the place toggle is on.
            assert page.query_selector("#place-toggle"), "missing #place-toggle"
            page.check("#place-toggle")
            page.click("#load-demo")
            page.wait_for_timeout(DEMO_WAIT_MS)
            page.screenshot(path=str(out / "load_demo.png"), full_page=True)
            items = page.eval_on_selector_all("#loci li", "els => els.map(e => e.textContent)")
            page.set_input_files("#backup-import", str(ROUTE_BACKUP))
            page.wait_for_timeout(IMPORT_WAIT_MS)
            # Import refreshes only the history list; the route view renders its home on page load.
            page.reload()
            page.wait_for_timeout(IMPORT_WAIT_MS)
            page.screenshot(path=str(out / "route_view.png"), full_page=True)
        finally:
            browser.close()
    print(f"items: {items}")
    print(f"errors: {errors}")
    return errors


def main(argv: list[str], run: Callable[[str, str], list[Error]] = run) -> int:
    if len(argv) != 2:
        print(USAGE, file=sys.stderr)
        return 2
    url, outdir = argv
    return 1 if significant_errors(run(url, outdir)) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
