# Covers: MEM-069
# Requirement: `sh scripts/merge_branch.sh <worktree>` refuses to merge a branch whose diff
# main..branch touches a UI path (classified exactly like agent-workflow's
# hooks.global/visual-verify-commit-gate.py::is_ui_path) unless a visual-verify record exists.
# The gate runs before the merge on BOTH the `git merge --ff-only` fallback and the
# MEMRIPAL_REQUEST_MERGE_CMD override path; it is skipped only on the
# $AGENT_WORKFLOW_DIR/scripts/request_merge.py path, whose preenqueue_gates.py already runs
# visual_verify_merge_gate.refuse_reason(). A refusal exits 1 before any merge/enqueue (main
# untouched, primary check.sh not run), and stderr names "visual-verify", each UI path, and the
# lookup's own reason. A diff with no UI path never consults the lookup.
#
# Lookup seam: MEMRIPAL_VISUAL_VERIFY_CMD (word-split, like MEMRIPAL_REQUEST_MERGE_CMD) is
# invoked as `$MEMRIPAL_VISUAL_VERIFY_CMD <primary-checkout> <branch> main`; exit 0 = verified,
# nonzero = refuse (its stderr is surfaced). Unset, the default lookup calls
# visual_verify_merge_gate.refuse_reason(<primary>, <branch>, "main") from
# "${AGENT_WORKFLOW_DIR:-$HOME/projects/agent-workflow}/scripts/visual_verify_merge_gate.py";
# if that file is missing the gate fails closed (exit 1, stderr names the missing path). That
# default dir is used only for this lookup, never to select the request_merge.py enqueue path.
import importlib.util
import json
import os
import shutil
import sys
from pathlib import Path
from unittest import mock

import pytest
import test_merge_branch as mb
from test_merge_branch import (
    GIT,
    SH,
    _calls,
    _commit_file,
    _head,
    _install_request_merge_stub,
    _run,
)

pytestmark = pytest.mark.skipif(not (SH and GIT), reason="merge_branch.sh test needs sh and git")

# Re-exported so pytest resolves the shared fixtures in this module.
repos = mb.repos
fallback = mb.fallback

# Fake lookup: logs `vv:<branch>:<target>`, passes iff a visual-verify pass record exists in the
# ledger dir sdlc_phase_gate.py writes (<primary>/docs/sdlc-runs/*.json), else refuses.
FAKE_VV = """#!/bin/sh
echo "vv:$2:$3" >> "$MERGE_TEST_LOG"
for f in "$1"/docs/sdlc-runs/*.json; do
  [ -f "$f" ] || continue
  if grep -q '"visual-verify"' "$f" && grep -q '"status": "pass"' "$f"; then exit 0; fi
done
echo "FAKE-VV-REFUSAL: no visual-verify record under $1" >&2
exit 1
"""

# (path, is_ui) -- mirrors is_ui_path: UI extensions .js .mjs .ts .tsx .jsx .html .vue .svelte
# .css anywhere; not UI under scripts/, any test/tests/__tests__ dir, a .test./.spec. filename,
# or a .js/.mjs/.ts file under core/bg/workflows/workflows.global or named background/
# service-worker/service_worker (markup and .tsx/.jsx there stay UI).
UI_CASES = [
    ("static/app.js", True),
    ("static/style.css", True),
    ("docs/design/route/preview.html", True),
    ("docs/design/route/route.css", True),
    ("src/memripal/web/page.html", True),
    ("static/widget.tsx", True),
    ("static/core/view.html", True),
    ("static/core/widget.jsx", True),
    ("static/app.test.mjs", False),
    ("static/route.spec.ts", False),
    ("tests/fixtures/page.html", False),
    ("static/__tests__/helper.js", False),
    ("scripts/tool.js", False),
    ("static/core/machine.js", False),
    ("static/bg/alarms.mjs", False),
    ("workflows/dag.js", False),
    ("static/service-worker.js", False),
    ("static/background.mjs", False),
    ("src/memripal/app.py", False),
    ("docs/design/notes.md", False),
    ("README.md", False),
]


@pytest.fixture
def vv(fallback, tmp_path):
    """ff-path `fallback` repos plus the fake lookup wired via MEMRIPAL_VISUAL_VERIFY_CMD and a
    HOME with no agent-workflow checkout."""
    primary, wt, env, log, aw = fallback
    fake = tmp_path / "fake_vv.sh"
    fake.write_text(FAKE_VV, encoding="ascii", newline="\n")
    env["MEMRIPAL_VISUAL_VERIFY_CMD"] = f"sh {fake.as_posix()}"
    home = tmp_path / "home"
    home.mkdir()
    env["HOME"] = home.as_posix()
    env["USERPROFILE"] = str(home)
    return primary, wt, env, log, aw


