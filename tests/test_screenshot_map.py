# Covers: MEM-076
# Requirement: scripts/screenshot_map.py screenshots the Kendall basemap design preview
# (docs/design/map/preview.html) served from the repo root under the app CSP: its CSP constant is the
# app policy and its MIME map serves .js/.json/.pbf/.pmtiles with the right types; shot_plan(origin)
# orders 4 shots widths-outer (phone 375x812, wide 1000x800) x themes-inner (light, dark) with url
# "<origin>/docs/design/map/preview.html?theme=<theme>" and filename "map_<width>_<theme>.png";
# problems(report) is empty for a clean run (every shot idle with no errors or CSP violations, no foreign
# requests, the theme button flipping dark then light in the same document with a non-zero, unchanging
# marker count, no navigations, no flip errors or CSP violations) and gives one non-empty message per
# defect otherwise; main(argv, run) takes "<outdir> [--root DIR]" (root defaults to the repo root),
# prints the report JSON, then "ERR <msg>" per problem, then "shots=N problems=M" (exit 1 on any
# problem, else 0), exits 2 without running when the outdir is missing, and the module imports
# without playwright installed.
import copy
import importlib.util
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "scripts" / "screenshot_map.py"

ORIGIN = "http://127.0.0.1:8765"
PAGE = ORIGIN + "/docs/design/map/preview.html"
APP_CSP = (
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; img-src 'self' data: blob:; "
    "object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
)


