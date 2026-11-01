# Covers: MEM-071
# Requirement: a ruff lint error anywhere in the repo (tests or src, line-length 110) fails
# every pytest run -- including the merge-queue drain's affected-only run that targets a
# single test file, with or without a `-m` marker filter -- so a lint error can no longer
# reach main by bypassing scripts/check.sh; a clean repo still passes. The sanctioned
# `sh scripts/merge_branch.sh <worktree>` path, running the real scripts/check.sh, refuses
# a branch with a lint error before enqueueing it.
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
REAL_CONFTEST = REPO_ROOT / "tests" / "conftest.py"
REAL_CHECK = REPO_ROOT / "scripts" / "check.sh"
REAL_MERGE = REPO_ROOT / "scripts" / "merge_branch.sh"

SH = shutil.which("sh")
GIT = shutil.which("git")

PYPROJECT = """[project]
name = "lintgate-fixture"
version = "0.0.0"
requires-python = ">=3.13"

[tool.pytest.ini_options]
testpaths = ["tests"]

[tool.ruff]
line-length = 110

[tool.ruff.lint]
select = ["E", "F"]
"""

# A 111+ char line with whitespace (ruff's E501 skips single-word lines like bare URLs).
LONG_LINE = 'LONG = "' + "lorem ipsum " * 10 + '"\n'
assert len(LONG_LINE.rstrip("\n")) > 110

CLEAN_TEST = "def test_ok():\n    assert 1 + 1 == 2\n"
DIRTY_TEST = LONG_LINE + "\n\n" + CLEAN_TEST
CLEAN_MOD = "VALUE = 1\n"
DIRTY_MOD = LONG_LINE


def _write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8", newline="\n")


def _make_project(root: Path, *, test_src: str, mod_src: str) -> None:
    """Throwaway project carrying the repo's real tests/conftest.py (the lint gate)."""
    assert REAL_CONFTEST.is_file(), (
        f"lint gate missing: {REAL_CONFTEST} does not exist, so pytest runs carry no ruff lint item"
    )
    _write(root / "pyproject.toml", PYPROJECT)
    _write(root / "tests" / "conftest.py", REAL_CONFTEST.read_text(encoding="utf-8"))
    _write(root / "tests" / "test_target.py", test_src)
    _write(root / "src" / "pkg" / "__init__.py", "")
    _write(root / "src" / "pkg" / "mod.py", mod_src)


