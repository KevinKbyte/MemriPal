# Covers: MEM-070
# Requirement: `scripts/design_gate.py` gates a branch whose diff (merge-base..tip) touches
# docs/design/**: it takes its OWN screenshots of the design at the tip commit through an
# injectable `shoot(rev, outdir)` (rev = the tip's full sha; the shooter writes the PNGs and
# returns {"errors", "shots": [{"filename", "viewport", "scroll_width", "axe", "ids",
# "classes"}]}) and fails on: any page/console error; `check_route_css.check` problems on the
# tip's route CSS (the in-dir stylesheets preview.html links, pinned in test_design_gate_pages.py)
# + route-contract.md; scroll width beyond the viewport at
# 375 px; an axe "color-contrast" or "target-size" violation; no shots; or any id/class used in
# a CSS selector or named (as `#id`/`.class` in a backticked span) by the contract that is absent
# from the union of every shot's rendered DOM. `--evidence` that is a README.md, or anything
# other than a PNG whose bytes match a shot the gate itself produced at the tip in this run (e.g.
# a PNG from an earlier commit, a missing file), is refused. Tip shots persist under --outdir.
# A branch not touching docs/design/** passes without shooting. Output: one "FAIL <problem>"
# line per problem, then "OK" (exit 0) or "<n> problem(s)" (exit 1); bad usage exits 2. The
# module imports without playwright.
import importlib.util
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
GATE = REPO_ROOT / "scripts" / "design_gate.py"
GIT = shutil.which("git")

pytestmark = pytest.mark.skipif(not GIT, reason="design_gate test needs git")

CSS_PATH = "docs/design/route/route.css"
CONTRACT_PATH = "docs/design/route/route-contract.md"
PREVIEW_PATH = "docs/design/route/preview.html"
CSS = "/* route */\n#scene-wrap { margin: 0; }\n.assoc-card { padding: 0; }\n"
CONTRACT = "# Contract\n\nCards: `article.assoc-card` inside `#scene-wrap`. Load `route.css` last.\n"
PREVIEW = (
    "<!doctype html>\n"
    '<link rel="stylesheet" href="../../../static/style.css">\n'
    '<link rel="stylesheet" href="route.css">\n'
)
PNG = b"\x89PNG\r\n\x1a\n"
PHONE = "s1_phone_light.png"
WIDE = "s1_wide_light.png"


