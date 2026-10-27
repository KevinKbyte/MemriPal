# Covers: MEM-017
# Requirement: scripts/screenshot_ui.py screenshots the upload UI before and after "Load demo"
# and fails (exit 1) on any page or console error except the known /favicon.ico 404, which is
# dropped by significant_errors whatever its query string; it exits 0 when only that favicon
# error (or nothing) was seen, exits 2 with a usage line on stderr for a wrong argument count
# without launching a browser, and the module imports even when playwright is not installed.
import importlib.util
import sys
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
