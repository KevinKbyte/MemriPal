# Covers: MEM-067
# Requirement: the design gate's route CSS is every stylesheet that docs/design/route/preview.html
# links with `<link rel="stylesheet" href=...>` at the tip whose href is relative and stays inside
# docs/design/route/ (hrefs starting with ../, / or a scheme are ignored), read from git at the tip
# and concatenated in link order; check_route_css.check runs on that concatenation and the
# rendered-DOM name check uses selectors from every linked file. A linked file missing at the tip
# is a gate problem naming that file (exit 1). The route design is split into pages: screens 1-4
# render from preview.html and 5-9 from preview-2.html; real_shoot renders through
# screenshot_design.shot_plan, and a page absent at a rev (e.g. a merge-base older than
# preview-2.html) yields a "<page> absent at <rev>" error and skips only that page's shots.
# The gate also shoots the map-first home docs/design/route/map-shell.html: design_gate.gate_plan
# (route dir URL) is the 32 preview shots (unchanged names and order) followed by 16 map shots,
# screens closed/open/landmark/hidden at map-shell.html?s=<screen> (+ &theme=dark) for each
# width (phone, wide) and theme (light, dark), named s<screen>_<width>_<theme>.png. map-shell.html
# and every file it loads are inside RENDER_PATHS; map-shell.html absent at a rev skips only its
# 16 shots; a changed map shot needs an approval like any other shot. Every screenshot real_shoot
# takes is rendered with prefers-reduced-motion: reduce (ADR 0036 amendment), so an infinite CSS
# animation or a JS tween cannot make a shot's sha256 drift between runs at one tip. real_shoot
# launches Chromium with --disable-gpu in `args` (ADR 0036 amendment, option G): GPU raster makes
# bytes drift between runs, so two runs at one rev must write byte-identical PNGs.
import importlib.machinery
import importlib.util
import posixpath
import re
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
from test_design_gate import (
    CSS,
    GIT,
    PREVIEW_PATH,
    FakeShooter,
    _fails,
    _gate,
    _load,
    _make_repo,
)

pytestmark = pytest.mark.skipif(not GIT, reason="design_gate test needs git")

ROUTE_DIR = "docs/design/route/"
PREVIEW_2_PATH = ROUTE_DIR + "preview-2.html"
DRAWER_PATH = ROUTE_DIR + "map-drawer.css"
MAP_SHELL_PATH = ROUTE_DIR + "map-shell.html"


def _preview(*hrefs: str) -> str:
    links = "".join(f'<link rel="stylesheet" href="{h}">\n' for h in hrefs)
    return "<!doctype html>\n" + links


class TestRouteCssFollowsPreviewLinks:
    def test_selector_only_in_second_linked_file_absent_from_dom_fails(self, capsys, tmp_path):
        repo = _make_repo(tmp_path)
        tip = repo.commit(
            {
                PREVIEW_PATH: _preview("../../../static/style.css", "route.css", "map-drawer.css"),
                DRAWER_PATH: "#status { margin: 0; }\n",
            },
            "link drawer css",
        )
        code, lines = _gate(capsys, tmp_path, repo, FakeShooter(tip))
        assert code == 1, lines
        assert any("#status not in rendered DOM" in line for line in _fails(lines)), lines

    def test_css_problem_in_second_linked_file_fails(self, capsys, tmp_path):
        repo = _make_repo(tmp_path)
        tip = repo.commit(
            {
                PREVIEW_PATH: _preview("route.css", "map-drawer.css"),
                DRAWER_PATH: ".assoc-card { color: red; }\n",
            },
            "drawer css names a colour",
        )
        code, lines = _gate(capsys, tmp_path, repo, FakeShooter(tip))
        assert code == 1, lines
        assert any("named colour" in line for line in _fails(lines)), lines

    def test_unlinked_route_css_is_not_checked(self, capsys, tmp_path):
        repo = _make_repo(tmp_path)
        tip = repo.commit(
            {
                PREVIEW_PATH: _preview("map-shell.css"),
                ROUTE_DIR + "map-shell.css": CSS,
                ROUTE_DIR + "route.css": CSS + ".assoc-card { color: red; }\n",
            },
            "preview links map-shell.css only",
        )
        code, lines = _gate(capsys, tmp_path, repo, FakeShooter(tip))
        assert code == 0, lines
        assert lines[-1] == "OK"

    def test_linked_file_missing_at_tip_fails_naming_it(self, capsys, tmp_path):
        repo = _make_repo(tmp_path)
        tip = repo.commit({PREVIEW_PATH: _preview("route.css", "ghost-sheet.css")}, "dangling link")
        code, lines = _gate(capsys, tmp_path, repo, FakeShooter(tip))
        assert code == 1, lines
        assert any("ghost-sheet.css" in line for line in _fails(lines)), lines

    def test_hrefs_leaving_the_route_dir_are_ignored(self, capsys, tmp_path):
        repo = _make_repo(tmp_path)
        tip = repo.commit(
            {
                PREVIEW_PATH: _preview(
                    "../../../static/style.css",
                    "../other/elsewhere.css",
                    "/static/rooted.css",
                    "https://cdn.example.invalid/remote.css",
                    "route.css",
                )
            },
            "outside links",
        )
        code, lines = _gate(capsys, tmp_path, repo, FakeShooter(tip))
        assert code == 0, lines
        assert lines[-1] == "OK"