def _pytest(root: Path, *args: str) -> subprocess.CompletedProcess:
    env = {k: v for k, v in os.environ.items() if not k.startswith("PYTEST_")}
    return subprocess.run(
        [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", *args],
        cwd=str(root),
        env=env,
        capture_output=True,
        text=True,
        timeout=180,
    )


class TestPytestRejectsLintErrors:
    def test_targeted_test_file_with_long_line_fails_run(self, tmp_path):
        _make_project(tmp_path, test_src=DIRTY_TEST, mod_src=CLEAN_MOD)

        result = _pytest(tmp_path, "tests/test_target.py")

        out = result.stdout + result.stderr
        assert result.returncode != 0, out
        assert "E501" in out, out

    def test_src_long_line_fails_single_file_run(self, tmp_path):
        _make_project(tmp_path, test_src=CLEAN_TEST, mod_src=DIRTY_MOD)

        result = _pytest(tmp_path, "tests/test_target.py")

        out = result.stdout + result.stderr
        assert result.returncode != 0, out
        assert "E501" in out, out

    def test_clean_project_passes(self, tmp_path):
        _make_project(tmp_path, test_src=CLEAN_TEST, mod_src=CLEAN_MOD)

        result = _pytest(tmp_path, "tests/test_target.py")

        assert result.returncode == 0, result.stdout + result.stderr

    def test_marker_filter_does_not_drop_lint_check(self, tmp_path):
        _make_project(tmp_path, test_src=DIRTY_TEST, mod_src=CLEAN_MOD)

        result = _pytest(tmp_path, "-m", "not serial", "tests/test_target.py")

        out = result.stdout + result.stderr
        assert result.returncode != 0, out
        assert "E501" in out, out


# Fake enqueue command: logs that it ran.
FAKE_ENQUEUE = """#!/bin/sh
echo "enqueue" >> "$MERGE_TEST_LOG"
exit 0
"""


def _fake_uv() -> str:
    """`uv run X ...` -> `<this python> -m X ...`, so check.sh's ruff runs offline."""
    py = Path(sys.executable).as_posix()
    return f'#!/bin/sh\n[ "${{1:-}}" = run ] && shift\nexec "{py}" -m "$@"\n'


def _git(repo: Path, env: dict, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run([GIT, "-C", str(repo), *args], env=env, capture_output=True, text=True, timeout=60)


def _ok(result: subprocess.CompletedProcess) -> str:
    assert result.returncode == 0, result.stdout + result.stderr
    return result.stdout.strip()


def _commit(repo: Path, env: dict, files: dict, msg: str) -> None:
    for rel, content in files.items():
        _write(repo / rel, content)
    _ok(_git(repo, env, "add", "--", *files))
    _ok(_git(repo, env, "commit", "-q", "-m", msg))


# Covers: MEM-071
# Requirement: `sh scripts/merge_branch.sh <worktree>` with the real scripts/check.sh refuses a
# branch whose Python has a line over 110 chars: nonzero exit, ruff's E501 shown, never enqueued.
@pytest.mark.skipif(not (SH and GIT), reason="merge_branch.sh test needs sh and git")
class TestMergeBranchRejectsLintErrors:
    def test_long_line_branch_refused_before_enqueue(self, tmp_path):
        log = tmp_path / "calls.log"
        stub = tmp_path / "enqueue_stub.sh"
        _write(stub, FAKE_ENQUEUE)
        bin_dir = tmp_path / "bin"
        _write(bin_dir / "uv", _fake_uv())

        env = {k: v for k, v in os.environ.items() if not k.startswith(("FAKE_", "MEMRIPAL_", "PYTEST_"))}
        env.update(
            {
                "GIT_CONFIG_GLOBAL": os.devnull,
                "GIT_CONFIG_NOSYSTEM": "1",
                "GIT_AUTHOR_NAME": "Lint Test",
                "GIT_AUTHOR_EMAIL": "lint-test@example.invalid",
                "GIT_COMMITTER_NAME": "Lint Test",
                "GIT_COMMITTER_EMAIL": "lint-test@example.invalid",
                "MERGE_TEST_LOG": log.as_posix(),
                "MEMRIPAL_REQUEST_MERGE_CMD": f"sh {stub.as_posix()}",
                "PATH": str(bin_dir) + os.pathsep + os.environ.get("PATH", ""),
            }
        )

        primary = tmp_path / "primary"
        primary.mkdir()
        _ok(_git(primary, env, "init", "-q", "-b", "main"))
        for key, value in (("core.autocrlf", "false"), ("commit.gpgsign", "false")):
            _ok(_git(primary, env, "config", key, value))
        _commit(
            primary,
            env,
            {
                "pyproject.toml": PYPROJECT,
                "scripts/check.sh": REAL_CHECK.read_text(encoding="utf-8"),
                "scripts/merge_branch.sh": REAL_MERGE.read_text(encoding="utf-8"),
                "src/pkg/__init__.py": "",
                "src/pkg/mod.py": CLEAN_MOD,
            },
            "base",
        )
        wt = tmp_path / "wt"
        _ok(_git(primary, env, "worktree", "add", "-q", "-b", "feature", str(wt), "main"))
        _commit(wt, env, {"src/pkg/mod.py": DIRTY_MOD}, "long line")

        result = subprocess.run(
            [SH, (wt / "scripts" / "merge_branch.sh").as_posix(), wt.as_posix()],
            env=env,
            cwd=str(tmp_path),
            capture_output=True,
            text=True,
            timeout=180,
        )

        out = result.stdout + result.stderr
        assert result.returncode != 0, out
        assert "E501" in out, out
        assert not log.exists() or "enqueue" not in log.read_text(encoding="utf-8"), out
