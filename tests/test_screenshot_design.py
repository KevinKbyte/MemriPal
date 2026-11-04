# Covers: MEM-067
# Requirement: scripts/screenshot_design.py screenshots the route design preview: parse_width
# turns "name=WxH" into (name, (W, H)) and rejects malformed or non-positive specs; shot_plan
# orders shots widths-outer, themes-middle, screens-inner with url "<page>?s=<screen>" (plus
# "&theme=dark" only for dark) where base_url is the preview.html URL and page is preview.html for
# screens 1-4 and its sibling preview-2.html for screens 5-9 (incl. "5,6"), filename
# "s<screen, commas as dashes>_<width>_<theme>.png" (unchanged by the page) and the width's viewport;
# main(argv, run) defaults to 8 screens x 2 widths x 2 themes (32 shots), lets each
# repeatable flag replace its default in the given order, prints "ERR <msg>" per error and "shots=N errors=M"
# (exit 1 on errors, else 0), exits 2 without running for bad usage, and the module
# imports without playwright installed. Every screenshot run takes is rendered with
# prefers-reduced-motion: reduce (ADR 0036 amendment), so animated pages shoot the same bytes each run,
# and run launches Chromium with --disable-gpu in `args` (ADR 0036 amendment, option G) because GPU
# raster makes bytes drift between runs: two runs of one plan write byte-identical PNGs.
# Console errors count toward errors=N except the browser's automatic favicon request: a preview
# page with no <link rel=icon> makes the browser fetch /favicon.ico, which python http.server
# 404s ("Failed to load resource: ... 404 (File not found)" located at <origin>/favicon.ico);
# is_ignored_console_error(text, url) is True for exactly that message, so it is not counted,
# while any other 404 (a missing stylesheet, a non-root favicon.ico), a non-404 favicon failure
# or a JS error still counts.
import importlib.util
import sys
import types
from pathlib import Path

import pytest
from shooter_support import (
    REDUCE_BG,
    REDUCED_MOTION_HTML,
    body_bg,
    centre_rgb,
    install_fake_playwright,
    is_reduce_bg,
    require_chrome,
)

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "scripts" / "screenshot_design.py"

BASE = "http://127.0.0.1:8765/preview.html"
BASE_2 = "http://127.0.0.1:8765/preview-2.html"
PAGE_1_SCREENS = {"1", "2", "3", "4"}
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
                page = BASE if screen in PAGE_1_SCREENS else BASE_2
                url = page + "?s=" + screen + ("&theme=dark" if theme == "dark" else "")
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
            (BASE_2 + "?s=5,6", "s5-6_phone_light.png", (375, 812)),
            (BASE + "?s=1&theme=dark", "s1_phone_dark.png", (375, 812)),
            (BASE_2 + "?s=5,6&theme=dark", "s5-6_phone_dark.png", (375, 812)),
            (BASE + "?s=1", "s1_wide_light.png", (1000, 800)),
            (BASE_2 + "?s=5,6", "s5-6_wide_light.png", (1000, 800)),
            (BASE + "?s=1&theme=dark", "s1_wide_dark.png", (1000, 800)),
            (BASE_2 + "?s=5,6&theme=dark", "s5-6_wide_dark.png", (1000, 800)),
        ]

    @pytest.mark.parametrize(
        "screen, page",
        [("1", BASE), ("2", BASE), ("3", BASE), ("4", BASE)]
        + [(s, BASE_2) for s in ("5", "5,6", "6", "7", "8", "9")],
    )
    def test_screen_renders_from_its_page(self, screen, page):
        shot = _load().shot_plan(BASE, [screen], [("phone", (375, 812))], ["light"])[0]
        assert shot.url == page + "?s=" + screen
        assert shot.filename == f"s{screen.replace(',', '-')}_phone_light.png"

    def test_page_2_is_the_sibling_of_a_file_url_base(self):
        base = "file:///C:/tmp/tree/docs/design/route/preview.html"
        plan = _load().shot_plan(base, ["4", "7"], [("phone", (375, 812))], ["light"])
        assert [s.url for s in plan] == [
            base + "?s=4",
            "file:///C:/tmp/tree/docs/design/route/preview-2.html?s=7",
        ]

    def test_shot_fields_are_named(self):
        shot = _load().shot_plan(BASE, ["5,6"], [("phone", (375, 812))], ["dark"])[0]
        assert shot.url == BASE_2 + "?s=5,6&theme=dark"
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


def _route_pages(tmp_path):
    """preview.html + preview-2.html fixture pages; returns preview.html's file URL."""
    route = tmp_path / "route"
    route.mkdir()
    for name in ("preview.html", "preview-2.html"):
        (route / name).write_text(REDUCED_MOTION_HTML, encoding="utf-8")
    return (route / "preview.html").as_uri()


class TestRunEmulatesReducedMotion:
    def test_every_png_is_rendered_with_prefers_reduced_motion_reduce(self, tmp_path, monkeypatch):
        install_fake_playwright(monkeypatch)
        module = _load()
        plan = module.shot_plan(_route_pages(tmp_path), DEFAULT_SCREENS, DEFAULT_WIDTHS, DEFAULT_THEMES)
        out = tmp_path / "shots"
        assert module.run(plan, str(out)) == []
        motion = [s.filename for s in plan if body_bg(out / s.filename) != REDUCE_BG]
        assert not motion, (
            f"{len(motion)} of {len(plan)} shots not under prefers-reduced-motion: reduce: {motion[:4]}"
        )