def _record_visual_verify(primary: Path, env: dict, wt: Path, tmp_path: Path) -> None:
    """Write a visual-verify pass record where sdlc_phase_gate.py `record` lands it."""
    shot = tmp_path / "shot.png"
    shot.write_bytes(b"png")
    ledger_dir = primary / "docs" / "sdlc-runs"
    ledger_dir.mkdir(parents=True, exist_ok=True)
    (ledger_dir / ".gitignore").write_text("*.json\n!default.json\n.gitignore\n", encoding="ascii")
    entry = {
        "phase": "Verify",
        "gate": "visual-verify",
        "status": "pass",
        "evidence": shot.as_posix(),
        "timestamp": "2026-10-31T00:00:00+00:00",
        "ui_head": _head(wt, env),
    }
    text = json.dumps({"Verify": {"visual-verify": entry}}, indent=2)
    (ledger_dir / "run-1.json").write_text(text, encoding="utf-8")


class TestMergeVisualVerifyGate:
    def test_ff_ui_diff_without_record_refused_exit_1_main_untouched(self, vv, tmp_path):
        primary, wt, env, log, _aw = vv
        _commit_file(wt, env, "static/app.js", "ui();\n", "ui change")
        main_before = _head(primary, env)

        result = _run([wt.as_posix()], env, tmp_path)

        assert result.returncode == 1, result.stdout + result.stderr
        assert "visual-verify" in result.stderr
        assert "static/app.js" in result.stderr
        assert "FAKE-VV-REFUSAL" in result.stderr
        assert _head(primary, env) == main_before
        assert "vv:feature:main" in _calls(log)
        assert "check:main" not in _calls(log)

    def test_ff_ui_diff_with_record_fast_forwards(self, vv, tmp_path):
        primary, wt, env, log, _aw = vv
        _commit_file(wt, env, "docs/design/route/route.css", ".x {}\n", "ui css")
        _record_visual_verify(primary, env, wt, tmp_path)

        result = _run([wt.as_posix()], env, tmp_path)

        assert result.returncode == 0, result.stdout + result.stderr
        assert _head(primary, env) == _head(wt, env)
        assert "vv:feature:main" in _calls(log)
        assert _calls(log)[-1] == "check:main"

    def test_ff_non_ui_diff_skips_lookup_and_fast_forwards(self, vv, tmp_path):
        primary, wt, env, log, _aw = vv
        _commit_file(wt, env, "src/memripal/app.py", "x = 1\n", "backend change")

        result = _run([wt.as_posix()], env, tmp_path)

        assert result.returncode == 0, result.stdout + result.stderr
        assert _head(primary, env) == _head(wt, env)
        assert not [c for c in _calls(log) if c.startswith("vv:")]

    @pytest.mark.parametrize(("path", "is_ui"), UI_CASES)
    def test_ff_classification_mirrors_is_ui_path(self, vv, tmp_path, path, is_ui):
        primary, wt, env, log, _aw = vv
        _commit_file(wt, env, path, "content\n", f"touch {path}")
        main_before = _head(primary, env)

        result = _run([wt.as_posix()], env, tmp_path)

        if is_ui:
            assert result.returncode == 1, result.stdout + result.stderr
            assert path in result.stderr
            assert _head(primary, env) == main_before
        else:
            assert result.returncode == 0, result.stdout + result.stderr
            assert not [c for c in _calls(log) if c.startswith("vv:")]
            assert _head(primary, env) == _head(wt, env)

    def test_refusal_names_only_the_ui_paths(self, vv, tmp_path):
        _primary, wt, env, _log, _aw = vv
        _commit_file(wt, env, "static/app.css", ".a {}\n", "ui")
        _commit_file(wt, env, "src/memripal/routes.py", "y = 2\n", "backend")

        result = _run([wt.as_posix()], env, tmp_path)

        assert result.returncode == 1, result.stdout + result.stderr
        assert "static/app.css" in result.stderr
        assert "routes.py" not in result.stderr

    def test_override_enqueue_path_ui_diff_without_record_refused_before_enqueue(self, vv, tmp_path):
        primary, wt, env, log, _aw = vv
        env["MEMRIPAL_REQUEST_MERGE_CMD"] = f"sh {(tmp_path / 'enqueue_stub.sh').as_posix()}"
        _commit_file(wt, env, "static/app.js", "ui();\n", "ui change")
        main_before = _head(primary, env)

        result = _run([wt.as_posix()], env, tmp_path)

        assert result.returncode == 1, result.stdout + result.stderr
        assert "visual-verify" in result.stderr and "static/app.js" in result.stderr
        assert "enqueue" not in _calls(log)
        assert "vv:feature:main" in _calls(log)
        assert _head(primary, env) == main_before

    def test_override_enqueue_path_ui_diff_with_record_enqueues(self, vv, tmp_path):
        primary, wt, env, log, _aw = vv
        env["MEMRIPAL_REQUEST_MERGE_CMD"] = f"sh {(tmp_path / 'enqueue_stub.sh').as_posix()}"
        _commit_file(wt, env, "static/app.js", "ui();\n", "ui change")
        _record_visual_verify(primary, env, wt, tmp_path)

        result = _run([wt.as_posix()], env, tmp_path)

        assert result.returncode == 0, result.stdout + result.stderr
        assert _calls(log)[-2:] == ["enqueue", "check:main"]
        assert "vv:feature:main" in _calls(log)

    def test_request_merge_path_delegates_gate_to_queue(self, vv, tmp_path):
        primary, wt, env, log, aw = vv
        _install_request_merge_stub(aw)
        env["AGENT_WORKFLOW_DIR"] = aw.as_posix()
        _commit_file(wt, env, "static/app.js", "ui();\n", "ui change")

        result = _run([wt.as_posix()], env, tmp_path)

        assert result.returncode == 0, result.stdout + result.stderr
        assert _calls(log) == ["check:feature", "request_merge", "check:main"]

    def test_default_lookup_missing_gate_module_fails_closed(self, vv, tmp_path):
        primary, wt, env, log, _aw = vv
        env.pop("MEMRIPAL_VISUAL_VERIFY_CMD")
        _commit_file(wt, env, "static/app.js", "ui();\n", "ui change")
        main_before = _head(primary, env)

        result = _run([wt.as_posix()], env, tmp_path)

        assert result.returncode == 1, result.stdout + result.stderr
        assert "projects/agent-workflow/scripts/visual_verify_merge_gate.py" in result.stderr
        assert _head(primary, env) == main_before
        assert "check:main" not in _calls(log)

    def test_default_lookup_honors_agent_workflow_dir(self, vv, tmp_path):
        primary, wt, env, log, _aw = vv
        env.pop("MEMRIPAL_VISUAL_VERIFY_CMD")
        override = tmp_path / "aw-override"
        override.mkdir()
        env["AGENT_WORKFLOW_DIR"] = override.as_posix()
        _commit_file(wt, env, "static/app.js", "ui();\n", "ui change")
        main_before = _head(primary, env)

        result = _run([wt.as_posix()], env, tmp_path)

        assert result.returncode == 1, result.stdout + result.stderr
        assert "aw-override/scripts/visual_verify_merge_gate.py" in result.stderr
        assert _head(primary, env) == main_before

    def test_default_lookup_dir_does_not_select_request_merge(self, vv, tmp_path):
        primary, wt, env, log, _aw = vv
        home_aw = Path(env["HOME"]) / "projects" / "agent-workflow"
        _install_request_merge_stub(home_aw)

        result = _run([wt.as_posix()], env, tmp_path)

        assert result.returncode == 0, result.stdout + result.stderr
        assert _calls(log) == ["check:feature", "check:main"]
        assert _head(primary, env) == _head(wt, env)


