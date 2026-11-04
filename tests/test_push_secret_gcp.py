# Covers: MEM-111
# Requirement: scripts/push_secret_gcp.ps1 <name> pushes one DPAPI-protected key
# ($HOME/.secrets/<name>.dpapi; name is meta-api-key, baseten-api-key or fireworks-api-key)
# to GCP Secret Manager through gcloud ($env:MEMRIPAL_GCLOUD, else gcloud.cmd). It first runs
# `secrets describe <name> --format=value(name)`; if that succeeds it adds a version
# (`secrets versions add <name> --data-file=-`), otherwise it creates the secret
# (`secrets create <name> --replication-policy=automatic --data-file=-`). The key reaches gcloud
# only as stdin bytes: UTF-8, no BOM, no trailing newline. It never appears in gcloud's argv or
# environment, nor in the script's own output. The exit code is the add/create call's exit code,
# and success prints `pushed <name>`. An unknown or missing name, or a missing key file, exits 2
# without running gcloud.
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "scripts" / "push_secret_gcp.ps1"
POWERSHELL = shutil.which("powershell")

pytestmark = pytest.mark.skipif(
    sys.platform != "win32" or POWERSHELL is None, reason="DPAPI push script is Windows-only"
)

NAMES = ("meta-api-key", "baseten-api-key", "fireworks-api-key")
# Built by concatenation so this file never matches the pre-commit secret scanner (MEM-004).
KEYS = {name: "fake" + "-gcp-" + name[:4] + "-" + "q" * 24 for name in NAMES}
# Non-ASCII plaintext: proves the stdin bytes are UTF-8 (2 bytes for U+00E9), not ANSI/UTF-16.
NON_ASCII_KEY = "fake" + "-gcp-caf\u00e9-" + "n" * 20

# Fake gcloud: logs argv, raw stdin bytes and whether the key leaked into its env, one call per
# line in calls.jsonl; exits with the code configured in exits.json for that subcommand.
RECORDER = r"""
import json, os, sys
state = sys.argv[1]
argv = sys.argv[2:]
data = sys.stdin.buffer.read()
calls = os.path.join(state, "calls.jsonl")
n = 0
if os.path.exists(calls):
    with open(calls, encoding="utf-8") as fh:
        n = sum(1 for _ in fh)
with open(os.path.join(state, "stdin-%d.bin" % n), "wb") as fh:
    fh.write(data)
with open(os.path.join(state, "expect_key.txt"), encoding="utf-8") as fh:
    key = fh.read()
env_has_key = any(key in v for v in os.environ.values())
with open(calls, "a", encoding="utf-8") as fh:
    fh.write(json.dumps({"argv": argv, "env_has_key": env_has_key}) + "\n")
with open(os.path.join(state, "exits.json"), encoding="utf-8") as fh:
    exits = json.load(fh)
kind = "describe" if argv[1:2] == ["describe"] else ("versions" if argv[1:2] == ["versions"] else "create")
sys.exit(int(exits.get(kind, 0)))
"""


def _ps_env() -> dict:
    """Parent env minus key/gcloud vars; PSModulePath pinned to Windows PowerShell's own modules."""
    drop = ("META_API_KEY", "BASETEN_API_KEY", "FIREWORKS_API_KEY", "MEMRIPAL_GCLOUD")
    env = {k: v for k, v in os.environ.items() if k not in drop}
    system_root = os.environ.get("SystemRoot", r"C:\Windows")
    env["PSModulePath"] = str(Path(system_root) / "System32" / "WindowsPowerShell" / "v1.0" / "Modules")
    return env


def _encrypt_to(path: Path, plaintext: str, trailing_blank_lines: int = 0) -> None:
    """DPAPI CurrentUser ciphertext, same format scripts/run_live.ps1 decrypts."""
    path.parent.mkdir(parents=True, exist_ok=True)
    escaped = plaintext.replace("'", "''")
    command = (
        f"ConvertTo-SecureString -AsPlainText -Force '{escaped}' | ConvertFrom-SecureString"
        f" | Set-Content -Path '{path}'"
    )
    subprocess.run(
        [POWERSHELL, "-NoProfile", "-NonInteractive", "-Command", command],
        env=_ps_env(),
        check=True,
        capture_output=True,
        timeout=60,
    )
    if trailing_blank_lines:
        with open(path, "ab") as fh:
            fh.write(b"\r\n" * trailing_blank_lines)
    assert path.exists()
    assert plaintext not in path.read_text(encoding="utf-8", errors="replace")


