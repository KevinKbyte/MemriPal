# Requirement: ADR citations in docs/decisions must resolve; the agent-workflow
# dangling_paths.py check (KB-041), scoped to docs/decisions/*.md via
# DANGLING_PATHS_DOCS, must exit 0 against this repo.
# Covers: KB-041
import os
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
AW = Path(os.environ.get("AW") or Path.home() / "projects" / "agent-workflow")
SCRIPT = AW / "scripts" / "dangling_paths.py"


@pytest.mark.skipif(
    not SCRIPT.is_file(),
    reason=f"SKIPPED: agent-workflow checkout absent, {SCRIPT} not found (set AW to its path)",
)
def test_dangling_paths_check_clean():
    docs = sorted(p.relative_to(REPO).as_posix() for p in (REPO / "docs" / "decisions").glob("*.md"))
    # A blank DANGLING_PATHS_DOCS means a full-repo scan, so an empty glob must fail loudly.
    assert docs, "no docs/decisions/*.md found"
    env = {**os.environ, "DANGLING_PATHS_DOCS": "\n".join(docs)}
    proc = subprocess.run(
        [sys.executable, str(SCRIPT), "check"],
        cwd=REPO,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
