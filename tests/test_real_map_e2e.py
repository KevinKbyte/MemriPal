# Covers: MEM-078, MEM-077
# Requirement: the real Kendall map must not widen the CSP, add a third-party origin or leak location
# (plan 2026-11-02-real-map S5; ADR 0041 conditions 6 and 9). The web CSP header and the native shell's
# CSP meta stay byte-equal to their pre-map values; in a real Chrome against the fixture-mode app, opening
# a route whose stations sit inside the Kendall bbox mounts the MapLibre map, and across load, a mouse pan
# and a wheel zoom there are 0 securitypolicyviolation events, 0 requests to a non-page origin, 0 request
# URLs carrying a lat/lon pair, every worker is a same-origin script (no blob: worker), and the extract
# answers as application/vnd.pmtiles. All of that holds for both a test-seeded route and the Kendall demo
# route (static/demo_route.js DEMO_ROUTE, plan S6); on the demo route every station sits on a rendered
# street (a roads feature within a 12 px box of its projected point) and no request fails or answers
# HTTP >= 400 (plan S6 criteria 2 and 4). Skips (never fails) where playwright or the Chrome channel is
# absent, matching tests/shooter_support.py::require_chrome. Run: uv run --with playwright pytest
# tests/test_real_map_e2e.py
import importlib.util
import os
import re
import shutil
import subprocess
from pathlib import Path
from urllib.parse import unquote, urlsplit

import pytest
from shooter_support import TOUR_SEED_JS, require_chrome

from memripal.security_headers import SECURITY_HEADERS

REPO = Path(__file__).resolve().parents[1]
SCRIPTS = REPO / "scripts"

# Pre-map values (tests/test_security_headers.py MEM-042; scripts/build_mobile_web.mjs MEM-063).
PRE_MAP_WEB_CSP = (
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; img-src 'self' data: blob:; "
    "object-src 'none'; base-uri 'none'; "
    "form-action 'self'; frame-ancestors 'none'"
)
NATIVE_API = "https://memripal-abc123-uc.a.run.app"
PRE_MAP_NATIVE_CSP = (
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; img-src 'self' data: blob:; "
    f"connect-src 'self' {NATIVE_API}; object-src 'none'; base-uri 'none'; form-action 'none'"
)

ROUTE_NAME = "E2E Kendall walk"
# Kendall Square stations, all inside static/real_map.js REAL_MAP_BBOX. The production demo route
# (fixtures/demo/route_backup.json) carries no coords and the v2 backup format has no coords key, so the
# test seeds its own route through the page's own route store (S6 owns the demo route's coords).
STATIONS = [
    ("Kendall T", 42.3625, -71.0862),
    ("Marriott corner", 42.3629, -71.0901),
    ("Lobby 7", 42.3592, -71.0935),
]
# A decimal lat/lon pair in any common URL shape: "42.3625,-71.0862", "42.36/-71.08", "lat=42.36&lon=-71.08".
LATLON_PAIR = re.compile(r"-?\d{1,3}\.\d{2,}\s*(?:,|/|_|&\w+=|;)\s*-?\d{1,3}\.\d{2,}")
TIMEOUT_MS = 30000

# Test-only instrumentation, injected before any page script: records CSP violations from page load on,
# and hands the test each MapLibre instance (the loader keeps it private) so pan/zoom can wait on the
# map's own "idle" event instead of a sleep. The UMD bundle assigns an empty globalThis.maplibregl and
# fills it afterwards, so the Map prototype is patched lazily on the first read after it exists.
INIT_JS = """
(() => {
  window.__e2eCsp = [];
  document.addEventListener("securitypolicyviolation", (e) => {
    window.__e2eCsp.push(`${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`);
  });
  window.__e2eMaps = [];
  let lib;
  Object.defineProperty(window, "maplibregl", {
    configurable: true,
    get() {
      if (lib && lib.Map && !lib.Map.prototype.__e2ePatched) {
        const proto = lib.Map.prototype;
        const setStyle = proto.setStyle;
        proto.setStyle = function (...args) {
          if (!window.__e2eMaps.includes(this)) window.__e2eMaps.push(this);
          return setStyle.apply(this, args);
        };
        proto.__e2ePatched = true;
      }
      return lib;
    },
    set(v) { lib = v; },
  });
})();
"""