class FakeGcloud:
    def __init__(
        self,
        root: Path,
        key: str,
        describe_exit: int = 0,
        add_exit: int = 0,
        create_exit: int = 0,
        shim_name: str = "fake-gcloud.cmd",
    ):
        self.state = root / "gcloud-state"
        self.state.mkdir(parents=True)
        recorder = self.state / "recorder.py"
        recorder.write_text(RECORDER, encoding="utf-8")
        (self.state / "expect_key.txt").write_text(key, encoding="utf-8")
        (self.state / "exits.json").write_text(
            json.dumps({"describe": describe_exit, "versions": add_exit, "create": create_exit}),
            encoding="utf-8",
        )
        self.bin_dir = root / "gcloud-bin"
        self.bin_dir.mkdir(parents=True)
        self.shim = self.bin_dir / shim_name
        self.shim.write_text(
            f'@echo off\r\n"{sys.executable}" "{recorder}" "{self.state}" %*\r\nexit /b %ERRORLEVEL%\r\n',
            encoding="ascii",
        )

    def calls(self) -> list:
        log = self.state / "calls.jsonl"
        if not log.exists():
            return []
        lines = log.read_text(encoding="utf-8").splitlines()
        return [json.loads(line) for line in lines if line.strip()]

    def stdin_of(self, index: int) -> bytes:
        return (self.state / f"stdin-{index}.bin").read_bytes()


def _home_with(tmp_path: Path, keys: dict, trailing_blank_lines: int = 0) -> Path:
    """A stand-in $HOME (never the real ~/.secrets) holding the given names' DPAPI key files."""
    home = tmp_path / "home"
    (home / ".secrets").mkdir(parents=True)
    for name, key in keys.items():
        _encrypt_to(home / ".secrets" / f"{name}.dpapi", key, trailing_blank_lines)
    return home


class DpZeroGcloud(FakeGcloud):
    """A gcloud.cmd that, like the real one (`%~dp0..\\lib\\gcloud.py`), finds its helper and
    state via %~dp0, so it records calls only when %~dp0 is its own install dir."""

    def __init__(self, root: Path, key: str, describe_exit: int = 0):
        self.bin_dir = root / "gcloud-bin"
        self.bin_dir.mkdir(parents=True)
        self.state = self.bin_dir
        (self.bin_dir / "recorder.py").write_text(RECORDER, encoding="utf-8")
        (self.bin_dir / "expect_key.txt").write_text(key, encoding="utf-8")
        (self.bin_dir / "exits.json").write_text(
            json.dumps({"describe": describe_exit, "versions": 0, "create": 0}), encoding="utf-8"
        )
        self.shim = self.bin_dir / "gcloud.cmd"
        # "%~dp0." not "%~dp0": a trailing backslash before the closing quote escapes it.
        self.shim.write_text(
            f'@echo off\r\n"{sys.executable}" "%~dp0recorder.py" "%~dp0." %*\r\nexit /b %ERRORLEVEL%\r\n',
            encoding="ascii",
        )


def _push(
    home: Path,
    args: list,
    gcloud: FakeGcloud,
    via_env: bool = True,
    cwd: Path = None,
    gcloud_env: str = None,
) -> subprocess.CompletedProcess:
    env = _ps_env()
    env["USERPROFILE"] = str(home)
    env["HOME"] = str(home)
    if via_env:
        env["MEMRIPAL_GCLOUD"] = str(gcloud.shim)
    else:
        env["PATH"] = str(gcloud.bin_dir) + os.pathsep + env.get("PATH", "")
        if gcloud_env is not None:
            env["MEMRIPAL_GCLOUD"] = gcloud_env
    return subprocess.run(
        [
            POWERSHELL,
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(SCRIPT),
            *args,
        ],
        env=env,
        cwd=str(cwd) if cwd is not None else None,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        timeout=120,
    )


def _out(proc: subprocess.CompletedProcess) -> str:
    return (proc.stdout + proc.stderr).decode("utf-8", errors="replace")


