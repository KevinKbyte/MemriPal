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
        assert sorted(shots) == ["initial.png", "load_demo.png", "route_view.png"]
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