@pytest.fixture
def fake_browser(monkeypatch, tmp_path):
    """Stand-in playwright + axe modules; yields the list of page URLs actually loaded."""
    return _install_fake_browser(monkeypatch, tmp_path)


@pytest.fixture
def fake_gpu_browser(monkeypatch, tmp_path):
    """fake_browser whose GPU-on launches shoot non-repeating bytes (models GPU raster)."""
    return _install_fake_browser(monkeypatch, tmp_path, gpu_raster_noise=True)


def _install_fake_browser(monkeypatch, tmp_path, gpu_raster_noise=False):
    visited = install_fake_playwright(monkeypatch, gpu_raster_noise=gpu_raster_noise)
    axe_dir = tmp_path / "axe_pkg"
    axe_dir.mkdir()
    (axe_dir / "axe.min.js").write_text("/* axe */\n", encoding="utf-8")
    axe = types.ModuleType("axe_playwright_python")
    axe.__spec__ = importlib.machinery.ModuleSpec(
        "axe_playwright_python", None, origin=str(axe_dir / "__init__.py")
    )
    monkeypatch.setitem(sys.modules, "axe_playwright_python", axe)
    return visited


def _page_repo(tmp_path, with_page_2: bool, with_map_shell: bool = False):
    files = {"static/style.css": "body { margin: 0; }\n"}
    if with_page_2:
        files[PREVIEW_2_PATH] = "<!doctype html>\n<p>screens 5-9</p>\n"
    if with_map_shell:
        files[MAP_SHELL_PATH] = "<!doctype html>\n<p>map-first home</p>\n"
    repo = _make_repo(tmp_path, files)
    return repo, repo.head()


PAGE_1_SCREENS = ("s1_", "s2_", "s3_", "s4_")


class TestRealShootPages:
    def test_all_pages_present_renders_all_48_shots_from_their_pages(self, tmp_path, fake_browser):
        repo, rev = _page_repo(tmp_path, with_page_2=True, with_map_shell=True)
        render = _load().real_shoot(repo.path, rev, str(tmp_path / "shots"))
        assert render["errors"] == []
        assert len(render["shots"]) == 48
        map_urls = [u for u in fake_browser if "s=closed" in u or "s=hidden" in u]
        assert len(map_urls) == 8 and all("/map-shell.html?" in u for u in map_urls), fake_browser
        page_2_urls = [u for u in fake_browser if "s=7" in u or "s=5,6" in u or "s=9" in u]
        assert page_2_urls and all("/preview-2.html?" in u for u in page_2_urls), fake_browser
        page_1_urls = [u for u in fake_browser if "s=1" in u or "s=4" in u]
        assert page_1_urls and all("/preview.html?" in u for u in page_1_urls), fake_browser

    def test_page_absent_at_rev_skips_only_that_pages_shots(self, tmp_path, fake_browser):
        repo, rev = _page_repo(tmp_path, with_page_2=False)
        render = _load().real_shoot(repo.path, rev, str(tmp_path / "shots"))
        absent = [e for e in render["errors"] if "preview-2.html" in e and f"absent at {rev}" in e]
        assert absent, render["errors"]
        names = [s["filename"] for s in render["shots"]]
        assert len(names) == 16, names
        assert all(n.startswith(PAGE_1_SCREENS) for n in names), names

    def test_map_shell_absent_at_rev_skips_only_its_16_shots(self, tmp_path, fake_browser):
        repo, rev = _page_repo(tmp_path, with_page_2=True, with_map_shell=False)
        render = _load().real_shoot(repo.path, rev, str(tmp_path / "shots"))
        absent = [e for e in render["errors"] if "map-shell.html" in e and f"absent at {rev}" in e]
        assert len(absent) == 1, render["errors"]
        assert absent == render["errors"], render["errors"]
        names = [s["filename"] for s in render["shots"]]
        assert len(names) == 32, names
        assert not any(n.startswith(MAP_SHOT_PREFIXES) for n in names), names