_AW_DIR = Path(os.environ.get("AGENT_WORKFLOW_DIR") or Path.home() / "projects" / "agent-workflow")
_HOOK = _AW_DIR / "hooks.global" / "visual-verify-commit-gate.py"


# Covers: MEM-069
# Requirement: the UI-path table the merge_branch.sh classifier is pinned against matches
# agent-workflow's real is_ui_path, so the shell mirror cannot silently drift from the merge
# queue's classifier (skipped where no agent-workflow checkout exists).
@pytest.mark.skipif(not _HOOK.is_file(), reason="agent-workflow checkout not present")
class TestUiCaseTableMatchesAgentWorkflow:
    def test_table_matches_is_ui_path(self):
        with mock.patch.object(sys, "path", list(sys.path)), mock.patch.dict(sys.modules):
            spec = importlib.util.spec_from_file_location("visual_verify_commit_gate", _HOOK)
            hook = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(hook)
            actual = [(path, hook.is_ui_path(path)) for path, _ in UI_CASES]

        assert actual == UI_CASES


UV = shutil.which("uv")

# Stub agent-workflow scripts/visual_verify_merge_gate.py: records the args refuse_reason()
# received as JSON to $FAKE_VV_ARGS_FILE and returns $FAKE_VV_REASON (None when unset/empty).
FAKE_GATE_MODULE = """import json
import os
import shutil


def refuse_reason(primary, branch, target):
    with open(os.environ["FAKE_VV_ARGS_FILE"], "w", encoding="utf-8") as out:
        json.dump([primary, branch, target], out)
    return os.environ.get("FAKE_VV_REASON") or None
"""

