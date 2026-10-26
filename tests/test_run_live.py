# Covers: MEM-009
# Requirement: scripts/run_live.ps1 decrypts a DPAPI-protected key file and hands the
# key (with MEMRIPAL_MODE=meta) only to the child process it launches, propagating the
# child's exit code; the key never appears on stdout/stderr or in the parent environment,
# and a missing key file fails fast with exit 2 without launching the child.
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
LAUNCHER = REPO_ROOT / "scripts" / "run_live.ps1"
POWERSHELL = shutil.which("powershell")

pytestmark = pytest.mark.skipif(
    sys.platform != "win32" or POWERSHELL is None, reason="DPAPI launcher is Windows-only"
)

# Built by concatenation so this file never matches the pre-commit secret scanner (MEM-004).
FAKE_KEY = "fake" + "-dpapi-" + "z" * 24
CHILD_MARKER = "child-ran"


def _ps_env() -> dict:
    """Parent env minus the key vars; PSModulePath pinned to Windows PowerShell's own modules.

    A PowerShell 7 PSModulePath inherited from the caller makes Windows PowerShell 5.1 fail to
    autoload Microsoft.PowerShell.Security (ConvertTo-SecureString), unrelated to the launcher.
    """
    env = {k: v for k, v in os.environ.items() if k not in ("META_API_KEY", "MEMRIPAL_MODE")}
    system_root = os.environ.get("SystemRoot", r"C:\Windows")
    env["PSModulePath"] = str(Path(system_root) / "System32" / "WindowsPowerShell" / "v1.0" / "Modules")
    return env


def _make_key_file(tmp_path: Path) -> Path:
    key_file = tmp_path / "meta-api-key.dpapi"
    command = (
        f"ConvertTo-SecureString -AsPlainText -Force '{FAKE_KEY}' | ConvertFrom-SecureString"
        f" | Set-Content -Path '{key_file}'"
    )
    subprocess.run(
        [POWERSHELL, "-NoProfile", "-NonInteractive", "-Command", command],
        env=_ps_env(),
        check=True,
        capture_output=True,
        timeout=60,
    )
    assert key_file.exists()
    assert FAKE_KEY not in key_file.read_text(encoding="utf-8", errors="replace")
    return key_file


def _launch(key_file: Path, code: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [
            POWERSHELL, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
            "-File", str(LAUNCHER), "-KeyFile", str(key_file), sys.executable, "-c", code,
        ],
        env=_ps_env(),
        capture_output=True,
        text=True,
        timeout=120,
    )


class TestRunLive:
    # Covers: MEM-009

    def test_child_receives_key_and_mode_without_leak(self, tmp_path):
        key_file = _make_key_file(tmp_path)
        code = "import os;print(len(os.environ['META_API_KEY']),os.environ['MEMRIPAL_MODE'])"
        proc = _launch(key_file, code)
        assert proc.returncode == 0, proc.stderr
        assert proc.stdout.strip().splitlines()[-1].strip() == f"{len(FAKE_KEY)} meta"
        assert FAKE_KEY not in proc.stdout
        assert FAKE_KEY not in proc.stderr
        assert "META_API_KEY" not in os.environ

    def test_child_exit_code_propagated(self, tmp_path):
        key_file = _make_key_file(tmp_path)
        proc = _launch(key_file, "import sys;sys.exit(7)")
        assert proc.returncode == 7

    def test_missing_key_file_exits_2_without_launching_child(self, tmp_path):
        missing = tmp_path / "absent.dpapi"
        proc = _launch(missing, f"print('{CHILD_MARKER}')")
        assert proc.returncode == 2
        assert proc.stderr.strip() != ""
        assert CHILD_MARKER not in proc.stdout