def _assert_no_leak(proc: subprocess.CompletedProcess, gcloud: FakeGcloud, key: str) -> None:
    key_bytes = key.encode("utf-8")
    assert key_bytes not in proc.stdout
    assert key_bytes not in proc.stderr
    assert key not in _out(proc)
    for call in gcloud.calls():
        assert all(key not in arg for arg in call["argv"]), call["argv"]
        assert call["env_has_key"] is False


def _describe_argv(name: str) -> list:
    return ["secrets", "describe", name, "--format=value(name)"]


class TestPushSecretGcpRouting:
    # Covers: MEM-111

    @pytest.mark.parametrize("name", NAMES)
    def test_existing_secret_gets_new_version_from_stdin(self, tmp_path, name):
        key = KEYS[name]
        home = _home_with(tmp_path, {name: key})
        gcloud = FakeGcloud(tmp_path, key, describe_exit=0)

        proc = _push(home, [name], gcloud)

        assert proc.returncode == 0, _out(proc)
        calls = gcloud.calls()
        assert [c["argv"] for c in calls] == [
            _describe_argv(name),
            ["secrets", "versions", "add", name, "--data-file=-"],
        ]
        assert gcloud.stdin_of(1) == key.encode("utf-8")
        assert f"pushed {name}" in _out(proc)
        _assert_no_leak(proc, gcloud, key)

    @pytest.mark.parametrize("name", NAMES)
    def test_missing_secret_is_created_from_stdin(self, tmp_path, name):
        key = KEYS[name]
        home = _home_with(tmp_path, {name: key})
        gcloud = FakeGcloud(tmp_path, key, describe_exit=1)

        proc = _push(home, [name], gcloud)

        assert proc.returncode == 0, _out(proc)
        calls = gcloud.calls()
        assert [c["argv"] for c in calls] == [
            _describe_argv(name),
            ["secrets", "create", name, "--replication-policy=automatic", "--data-file=-"],
        ]
        assert gcloud.stdin_of(1) == key.encode("utf-8")
        assert f"pushed {name}" in _out(proc)
        _assert_no_leak(proc, gcloud, key)

    def test_default_gcloud_is_gcloud_cmd_on_path(self, tmp_path):
        name = "baseten-api-key"
        key = KEYS[name]
        home = _home_with(tmp_path, {name: key})
        gcloud = FakeGcloud(tmp_path, key, describe_exit=0, shim_name="gcloud.cmd")

        proc = _push(home, [name], gcloud, via_env=False)

        assert proc.returncode == 0, _out(proc)
        assert [c["argv"][:3] for c in gcloud.calls()] == [
            ["secrets", "describe", name],
            ["secrets", "versions", "add"],
        ]
        _assert_no_leak(proc, gcloud, key)


class TestPushSecretGcpBareGcloudOnPath:
    # Covers: MEM-111
    # Requirement: with $env:MEMRIPAL_GCLOUD unset or a bare name (gcloud.cmd), the push still
    # works from any working directory: the real gcloud.cmd locates its Python entry point via
    # %~dp0, so it must be launched by its resolved full path on PATH, never by bare name
    # (which makes %~dp0 the caller's cwd: "can't open file ...\lib\gcloud.py", exit 2).

    @pytest.mark.parametrize("gcloud_env", [None, "gcloud.cmd"], ids=["unset", "bare-name"])
    def test_bare_gcloud_cmd_runs_from_its_own_dir_not_cwd(self, tmp_path, gcloud_env):
        name = "meta-api-key"
        key = KEYS[name]
        home = _home_with(tmp_path, {name: key})
        gcloud = DpZeroGcloud(tmp_path, key, describe_exit=0)
        elsewhere = tmp_path / "elsewhere-cwd"
        elsewhere.mkdir()

        proc = _push(home, [name], gcloud, via_env=False, cwd=elsewhere, gcloud_env=gcloud_env)

        assert proc.returncode == 0, _out(proc)
        assert [c["argv"] for c in gcloud.calls()] == [
            _describe_argv(name),
            ["secrets", "versions", "add", name, "--data-file=-"],
        ]
        assert gcloud.stdin_of(1) == key.encode("utf-8")
        assert f"pushed {name}" in _out(proc)
        _assert_no_leak(proc, gcloud, key)