class TestRunIsByteDeterministic:
    def test_two_runs_of_one_plan_shoot_byte_identical_pngs(self, tmp_path, monkeypatch):
        install_fake_playwright(monkeypatch, gpu_raster_noise=True)
        module = _load()
        plan = module.shot_plan(_route_pages(tmp_path), DEFAULT_SCREENS, DEFAULT_WIDTHS, DEFAULT_THEMES)
        first, second = tmp_path / "shots-1", tmp_path / "shots-2"
        assert module.run(plan, str(first)) == []
        assert module.run(plan, str(second)) == []
        names = sorted(p.name for p in first.glob("*.png"))
        assert len(names) == len(plan) == 32, names
        assert sorted(p.name for p in second.glob("*.png")) == names
        drift = [n for n in names if (first / n).read_bytes() != (second / n).read_bytes()]
        assert not drift, (
            f"{len(drift)} of {len(names)} shots differ between runs "
            f"(browser not launched with --disable-gpu): {drift[:4]}"
        )


class TestRunReducedMotionRealBrowser:
    def test_real_chrome_shot_shows_the_reduced_motion_background(self, tmp_path):
        require_chrome()
        module = _load()
        plan = module.shot_plan(_route_pages(tmp_path), ["1"], [("tiny", (200, 200))], ["light"])
        out = tmp_path / "shots"
        assert module.run(plan, str(out)) == []
        rgb = centre_rgb(out / "s1_tiny_light.png")
        assert is_reduce_bg(rgb), f"centre pixel {rgb}: not rendered under prefers-reduced-motion: reduce"


ORIGIN = "http://127.0.0.1:8765"
FAVICON_404 = "Failed to load resource: the server responded with a status of 404 (File not found)"
FAVICON_500 = "Failed to load resource: the server responded with a status of 500 (Internal Server Error)"
JS_ERROR = "Uncaught TypeError: Cannot read properties of null (reading 'x')"


class TestIsIgnoredConsoleError:
    def test_root_favicon_404_is_ignored(self):
        assert _load().is_ignored_console_error(FAVICON_404, ORIGIN + "/favicon.ico") is True

    @pytest.mark.parametrize(
        "text, url",
        [
            (FAVICON_404, ORIGIN + "/static/x.css"),
            (FAVICON_404, ORIGIN + "/docs/design/route/missing.png"),
            (FAVICON_404, ORIGIN + "/static/favicon.ico"),
            (FAVICON_404, ORIGIN + "/favicon.ico.css"),
            (FAVICON_404, ORIGIN + "/not-favicon.ico"),
            (FAVICON_500, ORIGIN + "/favicon.ico"),
            (JS_ERROR, ORIGIN + "/docs/design/route/preview.html"),
            (JS_ERROR, ORIGIN + "/favicon.ico"),
            ("", ORIGIN + "/favicon.ico"),
            (FAVICON_404, ""),
            ("", ""),
        ],
    )
    def test_every_other_console_error_still_counts(self, text, url):
        assert _load().is_ignored_console_error(text, url) is False


def _emit_console_on_goto(monkeypatch, messages_for):
    """Make the fake page fire console messages (Playwright ConsoleMessage shape) on each goto."""
    from shooter_support import FakePage

    original_goto = FakePage.goto

    def on(self, event, handler):
        self.__dict__.setdefault("_handlers", []).append((event, handler))

    def goto(self, url, **kwargs):
        original_goto(self, url, **kwargs)
        for text, res_url in messages_for(url):
            msg = types.SimpleNamespace(
                type="error", text=text, location={"url": res_url, "lineNumber": 0, "columnNumber": 0}
            )
            for event, handler in self.__dict__.get("_handlers", []):
                if event == "console":
                    handler(msg)

    monkeypatch.setattr(FakePage, "on", on)
    monkeypatch.setattr(FakePage, "goto", goto)


class TestRunConsoleErrorFilter:
    def test_favicon_404_alone_reports_no_errors(self, tmp_path, monkeypatch):
        install_fake_playwright(monkeypatch)
        _emit_console_on_goto(monkeypatch, lambda url: [(FAVICON_404, ORIGIN + "/favicon.ico")])
        module = _load()
        plan = module.shot_plan(_route_pages(tmp_path), ["1", "7"], [("phone", (375, 812))], ["light"])
        assert module.run(plan, str(tmp_path / "shots")) == []

    def test_missing_stylesheet_404_still_counts_beside_favicon(self, tmp_path, monkeypatch):
        install_fake_playwright(monkeypatch)
        _emit_console_on_goto(
            monkeypatch,
            lambda url: [(FAVICON_404, ORIGIN + "/favicon.ico"), (FAVICON_404, ORIGIN + "/static/x.css")],
        )
        module = _load()
        plan = module.shot_plan(_route_pages(tmp_path), ["1"], [("phone", (375, 812))], ["light"])
        assert module.run(plan, str(tmp_path / "shots")) == [FAVICON_404]

    def test_js_console_error_still_counts(self, tmp_path, monkeypatch):
        install_fake_playwright(monkeypatch)
        _emit_console_on_goto(monkeypatch, lambda url: [(JS_ERROR, url)])
        module = _load()
        plan = module.shot_plan(_route_pages(tmp_path), ["1"], [("phone", (375, 812))], ["light"])
        assert module.run(plan, str(tmp_path / "shots")) == [JS_ERROR]
