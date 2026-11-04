"""Screenshot the UI before/after "Load demo", plus an imported backup's route view (MEM-017, MEM-073)
and the Kendall demo route on the real map at 375 px, light and dark (MEM-077), plus Pal's first-run
tour at step 1 and step 5 on a fresh unseeded page (tour-step1.png, tour-step5.png; MEM-095). Every
other page seeds the tour-done key so the modal tour never blocks its clicks.

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
# Must equal static/demo_route.js DEMO_ROUTE.name: its card's Open button is named "Open <name>" (MEM-077).
DEMO_ROUTE_NAME = "Kendall walk"
DEMO_VIEWPORT = {"width": 375, "height": 812}
# The real map's first idle: the selector the S5 e2e waits on (static/real_map.js drops the pending class).
MAP_IDLE = ".real-map:not(.real-map-pending)"
MAP_IDLE_TIMEOUT_MS = 30000
# MEM-095: static/tour.js opens a modal tour while TOUR_KEY is unset; marking it done keeps clicks reachable.
TOUR_SEED_JS = '(() => { try { localStorage.setItem("memripal.tour.done", "1"); } catch (e) {} })();'
TOUR_STEP5_CLICKS = 4

Error = tuple[str, str]  # (message text, source URL)


def significant_errors(errors: list[Error]) -> list[Error]:
    # The app ships no favicon, so the browser's automatic /favicon.ico 404 is expected noise.
    return [e for e in errors if urlsplit(e[1]).path != "/favicon.ico"]


def show_tab(page, name: str) -> None:
    # MEM-072: controls live in tab panels; tabbar.js swallows the click, so the URL never changes.
    page.click(f'a.tab[href="#{name}"]')


def set_drawer(page, want_open: bool) -> None:
    # The handle is a <summary>, so a click toggles: click only when the drawer is not already as wanted.
    if bool(page.evaluate("() => document.getElementById('drawer').open")) != want_open:
        page.click(".drawer-handle")


def run(url: str, outdir: str) -> list[Error]:
    # Lazy import: the module (and significant_errors) must load where playwright is absent.
    from playwright.sync_api import sync_playwright

    out = Path(outdir)
    out.mkdir(parents=True, exist_ok=True)
    errors: list[Error] = []

    def on_console(msg) -> None:
        if msg.type == "error":
            errors.append((msg.text, msg.location.get("url", "")))

    def watch(page) -> None:
        page.on("pageerror", lambda exc: errors.append((str(exc), page.url)))
        page.on("console", on_console)

    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome")
        try:
            page = browser.new_page(viewport={"width": 1100, "height": 900})
            page.add_init_script(TOUR_SEED_JS)
            watch(page)
            page.goto(url)
            page.screenshot(path=str(out / "initial.png"), full_page=True)
            # MEM-025: the demo only shows place chips when the place toggle is on.
            show_tab(page, "settings")
            assert page.query_selector("#place-toggle"), "missing #place-toggle"
            page.check("#place-toggle")
            show_tab(page, "routes")
            set_drawer(page, True)
            page.click("#load-demo")
            page.wait_for_timeout(DEMO_WAIT_MS)
            page.screenshot(path=str(out / "load_demo.png"), full_page=True)
            items = page.eval_on_selector_all("#loci li", "els => els.map(e => e.textContent)")
            show_tab(page, "settings")
            page.set_input_files("#backup-import", str(ROUTE_BACKUP))
            page.wait_for_timeout(IMPORT_WAIT_MS)
            # Import refreshes only the history list; the route view renders its home on page load.
            page.reload()
            page.wait_for_timeout(IMPORT_WAIT_MS)
            set_drawer(page, True)
            page.screenshot(path=str(out / "route_view.png"), full_page=True)
            # MEM-077: the Kendall demo route on the real map, phone width, one fresh page per scheme.
            for scheme in ("light", "dark"):
                demo = browser.new_page(viewport=DEMO_VIEWPORT, color_scheme=scheme)
                demo.add_init_script(TOUR_SEED_JS)
                watch(demo)
                demo.goto(url)
                set_drawer(demo, True)
                demo.click("#load-demo")
                # Load demo opens the route itself (MEM-072); go back so its card's Open button is reachable.
                demo.get_by_role("button", name="Back to routes").click()
                set_drawer(demo, True)
                demo.get_by_role("button", name=f"Open {DEMO_ROUTE_NAME}").click()
                # At phone width the open drawer covers the map the shot is for.
                set_drawer(demo, False)
                demo.wait_for_selector(MAP_IDLE, timeout=MAP_IDLE_TIMEOUT_MS)
                demo.screenshot(path=str(out / f"demo_route_{scheme}.png"), full_page=True)
                demo.close()
            # MEM-095: never seeded, so the tour opens on load; step 1, then four Next clicks reach step 5.
            tour = browser.new_page(viewport=DEMO_VIEWPORT)
            watch(tour)
            tour.goto(url)
            tour.screenshot(path=str(out / "tour-step1.png"))
            for _ in range(TOUR_STEP5_CLICKS):
                tour.click("#tour-next")
            tour.wait_for_selector('#tour-n:text-is("5")')
            tour.screenshot(path=str(out / "tour-step5.png"))
            tour.close()
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
