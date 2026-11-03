# Requirement: the memripal pre-commit hook runs kb_anchor_gate.py from the
# agent-workflow checkout and fails closed, naming the expected path, when absent.
# Covers: KB-041
import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
HOOK = REPO / ".githooks" / "pre-commit"


def _find_sh():
    """Prefer Git-Bash sh; System32/WSL launchers cannot run the hook."""
    found = shutil.which("sh")
    if found is None:
        return None
    low = found.replace("\\", "/").lower()
    return None if "/windows/system32" in low or "wsl" in low else found


SH = _find_sh()
NO_SH = "Git-Bash/POSIX sh unavailable (System32/WSL sh does not count)"


def _run_hook(tmp_path, aw):
    work = tmp_path / "repo"
    work.mkdir()
    env = {**os.environ, "AW": aw.as_posix(), "GIT_CONFIG_GLOBAL": os.devnull}
    run = lambda *a: subprocess.run(a, cwd=work, env=env, capture_output=True, text=True)  # noqa: E731
    run("git", "init", "-q")
    # Stub the earlier MEM-004 scan step so the hook reaches the KB-041 gate.
    (work / "scripts").mkdir()
    (work / "scripts" / "precommit_scan.py").write_text("import sys\nsys.exit(0)\n", encoding="utf-8")
    return run(SH, str(HOOK))


def _stub_aw(tmp_path, exit_code, docs_sync_code=0):
    """Stub both agent-workflow legs; docs_sync_code=None leaves the docs-sync leg absent."""
    aw = tmp_path / "aw"
    (aw / "scripts").mkdir(parents=True)
    gate = aw / "scripts" / "kb_anchor_gate.py"
    gate.write_text(f"import sys\nsys.exit({exit_code})\n", encoding="utf-8")
    if docs_sync_code is not None:
        (aw / "githooks").mkdir()
        sync = aw / "githooks" / "pre_commit_docs_sync.py"
        sync.write_text(f"import sys\nsys.exit({docs_sync_code})\n", encoding="utf-8")
    return aw


@pytest.mark.skipif(SH is None, reason=NO_SH)
@pytest.mark.parametrize("code", [1, 2])
def test_hook_fails_when_kb_gate_exits_nonzero(tmp_path, code):
    proc = _run_hook(tmp_path, _stub_aw(tmp_path, code))
    assert proc.returncode != 0, proc.stdout + proc.stderr


@pytest.mark.skipif(SH is None, reason=NO_SH)
def test_hook_passes_kb_portion_when_kb_gate_exits_zero(tmp_path):
    proc = _run_hook(tmp_path, _stub_aw(tmp_path, 0))
    out = proc.stdout + proc.stderr
    assert "KB-041 gate missing" not in out, out
    assert proc.returncode == 0, out


@pytest.mark.skipif(SH is None, reason=NO_SH)
def test_hook_fails_closed_naming_missing_gate_path(tmp_path):
    missing = tmp_path / "no-aw"
    proc = _run_hook(tmp_path, missing)
    out = proc.stdout + proc.stderr
    assert "kb_anchor_gate.py" in out and missing.as_posix() in out, f"gate path not named: {out!r}"
    assert proc.returncode != 0, out


# Requirement: the memripal pre-commit hook runs agent-workflow's docs-sync leg
# (githooks/pre_commit_docs_sync.py) so docs/onboarding.html cannot drift from
# docs/onboarding.md, and fails closed, naming the leg, when the script is absent.
# Covers: PDOC-005


@pytest.mark.skipif(SH is None, reason=NO_SH)
def test_hook_fails_closed_when_docs_sync_gate_missing(tmp_path):
    proc = _run_hook(tmp_path, _stub_aw(tmp_path, 0, docs_sync_code=None))
    out = proc.stdout + proc.stderr
    assert "docs-sync gate missing" in out and "pre_commit_docs_sync.py" in out, out
    assert proc.returncode != 0, out


@pytest.mark.skipif(SH is None, reason=NO_SH)
def test_hook_fails_when_docs_sync_gate_exits_nonzero(tmp_path):
    proc = _run_hook(tmp_path, _stub_aw(tmp_path, 0, docs_sync_code=1))
    out = proc.stdout + proc.stderr
    assert "docs-sync gate missing" not in out, out
    assert proc.returncode != 0, out


@pytest.mark.skipif(SH is None, reason=NO_SH)
def test_hook_passes_when_docs_sync_gate_exits_zero(tmp_path):
    proc = _run_hook(tmp_path, _stub_aw(tmp_path, 0, docs_sync_code=0))
    out = proc.stdout + proc.stderr
    assert "docs-sync gate missing" not in out, out
    assert proc.returncode == 0, out
