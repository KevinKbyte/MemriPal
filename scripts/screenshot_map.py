"""Screenshot the Kendall basemap design preview under the app CSP and check a clean run (MEM-076).

Usage: uv run --no-project --with playwright python scripts/screenshot_map.py <outdir> [--root DIR]
         [--chrome-arg=ARG]...
Serves --root (default: the repo root) with the app CSP + nosniff, shoots docs/design/map/preview.html at
phone=375x812 and wide=1000x800 in light and dark, then clicks the theme button twice and checks the map
re-themes in place. Prints the report JSON, then "ERR <msg>" per problem, then "shots=<n> problems=<m>".
Exits 0 when clean, 1 on any problem, 2 on bad usage.
"""

import argparse
import functools
import http.server
import json
import sys
import threading
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import NamedTuple

REPO_ROOT = Path(__file__).resolve().parents[1]
PAGE = "/docs/design/map/preview.html"
WIDTHS = [("phone", (375, 812)), ("wide", (1000, 800))]
THEMES = ["light", "dark"]
FLIP_THEMES = ["dark", "light"]  # the button starts from light, so two clicks go dark then light
SETTLE_MS = 300
IDLE_TIMEOUT_MS = 30000

CSP = (
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; img-src 'self' data: blob:; "
    "object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
)
# nosniff makes the browser enforce these, so a wrong type fails the run like it would in the app.
MIME = {
    ".js": "text/javascript",
    ".json": "application/json",
    ".pbf": "application/x-protobuf",
    ".pmtiles": "application/octet-stream",
}

CSP_HOOK = """
window.__csp = [];
document.addEventListener('securitypolicyviolation', e => window.__csp.push(
  e.violatedDirective + ' ' + e.blockedURI));
"""
WEBGL_JS = """() => { const c = document.createElement('canvas');
  const g = c.getContext('webgl2') || c.getContext('webgl');
  if (!g) return null; const d = g.getExtension('WEBGL_debug_renderer_info');
  return d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER); }"""
ATTRIB_JS = "() => document.querySelector('.maplibregl-ctrl-attrib-inner')?.textContent || null"
MARKERS_JS = "() => document.querySelectorAll('#overlay .lm').length"
CANVASES_JS = "() => document.querySelectorAll('#map canvas').length"


class Shot(NamedTuple):
    url: str
    filename: str
    viewport: tuple[int, int]


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, **MIME}

    def end_headers(self) -> None:
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def log_message(self, *args) -> None:
        pass


def shot_plan(origin: str) -> list[Shot]:
    return [
        Shot(f"{origin}{PAGE}?theme={t}", f"map_{name}_{t}.png", viewport)
        for name, viewport in WIDTHS
        for t in THEMES
    ]


def problems(report: dict) -> list[str]:
    """One message per defect; a non-empty list (errors, csp, ...) counts as one defect."""
    found: list[str] = []
    for shot in report["shots"]:
        name = Path(shot["file"]).name
        if shot["state"] != "idle":
            found.append(f"{name}: map state {shot['state']!r}, expected 'idle'")
        if shot["errors"]:
            found.append(f"{name}: page errors {shot['errors']}")
        if shot["csp"]:
            found.append(f"{name}: CSP violations {shot['csp']}")
    if report["foreign"]:
        found.append(f"foreign requests {report['foreign']}")
    flip = report["flip"]
    steps = flip["steps"]
    themes = [s["theme"] for s in steps]
    if themes != FLIP_THEMES:
        found.append(f"flip: themes {themes}, expected {FLIP_THEMES}")
    if not all(s["same_doc"] for s in steps):
        found.append("flip: theme button left the document")
    markers = [s["markers"] for s in steps]
    if len(set(markers)) != 1 or markers[0] == 0:
        found.append(f"flip: marker counts {markers}, expected one non-zero count")
    if flip["navigations"]:
        found.append(f"flip: navigations {flip['navigations']}")
    if flip["errors"]:
        found.append(f"flip: page errors {flip['errors']}")
    if flip["csp"]:
        found.append(f"flip: CSP violations {flip['csp']}")
    return found


def render(report: dict) -> tuple[list[str], int]:
    """(output lines, exit code) for a finished report."""
    found = problems(report)
    lines = [json.dumps(report, indent=1)]
    lines += [f"ERR {m}" for m in found]
    lines.append(f"shots={len(report['shots'])} problems={len(found)}")
    return lines, 1 if found else 0


