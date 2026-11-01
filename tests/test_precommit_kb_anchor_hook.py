# Requirement: the memripal pre-commit hook runs kb_anchor_gate.py from the
# agent-workflow checkout and fails closed, naming the expected path, when absent.
# Covers: KB-041
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
HOOK = REPO / ".githooks" / "pre-commit"
SH = shutil.which("sh")


def test_hook_invokes_kb_anchor_gate_and_ors_status():
    text = HOOK.read_text(encoding="utf-8")
    pattern = r'python\s+"\$\{AW:-[^}]+\}/scripts/kb_anchor_gate\.py"\s+--repo\s+\.\s*\|\|\s*status=1'
    assert re.search(pattern, text), "kb_anchor_gate.py --repo . || status=1 missing"


@pytest.mark.skipif(SH is None, reason="sh unavailable")
def test_hook_fails_closed_naming_missing_gate_path(tmp_path):
    missing = tmp_path / "no-aw"
    work = tmp_path / "repo"
    work.mkdir()
    env = {**os.environ, "AW": missing.as_posix(), "GIT_CONFIG_GLOBAL": os.devnull}
    run = lambda *a: subprocess.run(a, cwd=work, env=env, capture_output=True, text=True)  # noqa: E731
    run("git", "init", "-q")
    proc = run(SH, str(HOOK))
    out = proc.stdout + proc.stderr
    assert proc.returncode != 0, out
    assert "kb_anchor_gate.py" in out and missing.as_posix() in out, out