def _load():
    spec = importlib.util.spec_from_file_location("screenshot_map_under_test", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _clean_report():
    shots = [
        {
            "file": f"out/map_{name}_{theme}.png",
            "state": "idle",
            "webgl": "ANGLE (test)",
            "attrib": "OpenStreetMap",
            "errors": [],
            "csp": [],
        }
        for name in ("phone", "wide")
        for theme in ("light", "dark")
    ]
    steps = [
        {"theme": "dark", "same_doc": True, "markers": 6, "style_layers": 1},
        {"theme": "light", "same_doc": True, "markers": 6, "style_layers": 1},
    ]
    return {
        "args": [],
        "shots": shots,
        "flip": {"steps": steps, "navigations": [], "errors": [], "csp": []},
        "foreign": [],
    }


class RecordingRun:
    def __init__(self, report):
        self.report = report
        self.calls = []

    def __call__(self, root, outdir):
        self.calls.append((root, outdir))
        return copy.deepcopy(self.report)


def _main(argv, run):
    try:
        return _load().main(argv, run=run)
    except SystemExit as exc:  # argparse-style exit is an equally valid exit code
        return exc.code


class TestConstants:
    def test_csp_is_the_app_policy(self):
        assert _load().CSP == APP_CSP

    @pytest.mark.parametrize(
        "ext, mime",
        [
            (".js", "text/javascript"),
            (".json", "application/json"),
            (".pbf", "application/x-protobuf"),
            (".pmtiles", "application/octet-stream"),
        ],
    )
    def test_mime_map_serves_map_assets_with_their_types(self, ext, mime):
        assert _load().MIME[ext] == mime


class TestShotPlan:
    def test_orders_widths_outer_themes_inner(self):
        plan = _load().shot_plan(ORIGIN)
        assert [tuple(s) for s in plan] == [
            (PAGE + "?theme=light", "map_phone_light.png", (375, 812)),
            (PAGE + "?theme=dark", "map_phone_dark.png", (375, 812)),
            (PAGE + "?theme=light", "map_wide_light.png", (1000, 800)),
            (PAGE + "?theme=dark", "map_wide_dark.png", (1000, 800)),
        ]

    def test_urls_are_rooted_at_the_given_origin(self):
        plan = _load().shot_plan("http://127.0.0.1:5000")
        assert [tuple(s)[0] for s in plan] == [
            "http://127.0.0.1:5000/docs/design/map/preview.html?theme=" + t
            for t in ("light", "dark", "light", "dark")
        ]


def _set_shot_state(r):
    r["shots"][2]["state"] = "error"


def _add_shot_error(r):
    r["shots"][1]["errors"] = ["pageerror TypeError: x is null"]


def _add_shot_csp(r):
    r["shots"][3]["csp"] = ["connect-src https://tiles.example.com/x.pbf"]


def _add_foreign(r):
    r["foreign"] = ["https://tiles.example.com/x.pbf"]


def _not_same_doc(r):
    r["flip"]["steps"][1]["same_doc"] = False


def _themes_not_toggling(r):
    r["flip"]["steps"][1]["theme"] = "dark"


def _markers_change(r):
    r["flip"]["steps"][1]["markers"] = 5


def _add_navigation(r):
    r["flip"]["navigations"] = [PAGE + "?theme=dark"]


def _add_flip_error(r):
    r["flip"]["errors"] = ["console.error boom"]


def _add_flip_csp(r):
    r["flip"]["csp"] = ["script-src https://cdn.example.com/maplibre.js"]


SINGLE_DEFECTS = [
    pytest.param(_set_shot_state, id="shot-not-idle"),
    pytest.param(_add_shot_error, id="shot-error"),
    pytest.param(_add_shot_csp, id="shot-csp"),
    pytest.param(_add_foreign, id="foreign-request"),
    pytest.param(_not_same_doc, id="flip-not-same-doc"),
    pytest.param(_themes_not_toggling, id="flip-themes-not-toggling"),
    pytest.param(_markers_change, id="flip-markers-change"),
    pytest.param(_add_navigation, id="flip-navigation"),
    pytest.param(_add_flip_error, id="flip-error"),
    pytest.param(_add_flip_csp, id="flip-csp"),
]


def _assert_messages(found):
    assert all(isinstance(m, str) and m.strip() for m in found), found


class TestProblems:
    def test_clean_report_has_no_problems(self):
        assert _load().problems(_clean_report()) == []

    @pytest.mark.parametrize("defect", SINGLE_DEFECTS)
    def test_each_defect_gives_one_message(self, defect):
        report = _clean_report()
        defect(report)
        found = _load().problems(report)
        assert len(found) == 1, found
        _assert_messages(found)

    def test_zero_markers_is_a_problem_even_when_unchanged(self):
        report = _clean_report()
        for step in report["flip"]["steps"]:
            step["markers"] = 0
        found = _load().problems(report)
        assert found
        _assert_messages(found)

    def test_flip_with_one_step_is_a_problem(self):
        report = _clean_report()
        report["flip"]["steps"] = report["flip"]["steps"][:1]
        found = _load().problems(report)
        assert found
        _assert_messages(found)

    def test_flip_themes_reversed_is_a_problem(self):
        report = _clean_report()
        report["flip"]["steps"][0]["theme"] = "light"
        report["flip"]["steps"][1]["theme"] = "dark"
        found = _load().problems(report)
        assert found
        _assert_messages(found)

    def test_every_defect_at_once_gives_a_message_each(self):
        report = _clean_report()
        for param in SINGLE_DEFECTS:
            param.values[0](report)
        found = _load().problems(report)
        assert len(found) >= len(SINGLE_DEFECTS), found
        _assert_messages(found)

    def test_problems_does_not_mutate_the_report(self):
        report = _clean_report()
        _add_foreign(report)
        before = copy.deepcopy(report)
        _load().problems(report)
        assert report == before


def _split_output(out):
    """(report JSON text, ERR lines, summary line) from main's stdout."""
    lines = out.splitlines()
    summary = lines[-1]
    first_err = len(lines) - 1
    while first_err > 0 and lines[first_err - 1].startswith("ERR "):
        first_err -= 1
    return "\n".join(lines[:first_err]), lines[first_err:-1], summary


class TestMain:
    def test_clean_run_prints_report_and_summary_exit_0(self, tmp_path, capsys):
        report = _clean_report()
        run = RecordingRun(report)
        assert _main([str(tmp_path)], run) == 0
        body, errs, summary = _split_output(capsys.readouterr().out)
        assert json.loads(body) == report
        assert errs == []
        assert summary == "shots=4 problems=0"

    def test_root_defaults_to_repo_root(self, tmp_path):
        run = RecordingRun(_clean_report())
        _main([str(tmp_path)], run)
        assert len(run.calls) == 1
        root, outdir = run.calls[0]
        assert Path(root).resolve() == REPO_ROOT
        assert Path(outdir).resolve() == tmp_path.resolve()

    def test_root_flag_overrides_root(self, tmp_path):
        run = RecordingRun(_clean_report())
        tree = tmp_path / "tree"
        tree.mkdir()
        out = tmp_path / "out"
        _main([str(out), "--root", str(tree)], run)
        root, outdir = run.calls[0]
        assert Path(root).resolve() == tree.resolve()
        assert Path(outdir).resolve() == out.resolve()

    def test_problems_print_err_lines_and_summary_exit_1(self, tmp_path, capsys):
        report = _clean_report()
        _add_foreign(report)
        _add_navigation(report)
        _set_shot_state(report)
        module = _load()
        expected = module.problems(copy.deepcopy(report))
        assert len(expected) == 3, expected
        try:
            code = module.main([str(tmp_path)], run=RecordingRun(report))
        except SystemExit as exc:
            code = exc.code
        assert code == 1
        body, errs, summary = _split_output(capsys.readouterr().out)
        assert json.loads(body) == report
        assert errs == ["ERR " + m for m in expected]
        assert summary == "shots=4 problems=3"

    @pytest.mark.parametrize("argv", [[], ["--root", "somewhere"]])
    def test_missing_outdir_exits_2_without_running(self, argv):
        run = RecordingRun(_clean_report())
        assert _main(argv, run) == 2
        assert run.calls == []


class TestImport:
    def test_module_imports_without_playwright_installed(self, monkeypatch):
        monkeypatch.setitem(sys.modules, "playwright", None)
        monkeypatch.setitem(sys.modules, "playwright.sync_api", None)
        module = _load()
        assert len(module.shot_plan(ORIGIN)) == 4
        assert module.problems(_clean_report()) == []
        assert callable(module.main)

    def test_importing_module_does_not_import_playwright(self, monkeypatch):
        monkeypatch.delitem(sys.modules, "playwright", raising=False)
        monkeypatch.delitem(sys.modules, "playwright.sync_api", raising=False)
        _load()
        assert "playwright" not in sys.modules
        assert "playwright.sync_api" not in sys.modules
