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
import importlib.machinery
import sys
import types
import urllib.parse
import urllib.request
from pathlib import Path

import pytest
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


class _FakePage:
    def __init__(self, visited: list[str]):
        self.visited = visited
        self.width = 0

    def on(self, event, handler):
        pass

    def set_viewport_size(self, size):
        self.width = size["width"]

    def goto(self, url, **kwargs):
        # A real browser raises on a missing file:// page (net::ERR_FILE_NOT_FOUND).
        path = Path(urllib.request.url2pathname(urllib.parse.urlparse(url).path))
        if not path.is_file():
            raise RuntimeError(f"net::ERR_FILE_NOT_FOUND at {url}")
        self.visited.append(url)

    def wait_for_timeout(self, ms):
        pass

    def screenshot(self, path, **kwargs):
        Path(path).write_bytes(b"\x89PNG\r\n\x1a\n" + Path(path).name.encode("ascii"))

    def add_script_tag(self, **kwargs):
        pass

    def evaluate(self, expression, arg=None):
        return self.width if "scrollWidth" in expression else []


class _FakePlaywright:
    def __init__(self, visited: list[str]):
        browser = types.SimpleNamespace(new_page=lambda: _FakePage(visited), close=lambda: None)
        self.chromium = types.SimpleNamespace(launch=lambda **kwargs: browser)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


@pytest.fixture
def fake_browser(monkeypatch, tmp_path):
    """Stand-in playwright + axe modules; yields the list of page URLs actually loaded."""
    visited: list[str] = []
    sync_api = types.ModuleType("playwright.sync_api")
    sync_api.sync_playwright = lambda: _FakePlaywright(visited)
    monkeypatch.setitem(sys.modules, "playwright", types.ModuleType("playwright"))
    monkeypatch.setitem(sys.modules, "playwright.sync_api", sync_api)
    axe_dir = tmp_path / "axe_pkg"
    axe_dir.mkdir()
    (axe_dir / "axe.min.js").write_text("/* axe */\n", encoding="utf-8")
    axe = types.ModuleType("axe_playwright_python")
    axe.__spec__ = importlib.machinery.ModuleSpec(
        "axe_playwright_python", None, origin=str(axe_dir / "__init__.py")
    )
    monkeypatch.setitem(sys.modules, "axe_playwright_python", axe)
    return visited


def _page_repo(tmp_path, with_page_2: bool):
    files = {"static/style.css": "body { margin: 0; }\n"}
    if with_page_2:
        files[PREVIEW_2_PATH] = "<!doctype html>\n<p>screens 5-9</p>\n"
    repo = _make_repo(tmp_path, files)
    return repo, repo.head()


PAGE_1_SCREENS = ("s1_", "s2_", "s3_", "s4_")


class TestRealShootPages:
    def test_both_pages_present_renders_all_32_shots_from_their_pages(self, tmp_path, fake_browser):
        repo, rev = _page_repo(tmp_path, with_page_2=True)
        render = _load().real_shoot(repo.path, rev, str(tmp_path / "shots"))
        assert render["errors"] == []
        assert len(render["shots"]) == 32
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