def _load():
    spec = importlib.util.spec_from_file_location("design_gate_under_test", GATE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _png(look: str, filename: str) -> bytes:
    return PNG + f"{look}:{filename}".encode("ascii")


def _shot(filename, viewport, *, scroll_width=None, axe=(), ids=("scene-wrap",), classes=("assoc-card",)):
    return {
        "filename": filename,
        "viewport": list(viewport),
        "scroll_width": viewport[0] if scroll_width is None else scroll_width,
        "axe": list(axe),
        "ids": list(ids),
        "classes": list(classes),
    }


def _render(look="v1", errors=(), shots=None, looks=None):
    if shots is None:
        shots = [_shot(PHONE, (375, 812)), _shot(WIDE, (1000, 800))]
    return {"look": look, "looks": dict(looks or {}), "errors": list(errors), "shots": shots}


class FakeShooter:
    """Stands in for the browser: writes one PNG per shot, returns the render metadata."""

    def __init__(self, tip_sha, tip=None, base=None):
        self.tip_sha = tip_sha
        self.tip = tip or _render()
        self.base = base or _render()
        self.calls = []

    def __call__(self, rev, outdir):
        self.calls.append((rev, outdir))
        spec = self.tip if rev == self.tip_sha else self.base
        out = Path(outdir)
        out.mkdir(parents=True, exist_ok=True)
        for shot in spec["shots"]:
            look = spec["looks"].get(shot["filename"], spec["look"])
            (out / shot["filename"]).write_bytes(_png(look, shot["filename"]))
        return {"errors": list(spec["errors"]), "shots": [dict(s) for s in spec["shots"]]}

    def tip_dir(self) -> Path:
        return Path(next(outdir for rev, outdir in self.calls if rev == self.tip_sha))


class Repo:
    def __init__(self, path: Path):
        self.path = path
        self.env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        self.env.update(
            {
                "GIT_CONFIG_GLOBAL": os.devnull,
                "GIT_CONFIG_NOSYSTEM": "1",
                "GIT_AUTHOR_NAME": "Gate Test",
                "GIT_AUTHOR_EMAIL": "gate-test@example.invalid",
                "GIT_COMMITTER_NAME": "Gate Test",
                "GIT_COMMITTER_EMAIL": "gate-test@example.invalid",
            }
        )

    def git(self, *args: str) -> str:
        result = subprocess.run(
            [GIT, "-C", str(self.path), *args], env=self.env, capture_output=True, text=True, timeout=60
        )
        assert result.returncode == 0, result.stdout + result.stderr
        return result.stdout.strip()

    def commit(self, files: dict, msg: str) -> str:
        for rel, content in files.items():
            target = self.path / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            if isinstance(content, bytes):
                target.write_bytes(content)
            else:
                target.write_text(content, encoding="utf-8", newline="\n")
            self.git("add", "--", rel)
        self.git("commit", "-q", "-m", msg)
        return self.head()

    def head(self) -> str:
        return self.git("rev-parse", "HEAD")


def _make_repo(tmp_path: Path, extra_base_files=None) -> Repo:
    repo = Repo(tmp_path / "repo")
    repo.path.mkdir()
    repo.git("init", "-q", "-b", "main")
    files = {"README.md": "# demo\n", CSS_PATH: CSS, CONTRACT_PATH: CONTRACT, PREVIEW_PATH: PREVIEW}
    files.update(extra_base_files or {})
    repo.commit(files, "base")
    repo.git("checkout", "-q", "-b", "feature")
    return repo


@pytest.fixture
def repo(tmp_path):
    return _make_repo(tmp_path)


def _gate(capsys, tmp_path, repo, shooter, *extra):
    argv = [
        "--repo",
        str(repo.path),
        "--base",
        "main",
        "--outdir",
        str(tmp_path / "out"),
        "--approvals",
        str(tmp_path / "approvals.json"),
        *extra,
    ]
    try:
        code = _load().main(argv, shoot=shooter)
    except SystemExit as exc:  # argparse-style exit is an equally valid exit code
        code = exc.code
    return code, capsys.readouterr().out.splitlines()


def _fails(lines):
    return [line for line in lines if line.startswith("FAIL ")]


def _design_commit(repo, css=CSS + "#scene-wrap { padding: 0; }\n", contract=CONTRACT) -> str:
    return repo.commit({CSS_PATH: css, CONTRACT_PATH: contract}, "design change")


class TestTouchesDesign:
    @pytest.mark.parametrize(
        "paths",
        [[CSS_PATH], ["README.md", "docs/design/route/preview.html"], ["docs/design/other/x.md"]],
    )
    def test_paths_under_docs_design_touch_design(self, paths):
        assert _load().touches_design(paths) is True

    @pytest.mark.parametrize(
        "paths",
        [
            [],
            ["README.md"],
            ["docs/design-notes.md"],
            ["docs/designs/route.css"],
            ["src/docs/design/route.css"],
            ["docs/decisions/0036-design-gate.md"],
        ],
    )
    def test_other_paths_do_not_touch_design(self, paths):
        assert _load().touches_design(paths) is False


class TestScope:
    def test_non_design_branch_passes_without_shooting(self, capsys, tmp_path, repo):
        repo.commit(
            {"README.md": "# changed\n", "docs/design-notes.md": "notes\n", "src/a.py": "x = 1\n"}, "x"
        )
        shooter = FakeShooter(repo.head(), tip=_render(errors=["TypeError: boom"]))
        code, _ = _gate(capsys, tmp_path, repo, shooter)
        assert code == 0
        assert shooter.calls == []

    def test_design_branch_is_shot_at_the_tip_commit_sha(self, capsys, tmp_path, repo):
        tip = repo.commit({CONTRACT_PATH: CONTRACT + "\nMore words.\n"}, "contract only")
        shooter = FakeShooter(tip)
        code, lines = _gate(capsys, tmp_path, repo, shooter)
        assert tip in [rev for rev, _ in shooter.calls]
        assert code == 0, lines
        assert lines[-1] == "OK"

    def test_tip_shots_persist_under_outdir(self, capsys, tmp_path, repo):
        shooter = FakeShooter(_design_commit(repo))
        code, lines = _gate(capsys, tmp_path, repo, shooter)
        assert code == 0, lines
        tip_dir = shooter.tip_dir().resolve()
        assert tip_dir.is_relative_to((tmp_path / "out").resolve())
        assert (tip_dir / PHONE).read_bytes() == _png("v1", PHONE)

    def test_unknown_flag_exits_2_without_shooting(self, capsys, tmp_path, repo):
        shooter = FakeShooter(_design_commit(repo))
        code, _ = _gate(capsys, tmp_path, repo, shooter, "--bogus")
        assert code == 2
        assert shooter.calls == []


class TestChecks:
    def test_page_error_fails_with_summary(self, capsys, tmp_path, repo):
        shooter = FakeShooter(_design_commit(repo), tip=_render(errors=["TypeError: x is null"]))
        code, lines = _gate(capsys, tmp_path, repo, shooter)
        assert code == 1
        assert any("TypeError: x is null" in line for line in _fails(lines))
        assert lines[-1] == f"{len(_fails(lines))} problem(s)"

    def test_route_css_problem_at_tip_fails(self, capsys, tmp_path, repo):
        tip = _design_commit(repo, css=CSS + ".assoc-card { color: red; }\n")
        code, lines = _gate(capsys, tmp_path, repo, FakeShooter(tip))
        assert code == 1
        assert any("named colour" in line for line in _fails(lines))

    @pytest.mark.parametrize("scroll_width, expected", [(375, 0), (376, 1)])
    def test_horizontal_overflow_at_375_fails(self, capsys, tmp_path, repo, scroll_width, expected):
        shots = [_shot(PHONE, (375, 812), scroll_width=scroll_width), _shot(WIDE, (1000, 800))]
        code, lines = _gate(
            capsys, tmp_path, repo, FakeShooter(_design_commit(repo), tip=_render(shots=shots))
        )
        assert code == expected, lines
        if expected:
            assert any("overflow" in line and PHONE in line for line in _fails(lines))

    @pytest.mark.parametrize("rule, expected", [("color-contrast", 1), ("target-size", 1), ("region", 0)])
    def test_axe_contrast_and_tap_target_violations_fail(self, capsys, tmp_path, repo, rule, expected):
        shots = [_shot(PHONE, (375, 812), axe=[rule]), _shot(WIDE, (1000, 800))]
        code, lines = _gate(
            capsys, tmp_path, repo, FakeShooter(_design_commit(repo), tip=_render(shots=shots))
        )
        assert code == expected, lines
        if expected:
            assert any(rule in line and PHONE in line for line in _fails(lines))

    def test_css_selector_id_absent_from_dom_fails(self, capsys, tmp_path, repo):
        tip = _design_commit(repo, css=CSS + "#status { margin: 0; }\n")
        code, lines = _gate(capsys, tmp_path, repo, FakeShooter(tip))
        assert code == 1
        assert any("#status" in line for line in _fails(lines))

    def test_contract_id_absent_from_dom_fails(self, capsys, tmp_path, repo):
        tip = _design_commit(repo, contract=CONTRACT + "Walk: `#walk`.\n")
        code, lines = _gate(capsys, tmp_path, repo, FakeShooter(tip))
        assert code == 1
        assert any("#walk" in line for line in _fails(lines))

    def test_class_absent_from_dom_fails(self, capsys, tmp_path, repo):
        shots = [_shot(PHONE, (375, 812), classes=()), _shot(WIDE, (1000, 800), classes=())]
        code, lines = _gate(
            capsys, tmp_path, repo, FakeShooter(_design_commit(repo), tip=_render(shots=shots))
        )
        assert code == 1
        assert any(".assoc-card" in line for line in _fails(lines))

    def test_dom_names_are_the_union_across_shots(self, capsys, tmp_path, repo):
        shots = [
            _shot(PHONE, (375, 812), ids=("scene-wrap",), classes=()),
            _shot(WIDE, (1000, 800), ids=(), classes=("assoc-card",)),
        ]
        code, lines = _gate(
            capsys, tmp_path, repo, FakeShooter(_design_commit(repo), tip=_render(shots=shots))
        )
        assert code == 0, lines

    def test_render_with_no_shots_fails(self, capsys, tmp_path, repo):
        tip = _design_commit(repo)
        code, lines = _gate(
            capsys, tmp_path, repo, FakeShooter(tip, tip=_render(shots=[]), base=_render(shots=[]))
        )
        assert code == 1
        assert _fails(lines)


class TestNameExtraction:
    def test_css_selector_names_skip_comments_values_and_attributes(self):
        css = (
            "/* .ghost #ghost */\n"
            "@media (max-width: 40.5em) { .wide-only { margin: 0; } }\n"
            ".btn:not(.undo) { margin: 0; }\n"
            'a[href$=".pdf"] { margin: 0; }\n'
            "#scene-wrap::before { color: #fff; }\n"
        )
        ids, classes = _load().css_selector_names(css)
        assert set(ids) == {"scene-wrap"}
        assert set(classes) == {"wide-only", "btn", "undo"}

    def test_contract_names_come_from_backticked_selectors_only(self):
        contract = (
            "Plain .outside and #outside are prose.\n"
            "`article.assoc-card` in `#scene-wrap`;\n"
            "buttons `button.btn.confirm`, `button.tap[aria-pressed]`.\n"
            "Class list `btn toggle`. Files: `route.css`, `theme-painterly.css`, `/static/assets/logo.svg`,\n"
            '`<link rel="stylesheet" href="/static/route.css">`,\n'
            "`docs/decisions/0022-x.md`, `scripts/x.py:38`.\n"
        )
        ids, classes = _load().contract_names(contract)
        assert set(ids) == {"scene-wrap"}
        assert set(classes) == {"assoc-card", "btn", "confirm", "tap"}


class TestEvidence:
    @pytest.mark.parametrize("rel", ["README.md", "docs/design/route/README.md"])
    def test_readme_evidence_is_refused(self, capsys, tmp_path, rel):
        repo = _make_repo(tmp_path, {"docs/design/route/README.md": "# route\n"})
        shooter = FakeShooter(_design_commit(repo))
        code, lines = _gate(capsys, tmp_path, repo, shooter, "--evidence", str(repo.path / rel))
        assert code == 1
        assert any("evidence" in line.lower() and "README.md" in line for line in _fails(lines))

    def test_png_from_an_earlier_commit_is_refused(self, capsys, tmp_path):
        old = "docs/design/route/" + PHONE
        repo = _make_repo(tmp_path, {old: _png("v0", PHONE)})
        shooter = FakeShooter(_design_commit(repo))
        code, lines = _gate(capsys, tmp_path, repo, shooter, "--evidence", str(repo.path / old))
        assert code == 1
        assert any("evidence" in line.lower() and PHONE in line for line in _fails(lines))

    def test_missing_evidence_file_is_refused(self, capsys, tmp_path, repo):
        shooter = FakeShooter(_design_commit(repo))
        code, lines = _gate(capsys, tmp_path, repo, shooter, "--evidence", str(tmp_path / "nope.png"))
        assert code == 1
        assert any("evidence" in line.lower() and "nope.png" in line for line in _fails(lines))

    def test_png_the_gate_produced_at_the_tip_is_accepted(self, capsys, tmp_path, repo):
        tip = _design_commit(repo)
        first = FakeShooter(tip)
        assert _gate(capsys, tmp_path, repo, first)[0] == 0
        fresh = tmp_path / "fresh.png"
        fresh.write_bytes((first.tip_dir() / PHONE).read_bytes())
        code, lines = _gate(capsys, tmp_path, repo, FakeShooter(tip), "--evidence", str(fresh))
        assert code == 0, lines
        assert lines[-1] == "OK"


class TestImport:
    def test_module_imports_without_playwright_installed(self, monkeypatch):
        monkeypatch.setitem(sys.modules, "playwright", None)
        monkeypatch.setitem(sys.modules, "playwright.sync_api", None)
        module = _load()
        assert callable(module.main)
        assert module.touches_design([CSS_PATH]) is True


# Covers: MEM-119
# Requirement: a gated axe violation (color-contrast, target-size) names WHICH elements fail:
# `design_gate.axe_problems(shot_name, violations)` turns the shooter's per-shot
# `[{"id", "nodes": [{"target": [sel, ...], "html"}]}]` into one "axe <rule>: <shot>: <target>
# <snippet>" line per node, in node order (target selectors joined by one space; snippet = html
# with whitespace runs collapsed to one space, non-ASCII as "?", cut to 120 chars plus "..."
# when longer). A gated violation with no nodes, or a legacy bare rule string, yields the single
# line "axe <rule>: <shot>"; non-gated rules yield nothing. The gate's FAIL lines carry these.
class TestAxeNodeTargets:
    SHOT = "home-mobile.png"

    def test_one_node_gives_one_line_with_target_and_snippet(self):
        violations = [
            {
                "id": "target-size",
                "nodes": [{"target": ['a[href="?s=1"]'], "html": '<a href="?s=1" class="x">Go</a>'}],
            }
        ]
        assert _load().axe_problems(self.SHOT, violations) == [
            'axe target-size: home-mobile.png: a[href="?s=1"] <a href="?s=1" class="x">Go</a>'
        ]

    def test_two_nodes_give_two_lines_in_node_order(self):
        violations = [
            {
                "id": "color-contrast",
                "nodes": [
                    {"target": ["p.faint"], "html": '<p class="faint">a</p>'},
                    {"target": ["span.dim"], "html": '<span class="dim">b</span>'},
                ],
            }
        ]
        assert _load().axe_problems(self.SHOT, violations) == [
            'axe color-contrast: home-mobile.png: p.faint <p class="faint">a</p>',
            'axe color-contrast: home-mobile.png: span.dim <span class="dim">b</span>',
        ]

    @pytest.mark.parametrize(
        "violation",
        [{"id": "color-contrast", "nodes": []}, {"id": "color-contrast"}, "color-contrast"],
        ids=["empty-nodes", "missing-nodes", "legacy-string"],
    )
    def test_gated_violation_without_nodes_gives_bare_line(self, violation):
        assert _load().axe_problems(self.SHOT, [violation]) == ["axe color-contrast: home-mobile.png"]

    @pytest.mark.parametrize(
        "violation",
        [{"id": "region", "nodes": [{"target": ["main"], "html": "<main></main>"}]}, "region"],
        ids=["dict", "string"],
    )
    def test_non_gated_rule_gives_no_lines(self, violation):
        assert _load().axe_problems(self.SHOT, [violation]) == []

    @pytest.mark.parametrize("length, truncated", [(300, True), (121, True), (120, False)])
    def test_snippet_is_cut_to_120_chars_with_ellipsis(self, length, truncated):
        html = "<div>" + "y" * (length - 5)
        assert len(html) == length
        violations = [{"id": "target-size", "nodes": [{"target": ["div"], "html": html}]}]
        expected = html[:120] + "..." if truncated else html
        assert _load().axe_problems(self.SHOT, violations) == [
            f"axe target-size: home-mobile.png: div {expected}"
        ]

    def test_whitespace_runs_collapse_and_non_ascii_becomes_question_mark(self):
        html = '<a\n\thref="x">  caf\u00e9 \n\n  go</a>'
        violations = [{"id": "target-size", "nodes": [{"target": ["a"], "html": html}]}]
        lines = _load().axe_problems(self.SHOT, violations)
        assert lines == ['axe target-size: home-mobile.png: a <a href="x"> caf? go</a>']
        assert all(line.isascii() for line in lines)

    def test_multi_selector_target_is_joined_by_one_space(self):
        node = {"target": ["iframe#f", "button.b"], "html": "<button>b</button>"}
        violations = [{"id": "target-size", "nodes": [node]}]
        assert _load().axe_problems(self.SHOT, violations) == [
            "axe target-size: home-mobile.png: iframe#f button.b <button>b</button>"
        ]

    def test_gate_fail_line_names_the_failing_element(self, capsys, tmp_path, repo):
        axe = [{"id": "target-size", "nodes": [{"target": ["a.tiny"], "html": '<a class="tiny">x</a>'}]}]
        shots = [_shot(PHONE, (375, 812), axe=axe), _shot(WIDE, (1000, 800))]
        code, lines = _gate(
            capsys, tmp_path, repo, FakeShooter(_design_commit(repo), tip=_render(shots=shots))
        )
        assert code == 1, lines
        assert any("target-size" in line and PHONE in line and "a.tiny" in line for line in _fails(lines))