class TestPushSecretGcpStdinBytes:
    # Covers: MEM-111

    def test_non_ascii_key_is_sent_as_utf8_without_bom(self, tmp_path):
        name = "fireworks-api-key"
        home = _home_with(tmp_path, {name: NON_ASCII_KEY})
        gcloud = FakeGcloud(tmp_path, NON_ASCII_KEY, describe_exit=0)

        proc = _push(home, [name], gcloud)

        assert proc.returncode == 0, _out(proc)
        sent = gcloud.stdin_of(1)
        assert sent == NON_ASCII_KEY.encode("utf-8")
        assert not sent.startswith(b"\xef\xbb\xbf")
        _assert_no_leak(proc, gcloud, NON_ASCII_KEY)

    def test_trailing_newlines_in_key_file_never_reach_stdin(self, tmp_path):
        # Set-Content already ends the ciphertext with CRLF; extra blank lines make a naive
        # read-and-pipe (or PowerShell's own pipe-to-native newline) visible in the bytes.
        name = "meta-api-key"
        key = KEYS[name]
        home = _home_with(tmp_path, {name: key}, trailing_blank_lines=3)
        gcloud = FakeGcloud(tmp_path, key, describe_exit=1)

        proc = _push(home, [name], gcloud)

        assert proc.returncode == 0, _out(proc)
        sent = gcloud.stdin_of(1)
        assert sent == key.encode("utf-8")
        assert not sent.endswith((b"\n", b"\r"))
        _assert_no_leak(proc, gcloud, key)

    def test_describe_call_receives_no_key_on_stdin(self, tmp_path):
        name = "baseten-api-key"
        key = KEYS[name]
        home = _home_with(tmp_path, {name: key})
        gcloud = FakeGcloud(tmp_path, key, describe_exit=0)

        proc = _push(home, [name], gcloud)

        assert proc.returncode == 0, _out(proc)
        assert key.encode("utf-8") not in gcloud.stdin_of(0)


class TestPushSecretGcpExitCodes:
    # Covers: MEM-111

    def test_versions_add_failure_propagates_exit_code(self, tmp_path):
        name = "meta-api-key"
        key = KEYS[name]
        home = _home_with(tmp_path, {name: key})
        gcloud = FakeGcloud(tmp_path, key, describe_exit=0, add_exit=5)

        proc = _push(home, [name], gcloud)

        assert proc.returncode == 5, _out(proc)
        assert len(gcloud.calls()) == 2
        _assert_no_leak(proc, gcloud, key)

    def test_create_failure_propagates_exit_code(self, tmp_path):
        name = "fireworks-api-key"
        key = KEYS[name]
        home = _home_with(tmp_path, {name: key})
        gcloud = FakeGcloud(tmp_path, key, describe_exit=1, create_exit=6)

        proc = _push(home, [name], gcloud)

        assert proc.returncode == 6, _out(proc)
        assert gcloud.calls()[1]["argv"][:2] == ["secrets", "create"]
        _assert_no_leak(proc, gcloud, key)

    @pytest.mark.parametrize(
        "args",
        [[], ["other-api-key"], ["META-API-KEY"], ["meta-api-key.dpapi"], ["../meta-api-key"], [""]],
        ids=["missing", "unknown", "uppercase", "with-ext", "traversal", "empty"],
    )
    def test_invalid_name_exits_2_without_gcloud(self, tmp_path, args):
        home = _home_with(tmp_path, dict(KEYS))
        gcloud = FakeGcloud(tmp_path, KEYS["meta-api-key"])

        proc = _push(home, args, gcloud)

        assert proc.returncode == 2, _out(proc)
        assert gcloud.calls() == []
        for key in KEYS.values():
            assert key not in _out(proc)

    def test_missing_key_file_exits_2_without_gcloud(self, tmp_path):
        home = _home_with(tmp_path, {"meta-api-key": KEYS["meta-api-key"]})
        gcloud = FakeGcloud(tmp_path, KEYS["baseten-api-key"])

        proc = _push(home, ["baseten-api-key"], gcloud)

        assert proc.returncode == 2, _out(proc)
        assert gcloud.calls() == []
