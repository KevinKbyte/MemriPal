# Requirement: ADR citations in docs/decisions must resolve; the agent-workflow
# dangling_paths.py check (KB-041) must exit 0 against this repo.
# Covers: KB-041
import os
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
AW = Path(os.environ.get("AW", "C:/Users/Kev/projects/agent-workflow"))
SCRIPT = AW / "scripts" / "dangling_paths.py"


@pytest.mark.skipif(
    not SCRIPT.is_file(),
    reason=f"agent-workflow checkout absent: {SCRIPT} not found (set AW)",
)
def test_dangling_paths_check_clean():
    proc = subprocess.run(
        [sys.executable, str(SCRIPT), "check"],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
