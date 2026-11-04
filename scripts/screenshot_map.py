"""Screenshot the Kendall basemap design preview under the app CSP and check a clean run (MEM-076).

Usage: uv run --no-project --with playwright python scripts/screenshot_map.py <outdir> [--root DIR]
         [--chrome-arg=ARG]...
Serves --root (default: the repo root) with the app CSP + nosniff, shoots docs/design/map/preview.html at
phone=375x812 and wide=1000x800 in light and dark, then clicks the theme button twice and checks the map
re-themes in place, then at each width pans the route off the map (map_<width>_pan.png) and checks the
overlay stays clipped to the map with off-screen stations pinned to its edge, then clicks a pinned station
and checks it opens that station's detail in the list (map_<width>_select.png). Prints the report JSON,
then "ERR <msg>" per problem, then "shots=<n> problems=<m>".
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
    "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
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
# Pan 1.5 map widths west (maxBounds still leaves ~1.8 km), so at least one station's true spot leaves the
# map, then measure page-px boxes. A station's true spot comes from its data-lnglat projected by the live map.
PAN_JS = """async () => {
  const map = window.__map;
  const w = map.getContainer().clientWidth;
  await new Promise(res => { map.once('idle', res); setTimeout(res, 5000);
    map.panBy([-1.5 * w, 0], {animate: false}); });
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const wrapEl = document.querySelector('.mp-wrap');
  const r = wrapEl.getBoundingClientRect();
  const rnd = v => Math.round(v * 10) / 10;
  const box = b => [b.left, b.top, b.right, b.bottom].map(rnd);
  const ov = el => getComputedStyle(el).overflow;
  const stations = [...document.querySelectorAll('#overlay .lm')].map(g => {
    const p = map.project(g.getAttribute('data-lnglat').split(',').map(Number));
    return {box: box(g.getBoundingClientRect()), pinned: g.classList.contains('lm-pinned'),
      inside: p.x >= 0 && p.y >= 0 && p.x <= r.width && p.y <= r.height,
      spot: [rnd(r.left + p.x), rnd(r.top + p.y)]};
  });
  return {wrap: box(r), stations,
    clipped: ov(wrapEl) !== 'visible' || ov(document.getElementById('overlay')) !== 'visible'};
}"""
# Station 3 sits pinned on its own (not stacked under another) after the pan at both widths.
SELECT_STATION = 3
SELECT_JS = """(n) => {
  const map = window.__map;
  const c = map.getContainer();
  const items = [...document.querySelectorAll('.mp-route ol > li')];
  const marks = [...document.querySelectorAll('#overlay .lm')];
  const li = items[n - 1];
  const detail = li && li.querySelector('.mp-st-detail');
  const p = map.project(marks[n - 1].getAttribute('data-lnglat').split(',').map(Number));
  return {
    expanded: items.flatMap((it, i) => it.querySelector('[aria-expanded="true"]') ? [i + 1] : []),
    selected: marks.flatMap((g, i) => g.classList.contains('lm-selected') ? [i + 1] : []),
    detail_chars: detail && !detail.hidden ? detail.textContent.trim().length : 0,
    focus_in: !!li && li.contains(document.activeElement),
    spot_inside: p.x >= 0 && p.y >= 0 && p.x <= c.clientWidth && p.y <= c.clientHeight,
  };
}"""


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
    found += _pan_problems(report.get("pan"))
    found += _select_problems(report.get("select"))
    return found


def _select_problems(select: list[dict] | None) -> list[str]:
    """A pinned marker click opens exactly its station's detail in the list and brings its spot on screen."""
    want = [name for name, _ in WIDTHS]
    widths = [entry.get("width") for entry in select or []]
    if widths != want:
        return [f"select: widths {widths}, expected {want}"]
    found: list[str] = []
    for entry in select:
        width, n = entry["width"], entry["station"]
        if entry["expanded"] != [n]:
            found.append(f"select {width}: expanded list items {entry['expanded']}, expected [{n}]")
        if entry["selected"] != [n]:
            found.append(f"select {width}: ringed markers {entry['selected']}, expected [{n}]")
        if entry["detail_chars"] <= 0:
            found.append(f"select {width}: station {n} detail is empty or hidden")
        if not entry["focus_in"]:
            found.append(f"select {width}: focus did not move into station {n}'s list item")
        if not entry["spot_inside"]:
            found.append(f"select {width}: station {n}'s spot is still off the map")
    return found