ROUTE_URL = "file:///repo/docs/design/route"
MAP_SCREENS = ("closed", "open", "landmark", "hidden")
MAP_SHOT_PREFIXES = tuple(f"s{s}_" for s in MAP_SCREENS)
WIDTHS = (("phone", (375, 812)), ("wide", (1000, 800)))
THEMES = ("light", "dark")
REPO_ROOT = Path(__file__).resolve().parents[1]


def _expected_map_shots():
    return {
        (
            f"{ROUTE_URL}/map-shell.html?s={s}" + ("&theme=dark" if t == "dark" else ""),
            f"s{s}_{w}_{t}.png",
            viewport,
        )
        for w, viewport in WIDTHS
        for t in THEMES
        for s in MAP_SCREENS
    }


class TestGatePlanShootsMapShell:
    def test_preview_shots_come_first_with_names_and_order_unchanged(self):
        gate = _load()
        sd = gate.screenshot_design
        preview = sd.shot_plan(
            ROUTE_URL + "/preview.html", sd.DEFAULT_SCREENS, sd.DEFAULT_WIDTHS, sd.DEFAULT_THEMES
        )
        plan = gate.gate_plan(ROUTE_URL)
        assert len(preview) == 32
        assert [tuple(s) for s in plan[:32]] == [tuple(s) for s in preview]

    def test_16_map_shell_shots_follow_the_preview_shots(self):
        plan = _load().gate_plan(ROUTE_URL)
        assert len(plan) == 48, [s.filename for s in plan]
        assert {(s.url, s.filename, tuple(s.viewport)) for s in plan[32:]} == _expected_map_shots()

    def test_map_shot_names_are_unique_and_follow_the_screen_width_theme_pattern(self):
        plan = _load().gate_plan(ROUTE_URL)
        names = [s.filename for s in plan]
        assert len(set(names)) == len(names) == 48, names
        by_name = {s.filename: s for s in plan}
        assert by_name["sclosed_phone_light.png"].url == ROUTE_URL + "/map-shell.html?s=closed"
        assert by_name["shidden_wide_dark.png"].url == ROUTE_URL + "/map-shell.html?s=hidden&theme=dark"
        assert tuple(by_name["shidden_wide_dark.png"].viewport) == (1000, 800)


def _loaded_repo_paths(html: str) -> list[str]:
    """Repo paths of the files an html page under ROUTE_DIR loads via link href / script src."""
    refs = re.findall(r"<(?:link|script)\b[^>]*\b(?:href|src)\s*=\s*[\"']([^\"'#]+)[\"']", html, flags=re.I)
    return [
        posixpath.normpath(ROUTE_DIR + r)
        for r in refs
        if not re.match(r"([a-z][a-z0-9+.-]*:|/)", r, flags=re.I)
    ]


class TestMapShellRendersFromArchive:
    def test_map_shell_and_every_file_it_loads_are_inside_render_paths(self):
        render_paths = _load().RENDER_PATHS
        html = (REPO_ROOT / MAP_SHELL_PATH).read_text(encoding="utf-8")
        loaded = [MAP_SHELL_PATH, *_loaded_repo_paths(html)]
        for name in ("map-shell.js", "map-shell.css", "map-drawer.css"):
            assert ROUTE_DIR + name in loaded, loaded
        for path in loaded:
            assert (REPO_ROOT / path).is_file(), path
            assert any(path == r or path.startswith(r.rstrip("/") + "/") for r in render_paths), (
                path,
                render_paths,
            )


def _map_shell_branch(tmp_path):
    """main has preview.html + preview-2.html; the feature branch adds map-shell.html."""
    repo = _make_repo(
        tmp_path,
        {
            "static/style.css": "body { margin: 0; }\n",
            PREVIEW_2_PATH: "<!doctype html>\n<p>screens 5-9</p>\n",
        },
    )
    repo.commit({MAP_SHELL_PATH: "<!doctype html>\n<p>map-first home</p>\n"}, "add map shell")
    return repo