SEED_JS = """
async ([routeName, stations]) => {
  const o = location.origin;
  const { createRouteStore } = await import(o + "/static/route_store.js");
  const { createIdbAdapter } = await import(o + "/static/idb_adapter.js");
  const adapter = createIdbAdapter(indexedDB, { dbName: "memripal-routes", storeName: "routes" });
  const store = createRouteStore(adapter);
  const route = await store.createRoute({ name: routeName, kind: "daily" });
  for (const [name, lat, lon] of stations) {
    const photo = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" });
    const st = await store.addStation(route.id, { photo, coords: { lat, lon } });
    await store.nameStation(route.id, st.id, { name });
  }
  return route.id;
}
"""

# Resolves on the map's next "idle"; the guard timer only turns a hang into a clear failure.
ARM_IDLE_JS = """
() => {
  const map = window.__e2eMaps[0];
  window.__e2eIdle = new Promise((resolve, reject) => {
    const guard = setTimeout(() => reject(new Error("map never went idle")), 20000);
    map.once("idle", () => { clearTimeout(guard); resolve(true); });
  });
}
"""
VIEW_JS = "() => { const m = window.__e2eMaps[0], c = m.getCenter(); return [c.lng, c.lat, m.getZoom()]; }"

# The demo route's own data, read from the served module so the test tracks it (never #load-demo).
DEMO_JS = """
async () => {
  const { DEMO_ROUTE } = await import(location.origin + "/static/demo_route.js");
  return [DEMO_ROUTE.name, DEMO_ROUTE.stations.map((s) => [s.name, s.coords.lat, s.coords.lon])];
}
"""
# Resolves once the map is idle: at once if it already is, else on its next "idle".
SETTLE_JS = """
() => new Promise((resolve, reject) => {
  const map = window.__e2eMaps[0];
  if (!map) return reject(new Error("no map instance captured"));
  if (map.loaded() && map.areTilesLoaded() && !map.isMoving()) return resolve(true);
  const guard = setTimeout(() => reject(new Error("map never went idle")), 20000);
  map.once("idle", () => { clearTimeout(guard); resolve(true); });
})
"""
# Streets only: rail, runway and taxiway lines share the roads source layer but are not walkable streets.
NOT_STREETS = ("roads_rail", "roads_runway", "roads_taxiway")
ROAD_BOX_PX = 12
ROADS_JS = """
([stations, half, notStreets]) => {
  const map = window.__e2eMaps[0];
  const c = map.getCanvas();
  return stations.map(([name, lat, lon]) => {
    const p = map.project([lon, lat]);
    const box = [[p.x - half, p.y - half], [p.x + half, p.y + half]];
    const roads = map.queryRenderedFeatures(box)
      .filter((f) => f.sourceLayer === "roads" && !notStreets.includes(f.layer.id));
    const inView = p.x >= 0 && p.y >= 0 && p.x <= c.clientWidth && p.y <= c.clientHeight;
    const layers = [...new Set(roads.map((f) => f.layer.id))];
    return { name, x: p.x, y: p.y, inView, roads: roads.length, layers };
  });
}
"""


