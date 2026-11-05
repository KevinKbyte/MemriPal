# Covers: MEM-017, MEM-073
# Requirement: scripts/screenshot_ui.py screenshots the upload UI before and after "Load demo"
# and the route view of a walked route it imports from fixtures/demo/route_backup.json (MEM-073),
# and fails (exit 1) on any page or console error except the known /favicon.ico 404, which is
# dropped by significant_errors whatever its query string; it exits 0 when only that favicon
# error (or nothing) was seen, exits 2 with a usage line on stderr for a wrong argument count
# without launching a browser, and the module imports even when playwright is not installed.
import base64
import importlib.util
import json
import sys
import types
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "scripts" / "screenshot_ui.py"

URL = "http://127.0.0.1:8000/"
FAVICON = (
    "Failed to load resource: the server responded with a status of 404 (Not Found)",
    "http://127.0.0.1:8000/favicon.ico",
)
FAVICON_QUERY = (FAVICON[0], "http://127.0.0.1:8000/favicon.ico?v=2")
CONSOLE_ERR = (
    "TypeError: Cannot read properties of null (reading 'textContent')",
    "http://127.0.0.1:8000/static/app.js",
)
OTHER_404 = (FAVICON[0], "http://127.0.0.1:8000/demo/photo.jpg")


def _load():
    spec = importlib.util.spec_from_file_location("screenshot_ui_under_test", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class RecordingRun:
    def __init__(self, errors):
        self.errors = errors
        self.calls = []

    def __call__(self, url, outdir):
        self.calls.append((url, outdir))
        return list(self.errors)


class TestScreenshotUi:
    def test_keeps_non_favicon_console_error(self):
        assert _load().significant_errors([CONSOLE_ERR]) == [CONSOLE_ERR]

    def test_drops_favicon_404(self):
        assert _load().significant_errors([FAVICON]) == []

    def test_drops_favicon_404_with_query_string(self):
        assert _load().significant_errors([FAVICON_QUERY]) == []

    def test_keeps_404_from_another_url(self):
        assert _load().significant_errors([OTHER_404]) == [OTHER_404]

    def test_keeps_favicon_under_a_subpath(self):
        nested = (FAVICON[0], "http://127.0.0.1:8000/static/favicon.ico")
        assert _load().significant_errors([nested]) == [nested]

    def test_empty_in_empty_out(self):
        assert _load().significant_errors([]) == []

    def test_mixed_keeps_only_significant_in_order(self):
        errors = [FAVICON, CONSOLE_ERR, FAVICON_QUERY, OTHER_404]
        assert _load().significant_errors(errors) == [CONSOLE_ERR, OTHER_404]

    def test_main_exits_0_when_only_favicon_error(self, tmp_path):
        run = RecordingRun([FAVICON])
        assert _load().main([URL, str(tmp_path)], run=run) == 0
        assert len(run.calls) == 1
        url, outdir = run.calls[0]
        assert url == URL
        assert Path(outdir) == tmp_path

    def test_main_exits_0_when_no_errors(self, tmp_path):
        assert _load().main([URL, str(tmp_path)], run=RecordingRun([])) == 0

    def test_main_exits_1_on_other_error(self, tmp_path):
        run = RecordingRun([FAVICON, CONSOLE_ERR])
        assert _load().main([URL, str(tmp_path)], run=run) == 1
        assert len(run.calls) == 1

    @pytest.mark.parametrize("argv", [[], [URL], [URL, "out", "extra"]])
    def test_main_exits_2_on_wrong_arg_count_without_running(self, argv, capsys):
        run = RecordingRun([])
        try:
            code = _load().main(argv, run=run)
        except SystemExit as exc:  # argparse-style exit is an equally valid exit 2
            code = exc.code
        assert code == 2
        assert run.calls == []
        assert "usage" in capsys.readouterr().err.lower()

    def test_module_imports_without_playwright(self, monkeypatch):
        monkeypatch.setitem(sys.modules, "playwright", None)
        monkeypatch.setitem(sys.modules, "playwright.sync_api", None)
        module = _load()
        assert module.significant_errors([FAVICON, CONSOLE_ERR]) == [CONSOLE_ERR]
        assert callable(module.main)


# Covers: MEM-073
# Requirement: with the room-photo flow retired (ADR 0040) the screenshot run also shoots the route
# view: besides initial.png and load_demo.png it imports the committed backup ROUTE_BACKUP
# (fixtures/demo/route_backup.json) through the page's #backup-import file input and, after that
# import, writes route_view.png to the same outdir. ROUTE_BACKUP is a module-level Path to that file,
# a backup v2 holding one route of 3 named stations, each photo the demo photo byte for byte. Driven
# with a fake playwright module, so no browser is launched.
FIXTURE = REPO_ROOT / "fixtures" / "demo" / "route_backup.json"
DEMO_PHOTO = REPO_ROOT / "fixtures" / "demo" / "photo.jpg"


class _Handle:
    """Permissive stand-in for any playwright object; records calls into the shared log."""

    def __init__(self, log, selector=None):
        self._log = log
        self._selector = selector

    def __bool__(self):
        return True

    def __iter__(self):
        return iter(())

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def __call__(self, *args, **kwargs):
        return _Handle(self._log, self._selector)

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        return _Member(self._log, self._selector, name)


class _Member(_Handle):
    """A handle attribute: a call records itself; an attribute read chains (p.chromium.launch)."""

    def __init__(self, log, selector, name):
        super().__init__(log, selector)
        self._name = name

    def __call__(self, *args, **kwargs):
        name = self._name
        self._log.append((name, self._selector, args, kwargs))
        if name == "screenshot":
            path = kwargs.get("path", args[0] if args else None)
            if path is not None:
                Path(path).write_bytes(b"PNG fake")
        if name in ("locator", "query_selector", "wait_for_selector", "get_by_text", "get_by_role"):
            return _Handle(self._log, args[0] if args else kwargs.get("selector"))
        if name in ("eval_on_selector_all", "evaluate", "all_text_contents", "query_selector_all"):
            return []
        if name in ("count",):
            return 1
        return _Handle(self._log, self._selector)


def _fake_playwright(log):
    module = types.ModuleType("playwright.sync_api")
    module.sync_playwright = lambda: _Handle(log)
    return module


def _run_with_fake_browser(monkeypatch, tmp_path):
    log = []
    monkeypatch.setitem(sys.modules, "playwright", types.ModuleType("playwright"))
    monkeypatch.setitem(sys.modules, "playwright.sync_api", _fake_playwright(log))
    module = _load()
    module.run(URL, str(tmp_path))
    return module, log


def _files_of(entry):
    name, selector, args, kwargs = entry
    rest = list(args)
    if name == "set_input_files" and selector is None and rest:
        selector = rest.pop(0)
    files = kwargs.get("files", rest[0] if rest else None)
    files = files if isinstance(files, (list, tuple)) else [files]
    return selector, [Path(str(f)).resolve() for f in files if f is not None]


class TestRouteViewShot:
    def test_route_backup_constant_names_the_committed_fixture(self):
        module = _load()
        assert Path(module.ROUTE_BACKUP).resolve() == FIXTURE.resolve()

    def test_fixture_is_a_v2_backup_with_one_route_of_3_named_stations(self):
        data = json.loads(FIXTURE.read_text(encoding="utf-8"))
        assert data["v"] == 2
        assert len(data["routes"]) == 1
        stations = data["routes"][0]["stations"]
        assert [st["n"] for st in stations] == [1, 2, 3]
        assert all(st["status"] == "named" and st["name"].strip() for st in stations)

    def test_fixture_station_photos_are_the_demo_photo(self):
        data = json.loads(FIXTURE.read_text(encoding="utf-8"))
        prefix = "data:image/jpeg;base64,"
        for st in data["routes"][0]["stations"]:
            assert st["photo"].startswith(prefix)
            assert base64.b64decode(st["photo"][len(prefix) :]) == DEMO_PHOTO.read_bytes()

    def test_run_keeps_initial_and_load_demo_and_adds_route_view(self, monkeypatch, tmp_path):
        _, log = _run_with_fake_browser(monkeypatch, tmp_path)
        shots = [
            Path(str(kw.get("path", a[0] if a else ""))).name for n, _, a, kw in log if n == "screenshot"
        ]
        assert shots[0] == "initial.png"
        # MEM-077 adds the demo route shots (TestDemoRouteShots); these three stay, each shot once.
        for name in ("initial.png", "load_demo.png", "route_view.png"):
            assert shots.count(name) == 1, (name, shots)
        for name in shots:
            assert (tmp_path / name).is_file(), name

    def test_run_imports_the_fixture_through_backup_import_before_the_route_view_shot(
        self, monkeypatch, tmp_path
    ):
        module, log = _run_with_fake_browser(monkeypatch, tmp_path)
        imports = [i for i, e in enumerate(log) if e[0] == "set_input_files"]
        assert imports, "run never set a file on any input"
        selector, files = _files_of(log[imports[0]])
        assert selector == "#backup-import"
        assert files == [Path(module.ROUTE_BACKUP).resolve()]
        route_shot = [
            i
            for i, (n, _, a, kw) in enumerate(log)
            if n == "screenshot" and Path(str(kw.get("path", a[0] if a else ""))).name == "route_view.png"
        ]
        assert route_shot and route_shot[0] > imports[0], "route_view.png must be shot after the import"


# Covers: MEM-077
# Requirement: the screenshot run shows the Kendall demo route drawn on the real map (plan
# 2026-11-02-real-map S6 criterion 5): it writes demo_route_light.png and demo_route_dark.png, each at a
# 375 px wide viewport in the matching prefers-color-scheme (viewport / color_scheme on new_page or
# new_context, or set_viewport_size / emulate_media). Before each demo shot it has clicked #load-demo,
# then opened the demo route's card by its Open button name "Open <DEMO_ROUTE_NAME>", then waited for
# the real map's first idle (the `.real-map:not(.real-map-pending)` selector the S5 e2e waits on), with
# no navigation between that Open and the shot. DEMO_ROUTE_NAME is a module-level str equal to
# static/demo_route.js DEMO_ROUTE.name (quoted there as a string literal). The existing initial,
# load_demo and route_view shots are kept, as are MEM-095's tour-step1 and tour-step5 shots and
# MEM-140's tour-step3 shot (tests/test_screenshot_ui_tour.py); no other shot is written.
# Driven with the fake playwright above.
DEMO_ROUTE_JS = REPO_ROOT / "static" / "demo_route.js"
DEMO_SHOTS = {"demo_route_light.png": "light", "demo_route_dark.png": "dark"}
NAVIGATIONS = ("goto", "reload", "new_page", "new_context")


def _shot_name(entry):
    name, _, args, kwargs = entry
    if name != "screenshot":
        return None
    return Path(str(kwargs.get("path", args[0] if args else ""))).name


def _media_states(log):
    """Viewport width and colour scheme in force at each log index, per the calls the run made."""
    width, scheme, states = None, "light", []
    for name, _, args, kwargs in log:
        if name in ("new_page", "new_context"):
            vp = kwargs.get("viewport")
            if isinstance(vp, dict) and "width" in vp:
                width = vp["width"]
            if "color_scheme" in kwargs:
                scheme = kwargs["color_scheme"]
        elif name == "set_viewport_size":
            vp = kwargs.get("viewport_size", args[0] if args else None)
            if isinstance(vp, dict) and "width" in vp:
                width = vp["width"]
        elif name == "emulate_media" and "color_scheme" in kwargs:
            scheme = kwargs["color_scheme"]
        states.append((width, scheme))
    return states


def _is_load_demo_click(entry):
    name, selector, args, kwargs = entry
    text = repr((selector, args, kwargs))
    return name in ("click", "get_by_role", "get_by_text") and ("#load-demo" in text or "'Load demo'" in text)


class TestDemoRouteShots:
    def _demo_name(self):
        module = _load()
        name = getattr(module, "DEMO_ROUTE_NAME", None)
        assert isinstance(name, str) and name.strip(), "screenshot_ui.py defines a non-empty DEMO_ROUTE_NAME"
        return name

    def test_demo_route_name_matches_demo_route_js(self):
        name = self._demo_name()
        assert DEMO_ROUTE_JS.is_file(), "static/demo_route.js exists"
        text = DEMO_ROUTE_JS.read_text(encoding="utf-8")
        quoted = [f'"{name}"', f"'{name}'", f"`{name}`"]
        assert any(q in text for q in quoted), f"{name!r} not a literal in demo_route.js"

    def test_run_writes_light_and_dark_demo_route_shots_plus_the_existing_three(self, monkeypatch, tmp_path):
        _, log = _run_with_fake_browser(monkeypatch, tmp_path)
        shots = [s for s in (_shot_name(e) for e in log) if s]
        # MEM-095 adds the tour step shots; MEM-140 adds tour-step3 (tests/test_screenshot_ui_tour.py).
        tour = ["tour-step1.png", "tour-step3.png", "tour-step5.png"]
        expected = sorted([*DEMO_SHOTS, *tour, "initial.png", "load_demo.png", "route_view.png"])
        assert sorted(shots) == expected
        for name in shots:
            assert (tmp_path / name).is_file(), name

    def test_each_demo_shot_is_375_px_in_its_colour_scheme(self, monkeypatch, tmp_path):
        _, log = _run_with_fake_browser(monkeypatch, tmp_path)
        states = _media_states(log)
        seen = {}
        for i, entry in enumerate(log):
            shot = _shot_name(entry)
            if shot in DEMO_SHOTS:
                seen[shot] = states[i]
        assert set(seen) == set(DEMO_SHOTS), f"demo shots taken: {sorted(seen)}"
        for shot, scheme in DEMO_SHOTS.items():
            assert seen[shot] == (375, scheme), f"{shot}: (width, scheme) {seen[shot]}"

    def test_each_demo_shot_follows_load_demo_open_and_real_map_idle(self, monkeypatch, tmp_path):
        name = self._demo_name()
        _, log = _run_with_fake_browser(monkeypatch, tmp_path)
        shot_at = {_shot_name(e): i for i, e in enumerate(log) if _shot_name(e) in DEMO_SHOTS}
        assert set(shot_at) == set(DEMO_SHOTS), f"demo shots taken: {sorted(shot_at)}"
        for shot, k in shot_at.items():
            opens = [i for i in range(k) if f"Open {name}" in repr(log[i][1:])]
            assert opens, f"{shot}: demo route card never opened by 'Open {name}'"
            j = opens[-1]
            clicked = any(_is_load_demo_click(log[i]) for i in range(j))
            assert clicked, f"{shot}: no #load-demo click before Open"
            waits = [
                i
                for i in range(j + 1, k)
                if log[i][0].startswith("wait_for") and "real-map-pending" in repr(log[i][1:])
            ]
            assert waits, f"{shot}: no wait for the real map's first idle between Open and the shot"
            navs = [log[i][0] for i in range(j + 1, k) if log[i][0] in NAVIGATIONS]
            assert navs == [], f"{shot}: navigation {navs} between Open and the shot"


# Covers: MEM-072
# Requirement: on the map-first shell (MEM-072) the route list and Load demo live in the route drawer and
# the place and backup settings on the Settings tab, so the screenshot run opens the drawer (a .drawer-handle
# click) before every #load-demo click and every "Open <DEMO_ROUTE_NAME>", and selects the Settings tab (a
# click on a.tab[href="#settings"]) before touching #place-toggle or #backup-import, each with no
# navigation between that step and the control. Driven with the fake playwright above; no browser.
def _last_before(log, k, pred):
    hits = [i for i in range(k) if pred(log[i])]
    return hits[-1] if hits else -1


def _is_nav(entry):
    return entry[0] in NAVIGATIONS


def _is_drawer_open(entry):
    return entry[0] == "click" and ".drawer-handle" in repr(entry[1:])


def _is_settings_tab(entry):
    return entry[0] == "click" and 'a.tab[href="#settings"]' in repr(entry[1:]).replace("'", '"')


class TestShellNavigation:
    def test_drawer_opened_before_each_load_demo_and_open_demo_route(self, monkeypatch, tmp_path):
        name = TestDemoRouteShots()._demo_name()
        _, log = _run_with_fake_browser(monkeypatch, tmp_path)
        steps = [i for i, e in enumerate(log) if _is_load_demo_click(e) or f"Open {name}" in repr(e[1:])]
        assert steps, "run never clicked #load-demo or opened the demo route"
        for k in steps:
            drawer, nav = _last_before(log, k, _is_drawer_open), _last_before(log, k, _is_nav)
            assert drawer > nav, f"step {k} {log[k][:2]}: no .drawer-handle click since the last navigation"

    def test_settings_tab_selected_before_place_toggle_and_backup_import(self, monkeypatch, tmp_path):
        _, log = _run_with_fake_browser(monkeypatch, tmp_path)
        for sel in ("#place-toggle", "#backup-import"):
            uses = [i for i, e in enumerate(log) if sel in repr(e[1:])]
            assert uses, f"run never touched {sel}"
            for k in uses:
                tab, nav = _last_before(log, k, _is_settings_tab), _last_before(log, k, _is_nav)
                assert tab > nav, f"{sel} at {k}: no Settings tab click since the last navigation"