def _within(box: Sequence[float], wrap: Sequence[float]) -> bool:
    return box[0] >= wrap[0] and box[1] >= wrap[1] and box[2] <= wrap[2] and box[3] <= wrap[3]


def _pan_problems(pan: list[dict] | None) -> list[str]:
    """Panned off the route, the overlay must stay inside the map and pin off-screen stations to its edge."""
    want = [name for name, _ in WIDTHS]
    widths = [entry.get("width") for entry in pan or []]
    if widths != want:
        return [f"pan: widths {widths}, expected {want}"]
    found: list[str] = []
    for entry in pan:
        width, stations = entry["width"], entry["stations"]
        if not entry["clipped"]:
            found.append(f"pan {width}: overlay not clipped to the map")
        if not stations:
            found.append(f"pan {width}: no stations")
            continue
        if all(st["inside"] for st in stations):
            found.append(f"pan {width}: every station still on the map, the pan proved nothing")
        outside = [i + 1 for i, st in enumerate(stations) if not _within(st["box"], entry["wrap"])]
        if outside:
            found.append(f"pan {width}: stations {outside} drawn outside the map {entry['wrap']}")
        wrong = [i + 1 for i, st in enumerate(stations) if st["pinned"] == st["inside"]]
        if wrong:
            found.append(f"pan {width}: stations {wrong} pinned != off the map")
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
                report["pan"], report["select"] = [], []
                for name, vp in WIDTHS:
                    report["pan"].append(_pan_check(page, origin, out, name, vp))
                    report["select"].append(_select_check(page, out, name))
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

    def on_nav(frame) -> None:
        navs.append(frame.url)

    page.on("framenavigated", on_nav)
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
    page.remove_listener("framenavigated", on_nav)  # later checks navigate on purpose
    return {
        "steps": steps,
        "navigations": navs,
        "errors": list(errors),
        "csp": page.evaluate("() => window.__csp"),
    }


def _pan_check(page, origin: str, out: Path, name: str, viewport: tuple[int, int]) -> dict:
    """Pan the route off the map: the overlay must stay clipped and off-screen stations pinned to its edge."""
    page.set_viewport_size({"width": viewport[0], "height": viewport[1]})
    page.goto(f"{origin}{PAGE}?theme=light", wait_until="load")
    page.wait_for_selector("html[data-map-state=idle]", timeout=IDLE_TIMEOUT_MS)
    page.wait_for_selector("#overlay .lm", timeout=IDLE_TIMEOUT_MS)
    measured = page.evaluate(PAN_JS)
    page.wait_for_timeout(SETTLE_MS)
    page.screenshot(path=str(out / f"map_{name}_pan.png"))
    return {"width": name, **measured}


def _select_check(page, out: Path, name: str) -> dict:
    """From the panned view, click SELECT_STATION's pinned marker and measure the list detail it opens."""
    click_error = None
    try:
        page.locator("#overlay .lm").nth(SELECT_STATION - 1).locator(".lm-hit").click(timeout=5000)
    except Exception as exc:  # no clickable marker: the measurements below then show nothing opened
        click_error = str(exc).splitlines()[0]
    page.wait_for_timeout(SETTLE_MS)
    page.wait_for_function("() => !window.__map.isMoving()", timeout=IDLE_TIMEOUT_MS)
    page.wait_for_timeout(SETTLE_MS)
    measured = page.evaluate(SELECT_JS, SELECT_STATION)
    page.screenshot(path=str(out / f"map_{name}_select.png"))
    return {"width": name, "station": SELECT_STATION, "click_error": click_error, **measured}


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