def _load(name):
    spec = importlib.util.spec_from_file_location(f"{name}_under_test", SCRIPTS / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _open_drawer(page):
    if not page.locator("#drawer").evaluate("d => d.open", timeout=TIMEOUT_MS):
        page.locator(".drawer-handle").click(timeout=TIMEOUT_MS)


def _drive(page, data):
    """Load -> seed -> open the route -> first idle -> station roads -> mouse pan -> wheel zoom.

    Records each phase reached. The "demo" variant seeds DEMO_ROUTE's stations instead of STATIONS.
    """
    page.goto(data["base"] + "/")
    if data["variant"] == "demo":
        data["route_name"], data["stations"] = page.evaluate(DEMO_JS)
    page.evaluate(SEED_JS, [data["route_name"], data["stations"]])
    page.reload()
    _open_drawer(page)  # MEM-072: the route list lives in the route drawer
    page.get_by_role("button", name=f"Open {data['route_name']}").click(timeout=TIMEOUT_MS)
    # real_map.js drops .real-map-pending on the map's first idle; the map is the shell's .map-wrap (MEM-072).
    page.locator(".map-wrap .real-map:not(.real-map-pending)").wait_for(timeout=TIMEOUT_MS)
    data["phases"].append("load")

    page.evaluate(SETTLE_JS)
    data["station_roads"] = page.evaluate(ROADS_JS, [data["stations"], ROAD_BOX_PX / 2, list(NOT_STREETS)])
    data["phases"].append("roads")

    box = page.locator(".map-wrap .real-map").bounding_box()
    cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    data["views"].append(page.evaluate(VIEW_JS))
    page.evaluate(ARM_IDLE_JS)
    page.mouse.move(cx, cy)
    page.mouse.down()
    page.mouse.move(cx - 120, cy - 60, steps=12)
    page.mouse.up()
    page.evaluate("() => window.__e2eIdle")
    data["views"].append(page.evaluate(VIEW_JS))
    data["phases"].append("pan")

    page.evaluate(ARM_IDLE_JS)
    page.mouse.move(cx, cy)
    page.mouse.wheel(0, 600)  # zoom out: the fitted view may already sit at maxZoom 16
    page.evaluate("() => window.__e2eIdle")
    data["views"].append(page.evaluate(VIEW_JS))
    data["phases"].append("zoom")


def _run(tmp_path_factory, variant):
    """One real-Chrome run of _drive against a fresh fixture server; variant is "seeded" or "demo"."""
    require_chrome()
    from playwright.sync_api import sync_playwright

    drive = _load("e2e_drive")
    support = _load("e2e_support")
    out = tmp_path_factory.mktemp(f"real-map-e2e-{variant}")
    data = {"phases": [], "views": [], "requests": [], "workers": [], "extract": [], "error": None}
    data |= {"variant": variant, "route_name": ROUTE_NAME, "stations": [list(s) for s in STATIONS]}
    data |= {"failed": [], "http_errors": [], "station_roads": []}
    with drive.serve(out) as base:
        assert base is not None, f"fixture server never got ready; see {out / 'server.log'}"
        data["base"] = base
        ctx = support.Ctx(base=base, out=out, public_url=drive.public_url(base))
        with sync_playwright() as p:
            browser = p.chromium.launch(channel="chrome")
            try:
                context = browser.new_context(viewport={"width": 1280, "height": 900})
                context.add_init_script(TOUR_SEED_JS + INIT_JS)
                context.on("request", lambda r: data["requests"].append(r.url))
                failed, http_errors = data["failed"], data["http_errors"]
                context.on("requestfailed", lambda r: failed.append(f"{r.method} {r.url} {r.failure}"))
                context.on(
                    "response",
                    lambda r: (
                        r.status >= 400 and http_errors.append(f"{r.status} {r.request.method} {r.url}")
                    ),
                )
                context.on(
                    "response",
                    lambda r: (
                        r.url.endswith("/kendall.pmtiles")
                        and data["extract"].append((r.status, r.headers.get("content-type")))
                    ),
                )
                page = context.new_page()
                support.instrument(ctx, page, "real-map")
                page.on("worker", lambda w: data["workers"].append(w.url))
                try:
                    _drive(page, data)
                except Exception as exc:  # the per-criterion tests report which phase was missed
                    data["error"] = f"{type(exc).__name__}: {exc}"
                data["csp"] = page.evaluate("() => window.__e2eCsp")
                data["requests"] += ctx.net["all"]
                data["events"] = list(ctx.events)
            finally:
                browser.close()
    return data


@pytest.fixture(scope="module")
def seeded_run(tmp_path_factory):
    return _run(tmp_path_factory, "seeded")


@pytest.fixture(scope="module")
def demo_run(tmp_path_factory):
    return _run(tmp_path_factory, "demo")


@pytest.fixture(params=["seeded", "demo"])
def map_run(request):
    """Each S5 criterion holds for a test-seeded route and the Kendall demo route (one browser run each)."""
    return request.getfixturevalue(f"{request.param}_run")


def _need(data, *phases):
    missing = [p for p in phases if p not in data["phases"]]
    assert not missing, f"never reached {missing}; error: {data['error']}; events: {data.get('events')}"


def _origin(url):
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}"


