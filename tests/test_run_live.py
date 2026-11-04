# Covers: MEM-009
# Requirement: scripts/run_live.ps1 decrypts a DPAPI-protected key file and hands the
# key (with MEMRIPAL_MODE=meta) only to the child process it launches, propagating the
# child's exit code; the key never appears on stdout/stderr or in the parent environment,
# and a missing key file fails fast with exit 2 without launching the child.
import hashlib
import os
import re
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


MAPILLARY_VAR = "MEMRIPAL_MAPILLARY_TOKEN"
MAPILLARY_TOKEN = "fake" + "-mapillary-" + "m" * 24
PARENT_PLACEHOLDER = "parent" + "-placeholder-" + "p" * 12
DOTENV_TOKEN = "fake" + "-dotenv-" + "d" * 24
# Prints the token's sha256 ("-" when absent), so the child proves what it got without printing it.
MAPILLARY_HASH_CODE = (
    "import os,hashlib;v=os.environ.get(" + repr(MAPILLARY_VAR) + ");"
    "print(hashlib.sha256(v.encode()).hexdigest() if v is not None else '-')"
)


def _mapillary_home(tmp_path: Path, with_token: bool) -> Path:
    """A stand-in $HOME (never the real ~/.secrets), holding mapillary-token.dpapi only when asked."""
    home = tmp_path / "home"
    (home / ".secrets").mkdir(parents=True)
    if with_token:
        _encrypt_to(home / ".secrets" / "mapillary-token.dpapi", MAPILLARY_TOKEN)
    return home


def _launch_mapillary(
    home: Path, tmp_path: Path, parent_token: str | None = None, cwd: Path | None = None
) -> subprocess.CompletedProcess:
    meta_file = tmp_path / "meta-api-key.dpapi"
    if not meta_file.exists():
        _encrypt_to(meta_file, FAKE_KEY)
    drop = KEY_VARS + ("MEMRIPAL_CHAT_PROVIDER", MAPILLARY_VAR)
    env = {k: v for k, v in _ps_env().items() if k not in drop}
    env["USERPROFILE"] = str(home)
    env["HOME"] = str(home)
    if parent_token is not None:
        env[MAPILLARY_VAR] = parent_token
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
            MAPILLARY_HASH_CODE,
        ],
        env=env,
        cwd=str(cwd) if cwd is not None else None,
        capture_output=True,
        text=True,
        timeout=120,
    )


def _assert_no_mapillary_token_printed(proc: subprocess.CompletedProcess) -> None:
    for secret in (MAPILLARY_TOKEN, DOTENV_TOKEN, FAKE_KEY):
        assert secret not in proc.stdout
        assert secret not in proc.stderr


# Covers: MEM-098
# Requirement: scripts/run_live.ps1 decrypts $HOME/.secrets/mapillary-token.dpapi into
# MEMRIPAL_MAPILLARY_TOKEN for the child process only, when that file exists (ADR 0064, ADR 0005
# custody); the decrypted token replaces any parent-provided value, like META_API_KEY. When the file is
# absent the child still launches without the variable. The token is never echoed or logged, never set
# in the launcher's own environment, and never read from a .env file.
class TestRunLiveMapillaryToken:
    def test_token_file_decrypted_into_child_env_without_leak(self, tmp_path):
        home = _mapillary_home(tmp_path, with_token=True)

        proc = _launch_mapillary(home, tmp_path)

        assert proc.returncode == 0, proc.stderr
        assert proc.stdout.strip().splitlines()[-1].strip() == _sha(MAPILLARY_TOKEN)
        _assert_no_mapillary_token_printed(proc)
        assert MAPILLARY_VAR not in os.environ

    def test_decrypted_token_replaces_parent_placeholder(self, tmp_path):
        home = _mapillary_home(tmp_path, with_token=True)

        proc = _launch_mapillary(home, tmp_path, parent_token=PARENT_PLACEHOLDER)

        assert proc.returncode == 0, proc.stderr
        assert proc.stdout.strip().splitlines()[-1].strip() == _sha(MAPILLARY_TOKEN)
        _assert_no_mapillary_token_printed(proc)

    def test_absent_token_file_launches_child_without_token(self, tmp_path):
        home = _mapillary_home(tmp_path, with_token=False)

        proc = _launch_mapillary(home, tmp_path)

        assert proc.returncode == 0, proc.stderr
        assert proc.stdout.strip().splitlines()[-1].strip() == "-"
        _assert_no_mapillary_token_printed(proc)

    def test_token_never_read_from_dotenv(self, tmp_path):
        home = _mapillary_home(tmp_path, with_token=False)
        workdir = tmp_path / "work"
        workdir.mkdir()
        line = f"{MAPILLARY_VAR}={DOTENV_TOKEN}\n"
        for folder in (workdir, home, home / ".secrets"):
            (folder / ".env").write_text(line, encoding="ascii")

        proc = _launch_mapillary(home, tmp_path, cwd=workdir)

        assert proc.returncode == 0, proc.stderr
        assert proc.stdout.strip().splitlines()[-1].strip() == "-"
        _assert_no_mapillary_token_printed(proc)

    def test_launcher_never_sets_token_in_own_env_or_reads_dotenv(self):
        source = LAUNCHER.read_text(encoding="utf-8")
        assert "mapillary-token.dpapi" in source
        assert not re.search(r"\$env:" + MAPILLARY_VAR + r"\s*=", source, re.IGNORECASE)
        assert not re.search(r"SetEnvironmentVariable\([^)]*" + MAPILLARY_VAR, source, re.IGNORECASE)
        assert not re.search(r"(?<![\w$])\.env\b", source)

    def test_help_block_cites_adr_0064_for_mapillary_token(self):
        source = LAUNCHER.read_text(encoding="utf-8")
        start, end = source.find("<#"), source.find("#>")
        assert 0 <= start < end, "run_live.ps1 lost its <# ... #> help block"
        help_block = source[start:end]
        lines = help_block.splitlines()
        at = [i for i, line in enumerate(lines) if "mapillary-token.dpapi" in line]
        assert at, "the help block no longer documents mapillary-token.dpapi"
        mapillary = " ".join(lines[at[0] :])
        assert "ADR 0064" in mapillary, f"the Mapillary token help cites no ADR 0064: {mapillary!r}"
        assert "ADR 0054" not in help_block, "the help block still cites ADR 0054 (real-map resize observer)"
