# Covers: MEM-081
# Requirement: scripts/screenshot_review_design.py screenshots the review design preview
# (default docs url http://localhost:8765/docs/design/review/preview.html): parse_width turns
# "name=WxH" into (name, (W, H)) and rejects a missing name or "=", malformed dims and non-positive
# dims; shot_plan(url, widths, themes) orders shots widths-outer, themes-inner, each a named
# Shot(url, filename, viewport, color_scheme) with the url unchanged (theme is emulated through
# color_scheme, never a query param) and filename "review-<widthname>-<theme>.png"; main(argv, run)
# defaults to widths 375=375x812 and 1000=1000x800 and themes light, dark (4 shots), lets each
# repeatable flag replace its default in the given order, prints "ERR <msg>" per error then
# "shots=N errors=M" (exit 1 on errors, else 0) and exits 2 without running on bad usage; the
# module imports without playwright installed. run(plan, outdir) launches Chrome (channel "chrome",
# "--disable-gpu" in args) and, per shot, renders at the shot's viewport with its color scheme and
# prefers-reduced-motion: reduce, loads the url with networkidle, then grows the viewport height to
# the document's scrollHeight (width unchanged) and takes a viewport screenshot -- never full_page,
# because Playwright full_page pins position:sticky elements over the wrong content; page errors,
# console errors and every planned PNG missing afterwards ("missing <filename>") are returned.
import importlib.util
import sys
import types
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "scripts" / "screenshot_review_design.py"

URL = "http://localhost:8765/docs/design/review/preview.html"
DEFAULT_WIDTHS = [("375", (375, 812)), ("1000", (1000, 800))]
DEFAULT_THEMES = ["light", "dark"]
SCROLL_HEIGHT = 2400
PNG = b"\x89PNG\r\n\x1a\n"