def _approval_fails(lines, name):
    return [line for line in _fails(lines) if name in line and "approv" in line.lower()]


class TestChangedMapShotsNeedApproval:
    def test_new_map_shots_without_approval_are_reported_like_any_changed_shot(
        self, capsys, tmp_path, fake_browser
    ):
        repo = _map_shell_branch(tmp_path)
        _, lines = _gate(capsys, tmp_path, repo, None)
        for name in sorted(f for _, f, _ in _expected_map_shots()):
            assert _approval_fails(lines, name), (name, lines)
        assert not _approval_fails(lines, "s1_phone_light.png"), lines

    def test_approved_map_shots_at_this_tip_are_not_reported(self, capsys, tmp_path, fake_browser):
        repo = _map_shell_branch(tmp_path)
        _gate(capsys, tmp_path, repo, None)
        spec = importlib.util.spec_from_file_location(
            "approve_design_map", REPO_ROOT / "scripts" / "approve_design.py"
        )
        approve = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(approve)
        assert approve.main([str(tmp_path / "out"), "--approvals", str(tmp_path / "approvals.json")]) == 0
        _, lines = _gate(capsys, tmp_path, repo, None)
        assert (tmp_path / "out" / "tip" / "sclosed_phone_light.png").is_file(), lines
        assert not any(_approval_fails(lines, f) for _, f, _ in _expected_map_shots()), lines


class TestRealShootEmulatesReducedMotion:
    def test_every_shot_is_rendered_with_prefers_reduced_motion_reduce(self, tmp_path, fake_browser):
        repo, rev = _page_repo(tmp_path, with_page_2=True, with_map_shell=True)
        out = tmp_path / "shots"
        render = _load().real_shoot(repo.path, rev, str(out))
        assert render["errors"] == []
        names = [s["filename"] for s in render["shots"]]
        assert len(names) == 48, names
        motion = [n for n in names if body_bg(out / n) != REDUCE_BG]
        assert not motion, (
            f"{len(motion)} of 48 shots not rendered under prefers-reduced-motion: reduce: {motion[:4]}"
        )


class TestRealShootIsByteDeterministic:
    def test_two_runs_at_one_rev_shoot_byte_identical_pngs(self, tmp_path, fake_gpu_browser):
        repo, rev = _page_repo(tmp_path, with_page_2=True, with_map_shell=True)
        gate = _load()
        first, second = tmp_path / "shots-1", tmp_path / "shots-2"
        assert gate.real_shoot(repo.path, rev, str(first))["errors"] == []
        assert gate.real_shoot(repo.path, rev, str(second))["errors"] == []
        names = sorted(p.name for p in first.glob("*.png"))
        assert len(names) == 48, names
        assert sorted(p.name for p in second.glob("*.png")) == names
        drift = [n for n in names if (first / n).read_bytes() != (second / n).read_bytes()]
        assert not drift, (
            f"{len(drift)} of 48 shots differ between runs (browser not launched with --disable-gpu): "
            f"{drift[:4]}"
        )


class TestRealShootReducedMotionRealBrowser:
    def test_real_chrome_shot_shows_the_reduced_motion_background(self, tmp_path, monkeypatch):
        require_chrome()
        pytest.importorskip("axe_playwright_python")
        repo, _ = _page_repo(tmp_path, with_page_2=False)
        rev = repo.commit({PREVIEW_PATH: REDUCED_MOTION_HTML}, "reduced-motion fixture")
        gate = _load()
        shot = gate.screenshot_design.Shot
        # One small shot keeps the real render fast; the page/screenshot path is real_shoot's own.
        monkeypatch.setattr(
            gate, "gate_plan", lambda url: [shot(url + "/preview.html?s=1", "s1_tiny.png", (200, 200))]
        )
        out = tmp_path / "shots"
        render = gate.real_shoot(repo.path, rev, str(out))
        assert [s["filename"] for s in render["shots"]] == ["s1_tiny.png"], render["errors"]
        rgb = centre_rgb(out / "s1_tiny.png")
        assert is_reduce_bg(rgb), f"centre pixel {rgb}: not rendered under prefers-reduced-motion: reduce"
