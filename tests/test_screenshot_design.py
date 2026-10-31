# Covers: MEM-067
# Requirement: scripts/screenshot_design.py screenshots the route design preview: parse_width
# turns "name=WxH" into (name, (W, H)) and rejects malformed or non-positive specs; shot_plan
# orders shots widths-outer, themes-middle, screens-inner with url "?s=<screen>" (plus
# "&theme=dark" only for dark), filename "s<screen, commas as dashes>_<width>_<theme>.png" and the
# width's viewport; main(argv, run) defaults to 8 screens x 2 widths x 2 themes (32 shots), lets
# each repeatable flag replace its default in the given order, prints "ERR <msg>" per error and
# "shots=N errors=M" (exit 1 on errors, else 0), exits 2 without running for bad usage, and the
# module imports without playwright installed.
import importlib.util
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "scripts" / "screenshot_design.py"

BASE = "http://127.0.0.1:8765/preview.html"
DEFAULT_SCREENS = ["1", "2", "3", "4", "5,6", "7", "8", "9"]
DEFAULT_WIDTHS = [("phone", (375, 812)), ("wide", (1000, 800))]
DEFAULT_THEMES = ["light", "dark"]


def _load():
    spec = importlib.util.spec_from_file_location("screenshot_design_under_test", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _expected(screens, widths, themes):
    shots = []
    for name, viewport in widths:
        for theme in themes:
            for screen in screens:
                url = BASE + "?s=" + screen + ("&theme=dark" if theme == "dark" else "")
                shots.append((url, f"s{screen.replace(',', '-')}_{name}_{theme}.png", viewport))
    return shots


class RecordingRun:
    def __init__(self, errors):
        self.errors = errors
        self.calls = []

    def __call__(self, plan, outdir):
        self.calls.append((list(plan), outdir))
        return list(self.errors)


class TestParseWidth:
    @pytest.mark.parametrize(
        "text, expected",
        [("phone=375x812", ("phone", (375, 812))), ("wide=1000x800", ("wide", (1000, 800)))],
    )
    def test_parses_name_and_dimensions(self, text, expected):
        assert _load().parse_width(text) == expected

    @pytest.mark.parametrize(
        "text",
        [
            "",
            "=375x812",
            "phone375x812",
            "phone=",
            "phone=abcx812",
            "phone=375xabc",
            "phone=3.5x812",
            "phone=0x812",
            "phone=375x0",
            "phone=-375x812",
            "phone=375",
            "phone=375x812x2",
        ],
    )
    def test_rejects_malformed_spec(self, text):
        with pytest.raises(ValueError):
            _load().parse_width(text)


class TestShotPlan:
    def test_orders_widths_outer_themes_middle_screens_inner(self):
        widths = [("phone", (375, 812)), ("wide", (1000, 800))]
        plan = _load().shot_plan(BASE, ["1", "5,6"], widths, ["light", "dark"])
        assert [tuple(s) for s in plan] == [
            (BASE + "?s=1", "s1_phone_light.png", (375, 812)),
            (BASE + "?s=5,6", "s5-6_phone_light.png", (375, 812)),
            (BASE + "?s=1&theme=dark", "s1_phone_dark.png", (375, 812)),
            (BASE + "?s=5,6&theme=dark", "s5-6_phone_dark.png", (375, 812)),
            (BASE + "?s=1", "s1_wide_light.png", (1000, 800)),
            (BASE + "?s=5,6", "s5-6_wide_light.png", (1000, 800)),
            (BASE + "?s=1&theme=dark", "s1_wide_dark.png", (1000, 800)),
            (BASE + "?s=5,6&theme=dark", "s5-6_wide_dark.png", (1000, 800)),
        ]

    def test_shot_fields_are_named(self):
        shot = _load().shot_plan(BASE, ["5,6"], [("phone", (375, 812))], ["dark"])[0]
        assert shot.url == BASE + "?s=5,6&theme=dark"
        assert shot.filename == "s5-6_phone_dark.png"
        assert shot.viewport == (375, 812)

    def test_non_dark_theme_adds_no_theme_param(self):
        plan = _load().shot_plan(BASE, ["1"], [("phone", (375, 812))], ["sepia"])
        assert [tuple(s) for s in plan] == [(BASE + "?s=1", "s1_phone_sepia.png", (375, 812))]

    def test_no_screens_gives_empty_plan(self):
        assert list(_load().shot_plan(BASE, [], [("phone", (375, 812))], ["light"])) == []


def _main(argv, run):
    try:
        return _load().main(argv, run=run)
    except SystemExit as exc:  # argparse-style exit is an equally valid exit code
        return exc.code


class TestMain:
    def test_defaults_plan_32_shots_in_order(self, tmp_path):
        run = RecordingRun([])
        assert _main([BASE, str(tmp_path)], run) == 0
        assert len(run.calls) == 1
        plan, outdir = run.calls[0]
        assert Path(outdir) == tmp_path
        assert len(plan) == 32
        assert [tuple(s) for s in plan] == _expected(DEFAULT_SCREENS, DEFAULT_WIDTHS, DEFAULT_THEMES)

    def test_flags_replace_defaults_preserving_order(self, tmp_path):
        run = RecordingRun([])
        argv = [
            BASE,
            str(tmp_path),
            "--screen",
            "3",
            "--screen",
            "1",
            "--width",
            "tab=800x600",
            "--theme",
            "dark",
        ]
        assert _main(argv, run) == 0
        plan, _ = run.calls[0]
        assert [tuple(s) for s in plan] == [
            (BASE + "?s=3&theme=dark", "s3_tab_dark.png", (800, 600)),
            (BASE + "?s=1&theme=dark", "s1_tab_dark.png", (800, 600)),
        ]

    def test_repeated_width_flags_keep_given_order(self, tmp_path):
        run = RecordingRun([])
        argv = [
            BASE,
            str(tmp_path),
            "--screen",
            "2",
            "--width",
            "b=200x200",
            "--width",
            "a=100x100",
            "--theme",
            "light",
        ]
        assert _main(argv, run) == 0
        plan, _ = run.calls[0]
        assert [s.viewport for s in plan] == [(200, 200), (100, 100)]
        assert [s.filename for s in plan] == ["s2_b_light.png", "s2_a_light.png"]

    def test_unflagged_lists_keep_their_defaults(self, tmp_path):
        run = RecordingRun([])
        assert _main([BASE, str(tmp_path), "--theme", "light"], run) == 0
        plan, _ = run.calls[0]
        assert [tuple(s) for s in plan] == _expected(DEFAULT_SCREENS, DEFAULT_WIDTHS, ["light"])

    def test_errors_print_err_lines_and_summary_exit_1(self, tmp_path, capsys):
        run = RecordingRun(["boom", "TypeError: x is null"])
        assert _main([BASE, str(tmp_path)], run) == 1
        lines = capsys.readouterr().out.splitlines()
        assert lines[-3:] == ["ERR boom", "ERR TypeError: x is null", "shots=32 errors=2"]

    def test_no_errors_prints_summary_exit_0(self, tmp_path, capsys):
        assert _main([BASE, str(tmp_path), "--screen", "1"], RecordingRun([])) == 0
        lines = capsys.readouterr().out.splitlines()
        assert lines[-1] == "shots=4 errors=0"
        assert not any(line.startswith("ERR") for line in lines)

    @pytest.mark.parametrize(
        "argv",
        [
            [],
            [BASE],
            [BASE, "out", "extra"],
            [BASE, "out", "--width", "bad"],
            [BASE, "out", "--width", "phone=0x812"],
            [BASE, "out", "--theme", "sepia"],
        ],
    )
    def test_bad_usage_exits_2_without_running(self, argv, capsys):
        run = RecordingRun([])
        assert _main(argv, run) == 2
        assert run.calls == []
        assert "usage" in capsys.readouterr().err.lower()


class TestImport:
    def test_module_imports_without_playwright_installed(self, monkeypatch):
        monkeypatch.setitem(sys.modules, "playwright", None)
        monkeypatch.setitem(sys.modules, "playwright.sync_api", None)
        module = _load()
        assert module.parse_width("phone=375x812") == ("phone", (375, 812))
        assert callable(module.main)

    def test_importing_module_does_not_import_playwright(self, monkeypatch):
        monkeypatch.delitem(sys.modules, "playwright", raising=False)
        monkeypatch.delitem(sys.modules, "playwright.sync_api", raising=False)
        _load()
        assert "playwright" not in sys.modules
        assert "playwright.sync_api" not in sys.modules