def _load():
    spec = importlib.util.spec_from_file_location("screenshot_review_design_under_test", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _expected(url, widths, themes):
    return [
        (url, f"review-{name}-{theme}.png", viewport, theme) for name, viewport in widths for theme in themes
    ]


class RecordingRun:
    def __init__(self, errors):
        self.errors = errors
        self.calls = []

    def __call__(self, plan, outdir):
        self.calls.append((list(plan), outdir))
        return list(self.errors)


def _main(argv, run):
    try:
        return _load().main(argv, run=run)
    except SystemExit as exc:  # argparse-style exit is an equally valid exit code
        return exc.code


class TestParseWidth:
    @pytest.mark.parametrize(
        "text, expected",
        [("375=375x812", ("375", (375, 812))), ("wide=1000x800", ("wide", (1000, 800)))],
    )
    def test_parses_name_and_dimensions(self, text, expected):
        assert _load().parse_width(text) == expected

    @pytest.mark.parametrize(
        "text",
        [
            "",
            "=375x812",
            "375375x812",
            "375=",
            "375=abcx812",
            "375=375xabc",
            "375=3.5x812",
            "375=0x812",
            "375=375x0",
            "375=-375x812",
            "375=375",
            "375=375x812x2",
        ],
    )
    def test_rejects_malformed_spec(self, text):
        with pytest.raises(ValueError):
            _load().parse_width(text)


class TestShotPlan:
    def test_orders_widths_outer_themes_inner(self):
        plan = _load().shot_plan(URL, DEFAULT_WIDTHS, DEFAULT_THEMES)
        assert [tuple(s) for s in plan] == [
            (URL, "review-375-light.png", (375, 812), "light"),
            (URL, "review-375-dark.png", (375, 812), "dark"),
            (URL, "review-1000-light.png", (1000, 800), "light"),
            (URL, "review-1000-dark.png", (1000, 800), "dark"),
        ]

    def test_shot_fields_are_named(self):
        shot = _load().shot_plan(URL, [("tab", (800, 600))], ["dark"])[0]
        assert shot.url == URL
        assert shot.filename == "review-tab-dark.png"
        assert shot.viewport == (800, 600)
        assert shot.color_scheme == "dark"

    def test_theme_never_changes_the_url(self):
        url = "file:///C:/tmp/tree/docs/design/review/preview.html"
        plan = _load().shot_plan(url, DEFAULT_WIDTHS, DEFAULT_THEMES)
        assert [s.url for s in plan] == [url] * 4

    def test_no_widths_gives_empty_plan(self):
        assert list(_load().shot_plan(URL, [], DEFAULT_THEMES)) == []

    def test_no_themes_gives_empty_plan(self):
        assert list(_load().shot_plan(URL, DEFAULT_WIDTHS, [])) == []


class TestMain:
    def test_defaults_plan_4_shots_in_order(self, tmp_path):
        run = RecordingRun([])
        assert _main([URL, str(tmp_path)], run) == 0
        assert len(run.calls) == 1
        plan, outdir = run.calls[0]
        assert Path(outdir) == tmp_path
        assert [tuple(s) for s in plan] == _expected(URL, DEFAULT_WIDTHS, DEFAULT_THEMES)

    def test_flags_replace_defaults_preserving_order(self, tmp_path):
        run = RecordingRun([])
        argv = [
            URL,
            str(tmp_path),
            "--width",
            "b=200x300",
            "--width",
            "a=100x150",
            "--theme",
            "dark",
            "--theme",
            "light",
        ]
        assert _main(argv, run) == 0
        plan, _ = run.calls[0]
        assert [tuple(s) for s in plan] == [
            (URL, "review-b-dark.png", (200, 300), "dark"),
            (URL, "review-b-light.png", (200, 300), "light"),
            (URL, "review-a-dark.png", (100, 150), "dark"),
            (URL, "review-a-light.png", (100, 150), "light"),
        ]

    def test_unflagged_widths_keep_their_defaults(self, tmp_path):
        run = RecordingRun([])
        assert _main([URL, str(tmp_path), "--theme", "dark"], run) == 0
        plan, _ = run.calls[0]
        assert [tuple(s) for s in plan] == _expected(URL, DEFAULT_WIDTHS, ["dark"])

    def test_unflagged_themes_keep_their_defaults(self, tmp_path):
        run = RecordingRun([])
        assert _main([URL, str(tmp_path), "--width", "tab=800x600"], run) == 0
        plan, _ = run.calls[0]
        assert [tuple(s) for s in plan] == _expected(URL, [("tab", (800, 600))], DEFAULT_THEMES)

    def test_errors_print_err_lines_and_summary_exit_1(self, tmp_path, capsys):
        run = RecordingRun(["boom", "missing review-375-dark.png"])
        assert _main([URL, str(tmp_path)], run) == 1
        lines = capsys.readouterr().out.splitlines()
        assert lines[-3:] == ["ERR boom", "ERR missing review-375-dark.png", "shots=4 errors=2"]

    def test_no_errors_prints_summary_exit_0(self, tmp_path, capsys):
        assert _main([URL, str(tmp_path), "--theme", "light"], RecordingRun([])) == 0
        lines = capsys.readouterr().out.splitlines()
        assert lines[-1] == "shots=2 errors=0"
        assert not any(line.startswith("ERR") for line in lines)

    @pytest.mark.parametrize(
        "argv",
        [
            [],
            [URL],
            [URL, "out", "extra"],
            [URL, "out", "--width", "bad"],
            [URL, "out", "--width", "375=0x812"],
            [URL, "out", "--theme", "sepia"],
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
        assert module.parse_width("375=375x812") == ("375", (375, 812))
        assert callable(module.main)
        assert callable(module.run)

    def test_importing_module_does_not_import_playwright(self, monkeypatch):
        monkeypatch.delitem(sys.modules, "playwright", raising=False)
        monkeypatch.delitem(sys.modules, "playwright.sync_api", raising=False)
        _load()
        assert "playwright" not in sys.modules
        assert "playwright.sync_api" not in sys.modules


# --- fake playwright for run() -------------------------------------------------------------------

COLOR_SCHEMES = ("light", "dark", "no-preference", "null", None)
REDUCED_MOTION_VALUES = ("reduce", "no-preference", "null", None)


def _checked(value, allowed, what):
    # Playwright rejects values outside its enum; so does the fake.
    if value not in allowed:
        raise ValueError(f"{what}: unsupported value {value!r}")
    return value


class _Recorder:
    """Shared log across every fake browser object of one run."""

    def __init__(self, page_errors=None, console=None, skip_write=()):
        self.launches = []
        self.gotos = []
        self.measures = []
        self.shots = []
        self.page_errors = page_errors or {}
        self.console = console or {}
        self.skip_write = set(skip_write)


class _Console:
    def __init__(self, type_, text):
        self.type = type_
        self.text = text


class _FakePage:
    def __init__(self, rec, viewport=None, color_scheme=None, reduced_motion=None):
        self.rec = rec
        self.handlers = {}
        self.url = None
        self.viewport = (viewport["width"], viewport["height"]) if viewport else (1280, 720)
        self.color_scheme = _checked(color_scheme, COLOR_SCHEMES, "color_scheme")
        self.reduced_motion = _checked(reduced_motion, REDUCED_MOTION_VALUES, "reduced_motion")

    @property
    def viewport_size(self):
        return {"width": self.viewport[0], "height": self.viewport[1]}

    def on(self, event, handler):
        self.handlers.setdefault(event, []).append(handler)

    def _fire(self, event, payload):
        for handler in self.handlers.get(event, []):
            handler(payload)

    def set_viewport_size(self, size):
        self.viewport = (size["width"], size["height"])

    def emulate_media(self, **kwargs):
        if "color_scheme" in kwargs:
            self.color_scheme = _checked(kwargs["color_scheme"], COLOR_SCHEMES, "color_scheme")
        if "reduced_motion" in kwargs:
            self.reduced_motion = _checked(kwargs["reduced_motion"], REDUCED_MOTION_VALUES, "reduced_motion")

    def goto(self, url, **kwargs):
        self.url = url
        self.rec.gotos.append({"url": url, "wait_until": kwargs.get("wait_until"), "viewport": self.viewport})
        for message in self.rec.page_errors.get(url, []):
            self._fire("pageerror", RuntimeError(message))
        for type_, text in self.rec.console.get(url, []):
            self._fire("console", _Console(type_, text))

    def wait_for_timeout(self, ms):
        pass

    def wait_for_load_state(self, *args, **kwargs):
        pass

    def evaluate(self, expression, arg=None):
        if "scrollHeight" in expression:
            self.rec.measures.append({"url": self.url, "viewport": self.viewport})
            return SCROLL_HEIGHT
        return None

    def screenshot(self, path=None, **kwargs):
        self.rec.shots.append(
            {
                "name": Path(path).name,
                "url": self.url,
                "viewport": self.viewport,
                "color_scheme": self.color_scheme,
                "reduced_motion": self.reduced_motion,
                "full_page": kwargs.get("full_page"),
            }
        )
        if Path(path).name not in self.rec.skip_write:
            Path(path).parent.mkdir(parents=True, exist_ok=True)
            Path(path).write_bytes(PNG + Path(path).name.encode("ascii"))
        return b""

    def close(self):
        pass


class _FakeContext:
    def __init__(self, rec, **kwargs):
        self.rec = rec
        self.kwargs = kwargs

    def new_page(self):
        return _FakePage(
            self.rec,
            self.kwargs.get("viewport"),
            self.kwargs.get("color_scheme"),
            self.kwargs.get("reduced_motion"),
        )

    def close(self):
        pass


class _FakeBrowser:
    def __init__(self, rec):
        self.rec = rec

    def new_page(self, **kwargs):
        return _FakeContext(self.rec, **kwargs).new_page()

    def new_context(self, **kwargs):
        return _FakeContext(self.rec, **kwargs)

    def close(self):
        pass


class _FakePlaywright:
    def __init__(self, rec):
        self.rec = rec
        self.chromium = types.SimpleNamespace(launch=self._launch)

    def _launch(self, **kwargs):
        self.rec.launches.append(kwargs)
        return _FakeBrowser(self.rec)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _install_fake_playwright(monkeypatch, **recorder_kwargs):
    rec = _Recorder(**recorder_kwargs)
    sync_api = types.ModuleType("playwright.sync_api")
    sync_api.sync_playwright = lambda: _FakePlaywright(rec)
    monkeypatch.setitem(sys.modules, "playwright", types.ModuleType("playwright"))
    monkeypatch.setitem(sys.modules, "playwright.sync_api", sync_api)
    return rec


def _default_plan(module):
    return module.shot_plan(URL, DEFAULT_WIDTHS, DEFAULT_THEMES)


class TestRun:
    def test_happy_path_writes_every_png_and_reports_no_errors(self, tmp_path, monkeypatch):
        rec = _install_fake_playwright(monkeypatch)
        module = _load()
        plan = _default_plan(module)
        out = tmp_path / "shots"
        assert module.run(plan, str(out)) == []
        assert sorted(p.name for p in out.glob("*.png")) == sorted(s.filename for s in plan)
        assert [s["name"] for s in rec.shots] == [s.filename for s in plan]

    def test_launches_chrome_channel_with_gpu_disabled(self, tmp_path, monkeypatch):
        rec = _install_fake_playwright(monkeypatch)
        module = _load()
        module.run(_default_plan(module), str(tmp_path / "shots"))
        assert rec.launches, "chromium was never launched"
        for launch in rec.launches:
            assert launch.get("channel") == "chrome"
            assert "--disable-gpu" in (launch.get("args") or [])

    def test_loads_each_url_with_networkidle_at_the_shot_viewport(self, tmp_path, monkeypatch):
        rec = _install_fake_playwright(monkeypatch)
        module = _load()
        plan = _default_plan(module)
        module.run(plan, str(tmp_path / "shots"))
        assert [(g["url"], g["wait_until"], g["viewport"]) for g in rec.gotos] == [
            (s.url, "networkidle", s.viewport) for s in plan
        ]

    def test_scroll_height_is_measured_at_the_shot_viewport(self, tmp_path, monkeypatch):
        rec = _install_fake_playwright(monkeypatch)
        module = _load()
        plan = _default_plan(module)
        module.run(plan, str(tmp_path / "shots"))
        assert [m["viewport"] for m in rec.measures] == [s.viewport for s in plan]

    def test_viewport_grows_to_scroll_height_before_each_screenshot(self, tmp_path, monkeypatch):
        rec = _install_fake_playwright(monkeypatch)
        module = _load()
        plan = _default_plan(module)
        module.run(plan, str(tmp_path / "shots"))
        assert [(s["name"], s["viewport"]) for s in rec.shots] == [
            (s.filename, (s.viewport[0], SCROLL_HEIGHT)) for s in plan
        ]

    def test_screenshots_never_use_full_page(self, tmp_path, monkeypatch):
        rec = _install_fake_playwright(monkeypatch)
        module = _load()
        module.run(_default_plan(module), str(tmp_path / "shots"))
        assert len(rec.shots) == 4
        assert [s["name"] for s in rec.shots if s["full_page"]] == []

    def test_each_screenshot_emulates_the_shot_color_scheme(self, tmp_path, monkeypatch):
        rec = _install_fake_playwright(monkeypatch)
        module = _load()
        plan = _default_plan(module)
        module.run(plan, str(tmp_path / "shots"))
        assert [(s["name"], s["color_scheme"]) for s in rec.shots] == [
            (s.filename, s.color_scheme) for s in plan
        ]

    def test_each_screenshot_emulates_reduced_motion(self, tmp_path, monkeypatch):
        rec = _install_fake_playwright(monkeypatch)
        module = _load()
        module.run(_default_plan(module), str(tmp_path / "shots"))
        assert [s["reduced_motion"] for s in rec.shots] == ["reduce"] * 4

    def test_missing_png_is_reported(self, tmp_path, monkeypatch):
        _install_fake_playwright(monkeypatch, skip_write={"review-1000-dark.png"})
        module = _load()
        errors = module.run(_default_plan(module), str(tmp_path / "shots"))
        assert errors == ["missing review-1000-dark.png"]

    def test_page_and_console_errors_are_reported(self, tmp_path, monkeypatch):
        _install_fake_playwright(
            monkeypatch,
            page_errors={URL: ["TypeError: x is null"]},
            console={URL: [("error", "Failed to load resource"), ("log", "hello")]},
        )
        module = _load()
        plan = module.shot_plan(URL, [("tab", (800, 600))], ["light"])
        errors = module.run(plan, str(tmp_path / "shots"))
        assert any("TypeError: x is null" in e for e in errors), errors
        assert any("Failed to load resource" in e for e in errors), errors
        assert not any("hello" in e for e in errors), errors