def run(root: str, outdir: str, chrome_args: Sequence[str] = ()) -> dict:
    # Lazy import: the module (shot_plan, problems, main) must load where playwright is absent.
    from playwright.sync_api import sync_playwright

    out = Path(outdir)
    out.mkdir(parents=True, exist_ok=True)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Handler, directory=root))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    origin = f"http://127.0.0.1:{srv.server_address[1]}"
    report: dict = {"args": list(chrome_args), "shots": []}
    errors: list[str] = []
    foreign: list[str] = []

    def on_console(msg) -> None:
        if msg.type in ("error", "warning"):
            errors.append(f"console.{msg.type} {msg.text}")

    def on_request(req) -> None:
        if not req.url.startswith((origin, "blob:", "data:")):
            foreign.append(req.url)

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(channel="chrome", args=list(chrome_args))
            try:
                # Shots must settle (ADR 0036 amendment 2026-11-01): animations run forever otherwise.
                page = browser.new_page(reduced_motion="reduce")
                page.add_init_script(CSP_HOOK)
                page.on("pageerror", lambda exc: errors.append(f"pageerror {exc}"))
                page.on("console", on_console)
                page.on("request", on_request)
                viewport = None
                for shot in shot_plan(origin):
                    if shot.viewport != viewport:
                        viewport = shot.viewport
                        page.set_viewport_size({"width": viewport[0], "height": viewport[1]})
                    errors.clear()
                    page.goto(shot.url, wait_until="load")
                    page.wait_for_selector("html[data-map-state]", timeout=IDLE_TIMEOUT_MS)
                    state = page.get_attribute("html", "data-map-state")
                    page.wait_for_timeout(SETTLE_MS)
                    webgl = page.evaluate(WEBGL_JS)
                    attrib = page.evaluate(ATTRIB_JS)
                    page.screenshot(path=str(out / shot.filename))
                    report["shots"].append(
                        {
                            "file": str(out / shot.filename),
                            "state": state,
                            "webgl": webgl,
                            "attrib": attrib,
                            "errors": list(errors),
                            "csp": page.evaluate("() => window.__csp"),
                        }
                    )
                report["flip"] = _flip_check(page, origin, out, errors)
                report["foreign"] = sorted(set(foreign))
                # browser.close() has hung for minutes on this host: emit the result before teardown so a
                # hung close still leaves it on record (stderr, so a clean stdout from main isn't doubled).
                lines, _ = render(report)
                print("\n".join(lines), file=sys.stderr, flush=True)
            finally:
                browser.close()
    finally:
        srv.shutdown()
    return report


def _flip_check(page, origin: str, out: Path, errors: list[str]) -> dict:
    """Click the theme button twice: it must re-theme in place (same document, no navigation)."""
    page.set_viewport_size({"width": 1000, "height": 800})
    errors.clear()
    page.goto(f"{origin}{PAGE}?theme=light", wait_until="load")
    page.wait_for_selector("html[data-map-state=idle]", timeout=IDLE_TIMEOUT_MS)
    page.evaluate("() => { window.__same = 1; }")
    navs: list[str] = []
    page.on("framenavigated", lambda frame: navs.append(frame.url))
    steps = []
    for _ in FLIP_THEMES:
        page.click("#theme-flip")
        page.wait_for_selector("html[data-map-state=idle]", timeout=IDLE_TIMEOUT_MS)
        page.wait_for_timeout(SETTLE_MS)
        steps.append(
            {
                "theme": page.get_attribute("html", "data-theme"),
                "same_doc": page.evaluate("() => window.__same === 1"),
                "markers": page.evaluate(MARKERS_JS),
                "style_layers": page.evaluate(CANVASES_JS),
            }
        )
        if len(steps) == 1:
            page.screenshot(path=str(out / "map_wide_flipped_dark.png"))
    return {
        "steps": steps,
        "navigations": navs,
        "errors": list(errors),
        "csp": page.evaluate("() => window.__csp"),
    }


def main(argv: list[str], run: Callable[..., dict] = run) -> int:
    parser = argparse.ArgumentParser(prog="screenshot_map.py")
    parser.add_argument("outdir")
    parser.add_argument("--root", default=str(REPO_ROOT))
    parser.add_argument("--chrome-arg", action="append", default=[])
    args = parser.parse_args(argv)  # bad usage: usage line on stderr, SystemExit(2)
    report = run(args.root, args.outdir, args.chrome_arg) if args.chrome_arg else run(args.root, args.outdir)
    lines, code = render(report)
    print("\n".join(lines))
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