FAKE_AW_PYPROJECT = """[project]
name = "fake-agent-workflow"
version = "0.0.0"
requires-python = ">=3.10"
dependencies = []
"""


@pytest.fixture
def default_vv(vv, tmp_path):
    """`vv` with MEMRIPAL_VISUAL_VERIFY_CMD removed, the real `uv` restored on PATH, and
    AGENT_WORKFLOW_DIR pointed at a fake agent-workflow checkout holding a stub gate module."""
    primary, wt, env, log, _aw = vv
    env.pop("MEMRIPAL_VISUAL_VERIFY_CMD")
    env["PATH"] = os.environ.get("PATH", "")
    fake_aw = tmp_path / "fake-aw"
    (fake_aw / "scripts").mkdir(parents=True)
    (fake_aw / "pyproject.toml").write_text(FAKE_AW_PYPROJECT, encoding="ascii", newline="\n")
    gate = fake_aw / "scripts" / "visual_verify_merge_gate.py"
    gate.write_text(FAKE_GATE_MODULE, encoding="ascii", newline="\n")
    env["AGENT_WORKFLOW_DIR"] = fake_aw.as_posix()
    args_file = tmp_path / "vv_args.json"
    env["FAKE_VV_ARGS_FILE"] = args_file.as_posix()
    return primary, wt, env, log, args_file


# Covers: MEM-069
# Requirement: with MEMRIPAL_VISUAL_VERIFY_CMD unset, merge_branch.sh's ff path consults the
# REAL default lookup: it runs visual_verify_merge_gate.refuse_reason(<primary>, <branch>,
# "main") from $AGENT_WORKFLOW_DIR/scripts/visual_verify_merge_gate.py via `uv run`. A
# non-empty reason refuses the merge (exit 1, the reason on stderr, main untouched, primary
# check.sh not run); None lets the fast-forward proceed. Skipped where `uv` is not on PATH.
@pytest.mark.skipif(not UV, reason="default visual-verify lookup runs via `uv run`; uv not on PATH")
class TestDefaultVisualVerifyLookup:
    def test_reason_returned_refuses_ff_exit_1_reason_on_stderr(self, default_vv, tmp_path):
        primary, wt, env, log, _args_file = default_vv
        env["FAKE_VV_REASON"] = "STUB-GATE-REASON: no visual-verify record"
        _commit_file(wt, env, "static/app.js", "ui();\n", "ui change")
        main_before = _head(primary, env)

        result = _run([wt.as_posix()], env, tmp_path)

        assert result.returncode == 1, result.stdout + result.stderr
        assert "STUB-GATE-REASON: no visual-verify record" in result.stderr
        assert "static/app.js" in result.stderr
        assert _head(primary, env) == main_before
        assert "check:main" not in _calls(log)

    def test_none_returned_fast_forwards(self, default_vv, tmp_path):
        primary, wt, env, log, _args_file = default_vv
        _commit_file(wt, env, "static/app.js", "ui();\n", "ui change")

        result = _run([wt.as_posix()], env, tmp_path)

        assert result.returncode == 0, result.stdout + result.stderr
        assert _head(primary, env) == _head(wt, env)
        assert _calls(log)[-1] == "check:main"

    def test_gate_receives_primary_branch_and_main(self, default_vv, tmp_path):
        primary, wt, env, _log, args_file = default_vv
        _commit_file(wt, env, "static/app.js", "ui();\n", "ui change")

        result = _run([wt.as_posix()], env, tmp_path)

        assert result.returncode == 0, result.stdout + result.stderr
        got_primary, got_branch, got_target = json.loads(args_file.read_text(encoding="utf-8"))
        assert os.path.samefile(got_primary, primary)
        assert (got_branch, got_target) == ("feature", "main")
