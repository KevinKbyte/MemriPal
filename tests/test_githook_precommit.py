# Covers: MEM-004
# Requirement: with core.hooksPath pointing at .githooks, `git commit` is blocked when a
# staged file holds a secret-shaped string or a staged .py file is not ruff-formatted
# (paths with spaces included), succeeds for clean formatted Python, and never invokes
# ruff when no .py file is staged.
# Regression: the ruff format step is a chore extension of the MEM-004 scan hook
# (commit "chore(githooks): reject unformatted staged python"); this locks both halves.
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
HOOK = REPO_ROOT / ".githooks" / "pre-commit"
SCAN = REPO_ROOT / "scripts" / "precommit_scan.py"

SH = shutil.which("sh")
GIT = shutil.which("git")
UV = shutil.which("uv")

pytestmark = pytest.mark.skipif(
    not (SH and GIT and UV), reason="pre-commit hook integration test needs sh, git and uv"
)

# Built by concatenation so this file never matches the pre-commit secret scanner (MEM-004).
SECRET_LINE = 'API = "' + "sk" + "-" + "A1b2C3d4E5f6G7h8I9j0K1" + '"\n'


def _git(repo: Path, env: dict, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [GIT, "-C", str(repo), *args],
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )


@pytest.fixture
def hook_repo(tmp_path):
    repo = tmp_path / "repo"
    (repo / ".githooks").mkdir(parents=True)
    (repo / "scripts").mkdir()
    hook = repo / ".githooks" / "pre-commit"
    shutil.copyfile(HOOK, hook)
    hook.chmod(0o755)
    shutil.copyfile(SCAN, repo / "scripts" / "precommit_scan.py")

    # A `uv` stub ahead of the real one records each invocation, then delegates.
    stub_dir = tmp_path / "stub bin"
    stub_dir.mkdir()
    log = tmp_path / "uv_calls.log"
    real_uv = Path(UV).as_posix()
    stub = stub_dir / "uv"
    stub.write_text(
        f'#!/bin/sh\necho "$*" >> "{log.as_posix()}"\nexec "{real_uv}" "$@"\n',
        encoding="ascii",
        newline="\n",
    )
    stub.chmod(0o755)

    env = dict(os.environ)
    env["PATH"] = os.pathsep.join([str(stub_dir), str(Path(sys.executable).parent), env.get("PATH", "")])
    env["GIT_CONFIG_GLOBAL"] = os.devnull
    env["GIT_CONFIG_NOSYSTEM"] = "1"
    env["UV_OFFLINE"] = "1"
    env["UV_NO_PROGRESS"] = "1"

    assert _git(repo, env, "init", "-q").returncode == 0
    for key, value in (
        ("user.name", "Hook Test"),
        ("user.email", "hook-test@example.invalid"),
        ("core.hooksPath", ".githooks"),
        ("core.autocrlf", "false"),
        ("commit.gpgsign", "false"),
    ):
        assert _git(repo, env, "config", key, value).returncode == 0
    return repo, env, log


def _commit(repo: Path, env: dict, rel: str, content: str) -> subprocess.CompletedProcess:
    target = repo / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8", newline="\n")
    assert _git(repo, env, "add", "--", rel).returncode == 0
    return _git(repo, env, "commit", "-q", "-m", "test commit")


def _uv_calls(log: Path) -> str:
    return log.read_text(encoding="utf-8") if log.exists() else ""


class TestGithookPrecommit:
    def test_unformatted_py_with_space_in_path_fails(self, hook_repo):
        repo, env, log = hook_repo
        result = _commit(repo, env, "pkg dir/bad mod.py", "x=1\n")
        assert result.returncode != 0, result.stdout + result.stderr
        assert "ruff format" in _uv_calls(log)
        assert "bad mod.py" in result.stdout + result.stderr

    def test_formatted_py_passes(self, hook_repo):
        repo, env, log = hook_repo
        result = _commit(repo, env, "good.py", "x = 1\n")
        assert result.returncode == 0, result.stdout + result.stderr
        assert "ruff format" in _uv_calls(log)

    def test_non_py_only_passes_without_invoking_ruff(self, hook_repo):
        repo, env, log = hook_repo
        result = _commit(repo, env, "notes.md", "# Notes\n\nplain text\n")
        assert result.returncode == 0, result.stdout + result.stderr
        assert _uv_calls(log) == ""

    def test_formatted_py_with_secret_fails(self, hook_repo):
        repo, env, _log = hook_repo
        result = _commit(repo, env, "leaky.py", SECRET_LINE)
        assert result.returncode != 0, result.stdout + result.stderr
        assert "precommit_scan" in result.stderr
        assert "leaky.py" in result.stderr
