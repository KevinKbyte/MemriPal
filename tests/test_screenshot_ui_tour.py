# Covers: MEM-095
# Requirement: Pal's first-run tour (MEM-095) opens a modal #tour on any app-shell load whose localStorage
# has no "memripal.tour.done" (static/tour.js TOUR_KEY), and that modal intercepts every click, so
# scripts/screenshot_ui.py keeps its existing shots working by seeding the key on every page it drives:
# before a page's first navigation, add_init_script was called on that page (or on the browser context
# that created it) with a script that writes the key to localStorage. It also delivers MEM-095's
# "real-browser screenshot of step 1 and step 5": on one fresh page that is never seeded it navigates to
# the app, shoots tour-step1.png before any #tour-next click, then clicks #tour-next exactly four times
# and shoots tour-step5.png, with no navigation between the two shots. Driven with a fake playwright
# module that tracks which page or context each call was made on; no browser is launched.
import importlib.util
import re
import sys
import types
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "scripts" / "screenshot_ui.py"
TOUR_JS = REPO_ROOT / "static" / "tour.js"
URL = "http://127.0.0.1:8000/"
TOUR_SHOTS = ("tour-step1.png", "tour-step5.png")
NAVIGATIONS = ("goto", "reload")
CHILD_LOOKUPS = (
    "locator",
    "query_selector",
    "wait_for_selector",
    "get_by_text",
    "get_by_role",
    "get_by_label",
)
TEXT_READS = ("inner_text", "text_content", "input_value")


def _tour_key():
    match = re.search(r"export const TOUR_KEY = \"([^\"]+)\"", TOUR_JS.read_text(encoding="utf-8"))
    assert match, "static/tour.js exports TOUR_KEY as a string literal"
    return match.group(1)


class _Rec:
    """Shared call log: one entry per call, tagged with the page/context object it was made on."""

    def __init__(self):
        self.log = []  # (name, oid, sel, args, kwargs)
        self.kind = {0: "root"}
        self.parent = {0: None}

    def new_obj(self, kind, parent):
        oid = len(self.kind)
        self.kind[oid], self.parent[oid] = kind, parent
        return oid

    def next_clicks_since_nav(self, oid):
        count = 0
        for name, o, sel, args, kwargs in self.log:
            if o != oid:
                continue
            if name in NAVIGATIONS:
                count = 0
            elif _is_tour_next_click((name, o, sel, args, kwargs)):
                count += 1
        return count


class _Obj:
    def __init__(self, rec, oid, sel=None):
        self._rec, self._oid, self._sel = rec, oid, sel

    def __bool__(self):
        return True

    def __iter__(self):
        return iter(())

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def __call__(self, *args, **kwargs):
        return self

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        return _Call(self._rec, self._oid, self._sel, name)


class _Call(_Obj):
    def __init__(self, rec, oid, sel, name):
        super().__init__(rec, oid, sel)
        self._name = name

    def __call__(self, *args, **kwargs):
        rec, oid, name = self._rec, self._oid, self._name
        rec.log.append((name, oid, self._sel, args, kwargs))
        if name in ("new_page", "new_context"):
            return _Obj(rec, rec.new_obj(name[4:], oid))
        if name == "screenshot":
            path = kwargs.get("path", args[0] if args else None)
            if path is not None:
                Path(path).write_bytes(b"PNG fake")
        if name in CHILD_LOOKUPS:
            return _Obj(rec, oid, repr((args, kwargs)))
        if name in TEXT_READS:
            target = repr(args[:1]) + repr(self._sel)
            return str(rec.next_clicks_since_nav(oid) + 1) if "#tour-n'" in target else ""
        if name in ("eval_on_selector_all", "evaluate", "all_text_contents", "query_selector_all"):
            return []
        if name == "count":
            return 1
        if name == "is_visible":
            return True
        return _Obj(rec, oid, self._sel)


def _run_with_fake_browser(monkeypatch, tmp_path):
    rec = _Rec()
    module = types.ModuleType("playwright.sync_api")
    module.sync_playwright = lambda: _Obj(rec, 0)
    monkeypatch.setitem(sys.modules, "playwright", types.ModuleType("playwright"))
    monkeypatch.setitem(sys.modules, "playwright.sync_api", module)
    spec = importlib.util.spec_from_file_location("screenshot_ui_tour_under_test", SCRIPT)
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    loaded.run(URL, str(tmp_path))
    return rec


def _shot_name(entry):
    name, _, _, args, kwargs = entry
    if name != "screenshot":
        return None
    return Path(str(kwargs.get("path", args[0] if args else ""))).name


def _is_tour_next_click(entry):
    name, _, sel, args, kwargs = entry
    return name == "click" and "#tour-next" in repr((sel, args, kwargs))


def _seeds_tour_key(entry, key):
    name, _, _, args, kwargs = entry
    script = repr((args, kwargs))
    return name == "add_init_script" and key in script and "localStorage" in script


