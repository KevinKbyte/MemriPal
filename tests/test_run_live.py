# Covers: MEM-009
# Requirement: scripts/run_live.ps1 decrypts a DPAPI-protected key file and hands the
# key (with MEMRIPAL_MODE=meta) only to the child process it launches, propagating the
# child's exit code; the key never appears on stdout/stderr or in the parent environment,
# and a missing key file fails fast with exit 2 without launching the child.
import hashlib
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
            POWERSHELL,
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(LAUNCHER),
            "-KeyFile",
            str(key_file),
            sys.executable,
            "-c",
            code,
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


BASETEN_KEY = "fake" + "-baseten-" + "b" * 24
FIREWORKS_KEY = "fake" + "-fireworks-" + "f" * 24
PROVIDER_KEYS = {"baseten": BASETEN_KEY, "fireworks": FIREWORKS_KEY}
KEY_VARS = ("META_API_KEY", "BASETEN_API_KEY", "FIREWORKS_API_KEY")
# Prints a sha256 per key var ("-" when absent), so the child proves what it got without printing a key.
HASH_CODE = (
    "import os,hashlib;print(*[hashlib.sha256(os.environ[n].encode()).hexdigest()"
    " if n in os.environ else '-' for n in " + repr(KEY_VARS) + "])"
)


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def _encrypt_to(path: Path, plaintext: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    command = (
        f"ConvertTo-SecureString -AsPlainText -Force '{plaintext}' | ConvertFrom-SecureString"
        f" | Set-Content -Path '{path}'"
    )
    subprocess.run(
        [POWERSHELL, "-NoProfile", "-NonInteractive", "-Command", command],
        env=_ps_env(),
        check=True,
        capture_output=True,
        timeout=60,
    )
    assert path.exists()


def _fake_home(tmp_path: Path, providers=("baseten", "fireworks")) -> Path:
    """A stand-in $HOME (never the real ~/.secrets) holding the named providers' DPAPI key files."""
    home = tmp_path / "home"
    (home / ".secrets").mkdir(parents=True)
    for name in providers:
        _encrypt_to(home / ".secrets" / f"{name}-api-key.dpapi", PROVIDER_KEYS[name])
    return home


def _launch_as(home: Path, provider: str | None, code: str, tmp_path: Path) -> subprocess.CompletedProcess:
    meta_file = tmp_path / "meta-api-key.dpapi"
    if not meta_file.exists():
        _encrypt_to(meta_file, FAKE_KEY)
    env = {k: v for k, v in _ps_env().items() if k not in KEY_VARS + ("MEMRIPAL_CHAT_PROVIDER",)}
    env["USERPROFILE"] = str(home)
    env["HOME"] = str(home)
    if provider is not None:
        env["MEMRIPAL_CHAT_PROVIDER"] = provider
    return subprocess.run(
        [
            POWERSHELL,
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(LAUNCHER),
            "-KeyFile",
            str(meta_file),
            sys.executable,
            "-c",
            code,
        ],
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )


def _assert_no_key_printed(proc: subprocess.CompletedProcess) -> None:
    for key in (FAKE_KEY, BASETEN_KEY, FIREWORKS_KEY):
        assert key not in proc.stdout
        assert key not in proc.stderr


# Covers: MEM-026
# Requirement: scripts/run_live.ps1 also loads the selected chat provider's key (item 43, D12):
# MEMRIPAL_CHAT_PROVIDER=baseten decrypts $HOME/.secrets/baseten-api-key.dpapi into the child's
# BASETEN_API_KEY, fireworks decrypts fireworks-api-key.dpapi into FIREWORKS_API_KEY; meta, unset
# and local load no extra key. META_API_KEY is loaded every time (SAM stays on Meta). A missing
# provider key file fails with a clear error naming the file and a non-zero exit, without
# launching the child; no key is ever printed.
class TestRunLiveChatProviderKey:
    @pytest.mark.parametrize("provider", ["baseten", "fireworks"])
    def test_selected_provider_key_reaches_child_with_meta_key(self, tmp_path, provider):
        home = _fake_home(tmp_path)

        proc = _launch_as(home, provider, HASH_CODE, tmp_path)

        assert proc.returncode == 0, proc.stderr
        meta, baseten, fireworks = proc.stdout.strip().splitlines()[-1].split()
        assert meta == _sha(FAKE_KEY)
        assert baseten == (_sha(BASETEN_KEY) if provider == "baseten" else "-")
        assert fireworks == (_sha(FIREWORKS_KEY) if provider == "fireworks" else "-")
        _assert_no_key_printed(proc)

    @pytest.mark.parametrize("provider", [None, "meta", "local"], ids=["unset", "meta", "local"])
    def test_meta_unset_and_local_load_only_meta_key(self, tmp_path, provider):
        home = _fake_home(tmp_path)

        proc = _launch_as(home, provider, HASH_CODE, tmp_path)

        assert proc.returncode == 0, proc.stderr
        assert proc.stdout.strip().splitlines()[-1].split() == [_sha(FAKE_KEY), "-", "-"]
        _assert_no_key_printed(proc)

    @pytest.mark.parametrize("provider", ["baseten", "fireworks"])
    def test_missing_provider_key_file_fails_without_launching_child(self, tmp_path, provider):
        other = "fireworks" if provider == "baseten" else "baseten"
        home = _fake_home(tmp_path, providers=(other,))

        proc = _launch_as(home, provider, f"print('{CHILD_MARKER}')", tmp_path)

        assert proc.returncode != 0
        assert f"{provider}-api-key.dpapi" in proc.stderr
        assert CHILD_MARKER not in proc.stdout
        _assert_no_key_printed(proc)