# Covers: MEM-078
# Requirement: the web CSP header and the native shell CSP meta equal their pre-map strings.
class TestCspStringsUnchanged:
    def test_web_csp_equals_pre_map_value(self):
        assert SECURITY_HEADERS["Content-Security-Policy"] == PRE_MAP_WEB_CSP

    def test_native_csp_equals_pre_map_value(self, tmp_path):
        node = shutil.which("node")
        if node is None:
            pytest.skip("node not on PATH")
        # A throwaway copy: the build wipes and rewrites <repo>/www, so never run it in the real checkout.
        (tmp_path / "scripts").mkdir()
        (tmp_path / "static").mkdir()
        shutil.copy2(SCRIPTS / "build_mobile_web.mjs", tmp_path / "scripts")
        shutil.copy2(REPO / "static" / "index.html", tmp_path / "static")
        env = {**os.environ, "MEMRIPAL_API_BASE": NATIVE_API}
        r = subprocess.run(
            [node, str(tmp_path / "scripts" / "build_mobile_web.mjs")],
            cwd=tmp_path,
            env=env,
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
        assert r.returncode == 0, r.stderr
        html = (tmp_path / "www" / "index.html").read_text(encoding="utf-8")
        metas = re.findall(r'<meta http-equiv="Content-Security-Policy" content="([^"]*)">', html)
        assert metas == [PRE_MAP_NATIVE_CSP]


# Covers: MEM-078
# Requirement: in a real Chrome, the route map page's real map loads, pans and zooms with 0 CSP
# violations, only same-origin requests, no coordinates in any URL and a same-origin map worker.
class TestRealMapPageE2E:
    def test_map_mounts_then_pans_and_zooms(self, map_run):
        _need(map_run, "load", "pan", "zoom")
        (lng0, lat0, z0), (lng1, lat1, z1), (_, _, z2) = map_run["views"]
        assert (lng1, lat1) != (lng0, lat0), "mouse drag did not move the map"
        assert z2 < z1, f"wheel did not zoom out: {z1} -> {z2}"

    def test_no_csp_violations_during_load_pan_zoom(self, map_run):
        _need(map_run, "load", "pan", "zoom")
        assert map_run["csp"] == []
        refusals = [e for e in map_run["events"] if "Content Security Policy" in e.get("text", "")]
        assert refusals == []

    def test_every_request_is_same_origin(self, map_run):
        _need(map_run, "load", "pan", "zoom")
        page_origin = _origin(map_run["base"])
        http = [u for u in map_run["requests"] if urlsplit(u).scheme in ("http", "https", "ws", "wss")]
        assert any(u.endswith("/static/map/kendall.pmtiles") for u in http), "extract never requested"
        foreign = sorted({u for u in http if _origin(u) != page_origin})
        assert foreign == []
        allowed = ("http", "https", "data", "blob")
        others = sorted({u for u in map_run["requests"] if urlsplit(u).scheme not in allowed})
        assert others == []

    def test_no_request_url_carries_coordinates(self, map_run):
        _need(map_run, "load", "pan", "zoom")
        leaks = sorted({u for u in map_run["requests"] if LATLON_PAIR.search(unquote(u))})
        assert leaks == []
        # Two-decimal prefixes ("42.36", "-71.08") catch a single rounded or truncated coordinate, too.
        for name, lat, lon in map_run["stations"]:
            marks = (f"{lat:.4f}"[:5], f"{lon:.4f}"[:6])
            hits = [u for u in map_run["requests"] if any(m in unquote(u) for m in marks)]
            assert hits == [], f"{name} coordinates in {hits}"

    def test_map_worker_is_same_origin_not_blob(self, map_run):
        _need(map_run, "load")
        page_origin = _origin(map_run["base"])
        assert any("maplibre-gl-csp-worker.js" in u for u in map_run["workers"]), map_run["workers"]
        bad = [u for u in map_run["workers"] if u.startswith("blob:") or _origin(u) != page_origin]
        assert bad == []

    def test_extract_served_as_application_vnd_pmtiles(self, map_run):
        _need(map_run, "load")
        assert map_run["extract"], "extract response never seen"
        assert all(st == 200 and ct == "application/vnd.pmtiles" for st, ct in map_run["extract"]), map_run[
            "extract"
        ]


# Covers: MEM-077
# Requirement: the Kendall demo route renders on the real map with every station on a street: per
# station, queryRenderedFeatures in a 12 px box around its projected point returns >= 1 roads feature,
# and the run makes 0 failed requests and gets 0 HTTP responses >= 400 (plan 2026-11-02-real-map S6
# criteria 2 and 4; same-origin and no-coords-in-URL are pinned for this run by TestRealMapPageE2E).
class TestDemoRouteOnKendallStreets:
    def test_demo_route_seeds_and_mounts_the_real_map(self, demo_run):
        _need(demo_run, "load")
        assert demo_run["route_name"] != ROUTE_NAME
        assert len(demo_run["stations"]) >= 3

    def test_every_demo_station_has_a_roads_feature_within_12px(self, demo_run):
        _need(demo_run, "load", "roads")
        got = demo_run["station_roads"]
        assert [r["name"] for r in got] == [s[0] for s in demo_run["stations"]]
        off_street = [r for r in got if not r["inView"] or r["roads"] < 1]
        assert off_street == [], f"stations without a roads feature in a {ROAD_BOX_PX} px box: {off_street}"

    def test_no_failed_requests(self, demo_run):
        _need(demo_run, "load", "roads", "pan", "zoom")
        assert demo_run["failed"] == []
        page_failed = [e for e in demo_run["events"] if e["kind"] == "requestfailed"]
        assert page_failed == []

    def test_no_http_error_responses(self, demo_run):
        _need(demo_run, "load", "roads", "pan", "zoom")
        assert demo_run["http_errors"] == []
        page_errors = [e for e in demo_run["events"] if e["kind"].startswith("http")]
        assert page_errors == []


SHELL_VIEWPORTS = {"phone": (375, 812), "desktop": (1280, 800)}
SHELL_TABS = ("routes", "landmarks", "recall", "settings")
SHELL_KEYS = [(vp, s) for vp in SHELL_VIEWPORTS for s in ("light", "dark")]
TABS_JS = "() => [...document.querySelectorAll('.tabbar .tab')].map((a) => a.getAttribute('aria-current'))"
PANELS_JS = "() => [...document.querySelectorAll('.tab-panel')].filter((p) => !p.hidden).map((p) => p.id)"


def _shell_drive(page, shot):
    """MEM-072 shell: open the demo route from the drawer, then measure the map, drawer and tab bar."""
    page.goto(shot["base"] + "/")
    name, stations = page.evaluate(DEMO_JS)
    page.evaluate(SEED_JS, [name, stations])
    page.reload()
    _open_drawer(page)
    page.get_by_role("button", name=f"Open {name}").click(timeout=TIMEOUT_MS)
    page.locator(".map-wrap .real-map:not(.real-map-pending)").wait_for(timeout=TIMEOUT_MS)
    shot["drawer_left"] = page.locator("#drawer").bounding_box()["x"]
    shot["map_open"] = page.locator(".map-wrap .real-map").bounding_box()
    page.locator(".drawer-handle").click(timeout=TIMEOUT_MS)
    shot["drawer"] = [page.locator("#drawer").evaluate("d => d.open")]
    shot["map"] = page.locator(".map-wrap .real-map").bounding_box()
    shot["tabbar"] = page.locator("nav.tabbar").bounding_box()
    shot["tabbar_bg"] = page.locator("nav.tabbar").evaluate("n => getComputedStyle(n).backgroundColor")
    drawer, body = page.locator("#drawer"), page.locator(".drawer-body")
    for _ in range(2):  # open (body visible), then close (body hidden)
        page.locator(".drawer-handle").click(timeout=TIMEOUT_MS)
        shot["drawer"] += [drawer.evaluate("d => d.open"), body.is_visible()]
    for tab in SHELL_TABS:
        page.locator(f'nav.tabbar a.tab[href="#{tab}"]').click(timeout=TIMEOUT_MS)
        shot["tabs"].append((tab, page.evaluate(TABS_JS), page.evaluate(PANELS_JS)))


@pytest.fixture(scope="module")
def shell_run(tmp_path_factory):
    require_chrome()
    from playwright.sync_api import sync_playwright

    drive = _load("e2e_drive")
    out = tmp_path_factory.mktemp("shell-e2e")
    shots = {}
    with drive.serve(out) as base:
        assert base is not None, f"fixture server never got ready; see {out / 'server.log'}"
        with sync_playwright() as p:
            browser = p.chromium.launch(channel="chrome")
            try:
                for vp, (w, h) in SHELL_VIEWPORTS.items():
                    for scheme in ("light", "dark"):
                        shot = {"base": base, "vw": w, "vh": h, "tabs": [], "error": None}
                        context = browser.new_context(viewport={"width": w, "height": h}, color_scheme=scheme)
                        context.add_init_script(TOUR_SEED_JS)
                        try:
                            _shell_drive(context.new_page(), shot)
                        except Exception as exc:  # each criterion test reports the error
                            shot["error"] = f"{type(exc).__name__}: {exc}"
                        finally:
                            context.close()
                        shots[(vp, scheme)] = shot
            finally:
                browser.close()
    return shots


# Covers: MEM-072
# Requirement: in a real Chrome at 375x812 and 1280x800, light and dark, the map-first shell's real map
# fills the viewport above the fixed bottom tab bar (left 0, top 0, full width, bottom at the tab bar's
# top); the route drawer opens and closes from its handle, and at 1280 an open drawer shrinks the map
# beside it; each tab click marks only itself aria-current="page" and shows only its panel; the tab bar
# takes a different background in dark mode.
class TestMapFirstShellE2E:
    @pytest.mark.parametrize("key", SHELL_KEYS, ids=lambda k: "-".join(k))
    def test_map_fills_the_viewport_above_the_tabbar(self, shell_run, key):
        shot = shell_run[key]
        assert shot["error"] is None, shot["error"]
        m, bar = shot["map"], shot["tabbar"]
        assert abs(m["x"]) <= 1 and abs(m["y"]) <= 1, f"map box origin {m}"
        assert abs(m["width"] - shot["vw"]) <= 1, f"map width {m['width']} vs viewport {shot['vw']}"
        assert abs(m["y"] + m["height"] - bar["y"]) <= 1, f"map bottom vs tabbar top {bar['y']}"
        assert abs(bar["y"] + bar["height"] - shot["vh"]) <= 1, f"tabbar not at the viewport bottom: {bar}"

    @pytest.mark.parametrize("key", SHELL_KEYS, ids=lambda k: "-".join(k))
    def test_drawer_opens_and_closes_from_its_handle(self, shell_run, key):
        shot = shell_run[key]
        assert shot["error"] is None, shot["error"]
        assert shot["drawer"] == [False, True, True, False, False], "handle: close, open + body, close"

    @pytest.mark.parametrize("scheme", ["light", "dark"])
    def test_open_drawer_shrinks_the_map_at_1280(self, shell_run, scheme):
        shot = shell_run[("desktop", scheme)]
        assert shot["error"] is None, shot["error"]
        m = shot["map_open"]
        assert m["x"] + m["width"] <= shot["drawer_left"] + 1, (m, shot["drawer_left"])

    @pytest.mark.parametrize("key", SHELL_KEYS, ids=lambda k: "-".join(k))
    def test_each_tab_marks_only_itself_current_and_shows_its_panel(self, shell_run, key):
        shot = shell_run[key]
        assert shot["error"] is None, shot["error"]
        assert [t for t, _, _ in shot["tabs"]] == list(SHELL_TABS)
        for i, (tab, currents, panels) in enumerate(shot["tabs"]):
            assert currents == ["page" if j == i else None for j in range(len(SHELL_TABS))], (tab, currents)
            assert panels == [f"tab-{tab}"], f"{tab}: visible panels {panels}"

    @pytest.mark.parametrize("vp", list(SHELL_VIEWPORTS))
    def test_tabbar_background_follows_dark_mode(self, shell_run, vp):
        light, dark = shell_run[(vp, "light")], shell_run[(vp, "dark")]
        assert light["error"] is None and dark["error"] is None, (light["error"], dark["error"])
        assert light["tabbar_bg"] != dark["tabbar_bg"], light["tabbar_bg"]