def _owners(rec, page):
    """The page itself plus the browser context that created it (a context's init scripts reach its pages)."""
    parent = rec.parent[page]
    return {page, parent} if rec.kind.get(parent) == "context" else {page}


def _navigated_pages(rec):
    pages = []
    for name, oid, *_ in rec.log:
        if name == "goto" and rec.kind.get(oid) == "page" and oid not in pages:
            pages.append(oid)
    return pages


def _first(rec, pred):
    return next((i for i, e in enumerate(rec.log) if pred(e)), None)


def _tour_page(rec):
    i = _first(rec, lambda e: _shot_name(e) == "tour-step1.png")
    assert i is not None, "run never wrote tour-step1.png"
    return rec.log[i][1]


class TestTourShotsAndSeeding:
    def test_tour_key_is_the_literal_static_tour_js_exports(self):
        assert _tour_key() == "memripal.tour.done"

    def test_run_writes_tour_step1_and_step5_once_each(self, monkeypatch, tmp_path):
        rec = _run_with_fake_browser(monkeypatch, tmp_path)
        shots = [s for s in (_shot_name(e) for e in rec.log) if s]
        for name in TOUR_SHOTS:
            assert shots.count(name) == 1, (name, shots)
            assert (tmp_path / name).is_file(), name

    def test_both_tour_shots_come_from_one_unseeded_page_with_no_navigation_between(
        self, monkeypatch, tmp_path
    ):
        key = _tour_key()
        rec = _run_with_fake_browser(monkeypatch, tmp_path)
        page = _tour_page(rec)
        assert rec.kind[page] == "page", "tour shots must be taken on a page"
        at = {_shot_name(e): i for i, e in enumerate(rec.log) if _shot_name(e) in TOUR_SHOTS}
        assert set(at) == set(TOUR_SHOTS), f"tour shots taken: {sorted(at)}"
        s1, s5 = at["tour-step1.png"], at["tour-step5.png"]
        assert rec.log[s5][1] == page, "tour-step5.png must be shot on the same page as tour-step1.png"
        assert s1 < s5, "tour-step1.png must come before tour-step5.png"
        owners = _owners(rec, page)
        gotos = [i for i in range(s1) if rec.log[i][0] == "goto" and rec.log[i][1] == page]
        assert gotos, "the tour page never navigated to the app before tour-step1.png"
        seeds = [i for i in range(s5) if rec.log[i][1] in owners and _seeds_tour_key(rec.log[i], key)]
        assert seeds == [], f"tour page (or its context) was seeded with {key!r}, so the tour never opens"
        navs = [
            rec.log[i][0] for i in range(s1 + 1, s5) if rec.log[i][1] == page and rec.log[i][0] in NAVIGATIONS
        ]
        assert navs == [], f"navigation {navs} between the two tour shots"

    def test_step1_precedes_any_next_click_and_step5_follows_exactly_four(self, monkeypatch, tmp_path):
        rec = _run_with_fake_browser(monkeypatch, tmp_path)
        page = _tour_page(rec)
        at = {_shot_name(e): i for i, e in enumerate(rec.log) if _shot_name(e) in TOUR_SHOTS}
        assert set(at) == set(TOUR_SHOTS), f"tour shots taken: {sorted(at)}"
        s1, s5 = at["tour-step1.png"], at["tour-step5.png"]
        last_nav = max(i for i in range(s1) if rec.log[i][1] == page and rec.log[i][0] in NAVIGATIONS)
        before = [i for i in range(last_nav, s1) if rec.log[i][1] == page and _is_tour_next_click(rec.log[i])]
        assert before == [], f"{len(before)} #tour-next click(s) before tour-step1.png"
        between = [i for i in range(s1, s5) if rec.log[i][1] == page and _is_tour_next_click(rec.log[i])]
        assert len(between) == 4, f"{len(between)} #tour-next clicks between the shots; step 5 needs 4"

    def test_every_other_page_is_seeded_with_the_tour_key_before_its_first_navigation(
        self, monkeypatch, tmp_path
    ):
        key = _tour_key()
        rec = _run_with_fake_browser(monkeypatch, tmp_path)
        # Only the page that shoots tour-step1.png may stay unseeded (none if the tour is never shot).
        step1 = _first(rec, lambda e: _shot_name(e) == "tour-step1.png")
        tour = rec.log[step1][1] if step1 is not None else None
        others = [p for p in _navigated_pages(rec) if p != tour]
        # The main page plus one fresh page per colour scheme for the MEM-077 demo route shots.
        assert len(others) >= 3, f"expected >= 3 non-tour pages, saw {len(others)}"
        for page in others:
            owners = _owners(rec, page)
            first_goto = _first(rec, lambda e, p=page: e[0] == "goto" and e[1] == p)
            seeded = [
                i for i in range(first_goto) if rec.log[i][1] in owners and _seeds_tour_key(rec.log[i], key)
            ]
            assert seeded, (
                f"page {page}: no add_init_script writing {key!r} to localStorage on it or its context "
                "before its first goto, so the tour blocks its clicks"
            )
