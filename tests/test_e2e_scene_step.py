# Covers: MEM-044
# Requirement: E2E step 6 ("6 scenes + overlay zoom") never passes vacuously: when no tier-1 scene
# image rendered, the overlay open / Escape / click-at-(5,5) checks never ran (overlay_ok is None),
# so the step must FAIL rather than PASS on tier-3-only scenes.
import importlib.util
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
STEPS = REPO_ROOT / "scripts" / "e2e_steps.py"


@pytest.fixture
def steps(monkeypatch):
    monkeypatch.syspath_prepend(str(REPO_ROOT / "scripts"))
    spec = importlib.util.spec_from_file_location("e2e_steps_under_test", STEPS)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    yield module
    sys.modules.pop("e2e_steps_under_test", None)


class _Locator:
    def __init__(self, n):
        self.n = n

    def count(self):
        return self.n


class TierThreeOnlyPage:
    """Two scene sections, both "Scene unavailable", 0 tier-1 images: the overlay is never openable."""

    def locator(self, sel):
        return _Locator({"#scenes > section": 2, "#scenes .scene-frame img": 0}.get(sel, 0))

    def eval_on_selector_all(self, sel, _js):
        if sel == "#scenes p":
            return ["Scene unavailable: fixture_missing", "Scene unavailable: fixture_missing"]
        return []


class _Ctx:
    def __init__(self):
        self.results = []

    def rec(self, name, ok, detail=""):
        self.results.append((name, ok, detail))

    def shot(self, page, name):
        pass


def test_step6_fails_when_no_tier1_scene_lets_the_overlay_open(steps):
    ctx = _Ctx()
    steps.s_scenes(ctx, TierThreeOnlyPage())
    assert len(ctx.results) == 1, ctx.results
    name, ok, detail = ctx.results[0]
    assert name == "6 scenes + overlay zoom"
    assert ok is False, f"step 6 passed with no overlay check run: {detail}"
