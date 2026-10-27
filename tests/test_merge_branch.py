# Covers: (spec ID pending: merge_branch script)
# Requirement: `sh scripts/merge_branch.sh <worktree>` merges a branch in one command: it
# refuses a dirty worktree (naming the dirty paths), rebases onto main (aborting cleanly on
# conflict), runs the worktree's scripts/check.sh and enqueues only if it passes, propagates
# the enqueue exit code, and after a successful merge runs the primary checkout's
# scripts/check.sh and exits with its code; a missing or invalid argument prints usage and
# exits 2.
import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
MERGE_SCRIPT = REPO_ROOT / "scripts" / "merge_branch.sh"

SH = shutil.which("sh")
GIT = shutil.which("git")

pytestmark = pytest.mark.skipif(not (SH and GIT), reason="merge_branch.sh test needs sh and git")

# Fake check.sh: logs which branch it ran on, exits with a per-location code from the env.
FAKE_CHECK = """#!/bin/sh
branch=$(git -C "$(dirname "$0")" rev-parse --abbrev-ref HEAD)
echo "check:$branch" >> "$MERGE_TEST_LOG"
case "$branch" in
  main) exit "${FAKE_MAIN_CHECK_RC:-0}" ;;
  *) exit "${FAKE_WT_CHECK_RC:-0}" ;;
esac
"""

# Fake enqueue command: logs that it ran, exits with a configurable code.
FAKE_ENQUEUE = """#!/bin/sh
echo "enqueue" >> "$MERGE_TEST_LOG"
exit "${FAKE_ENQUEUE_RC:-0}"
"""


def _git(repo: Path, env: dict, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [GIT, "-C", str(repo), *args],
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )


def _ok(result: subprocess.CompletedProcess) -> str:
    assert result.returncode == 0, result.stdout + result.stderr
    return result.stdout.strip()


def _commit_file(repo: Path, env: dict, rel: str, content: str, msg: str) -> None:
    target = repo / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8", newline="\n")
    _ok(_git(repo, env, "add", "--", rel))
    _ok(_git(repo, env, "commit", "-q", "-m", msg))


@pytest.fixture
def repos(tmp_path):
    """Primary checkout on main plus a linked worktree on `feature` one commit ahead."""
    log = tmp_path / "calls.log"
    stub = tmp_path / "enqueue_stub.sh"
    stub.write_text(FAKE_ENQUEUE, encoding="ascii", newline="\n")

    env = {k: v for k, v in os.environ.items() if not k.startswith(("FAKE_", "MEMRIPAL_"))}
    env.update(
        {
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_AUTHOR_NAME": "Merge Test",
            "GIT_AUTHOR_EMAIL": "merge-test@example.invalid",
            "GIT_COMMITTER_NAME": "Merge Test",
            "GIT_COMMITTER_EMAIL": "merge-test@example.invalid",
            "MERGE_TEST_LOG": log.as_posix(),
            "MEMRIPAL_REQUEST_MERGE_CMD": f"sh {stub.as_posix()}",
        }
    )

    primary = tmp_path / "primary"
    primary.mkdir()
    _ok(_git(primary, env, "init", "-q", "-b", "main"))
    for key, value in (("core.autocrlf", "false"), ("commit.gpgsign", "false")):
        _ok(_git(primary, env, "config", key, value))
    _commit_file(primary, env, "scripts/check.sh", FAKE_CHECK, "add check")
    _commit_file(primary, env, "shared.txt", "base\n", "base")

    wt = tmp_path / "wt"
    _ok(_git(primary, env, "worktree", "add", "-q", "-b", "feature", str(wt), "main"))
    _commit_file(wt, env, "feature.txt", "feature work\n", "feature work")
    return primary, wt, env, log


def _run(args: list, env: dict, cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        [SH, MERGE_SCRIPT.as_posix(), *args],
        env=env,
        cwd=str(cwd),
        capture_output=True,
        text=True,
        timeout=120,
    )


def _calls(log: Path) -> list:
    return log.read_text(encoding="utf-8").split() if log.exists() else []


def _head(repo: Path, env: dict) -> str:
    return _ok(_git(repo, env, "rev-parse", "HEAD"))


class TestMergeBranch:
    def test_happy_path_rebases_checks_enqueues_and_rechecks_primary(self, repos, tmp_path):
        primary, wt, env, log = repos
        _commit_file(primary, env, "main_only.txt", "advance\n", "main advances")
        main_tip = _head(primary, env)

        result = _run([wt.as_posix()], env, tmp_path)

        assert result.returncode == 0, result.stdout + result.stderr
        assert _calls(log) == ["check:feature", "enqueue", "check:main"]
        assert _git(wt, env, "merge-base", "--is-ancestor", main_tip, "HEAD").returncode == 0

    def test_dirty_worktree_refused_naming_paths(self, repos, tmp_path):
        _primary, wt, env, log = repos
        before = _head(wt, env)
        (wt / "feature.txt").write_text("uncommitted edit\n", encoding="utf-8", newline="\n")

        result = _run([wt.as_posix()], env, tmp_path)

        assert result.returncode != 0
        assert "feature.txt" in result.stdout + result.stderr
        assert _calls(log) == []
        assert _head(wt, env) == before

    def test_rebase_conflict_is_aborted_and_nothing_runs(self, repos, tmp_path):
        primary, wt, env, log = repos
        _commit_file(wt, env, "shared.txt", "feature side\n", "feature edits shared")
        _commit_file(primary, env, "shared.txt", "main side\n", "main edits shared")
        before = _head(wt, env)

        result = _run([wt.as_posix()], env, tmp_path)

        assert result.returncode != 0
        assert "rebase" in (result.stdout + result.stderr).lower()
        assert _calls(log) == []
        assert _head(wt, env) == before
        for state_dir in ("rebase-merge", "rebase-apply"):
            git_path = _ok(_git(wt, env, "rev-parse", "--git-path", state_dir))
            state = Path(git_path) if Path(git_path).is_absolute() else wt / git_path
            assert not state.exists(), f"worktree left mid-rebase: {state}"
        assert _ok(_git(wt, env, "status", "--porcelain")) == ""

    def test_worktree_check_failure_blocks_enqueue(self, repos, tmp_path):
        _primary, wt, env, log = repos
        env["FAKE_WT_CHECK_RC"] = "1"

        result = _run([wt.as_posix()], env, tmp_path)

        assert result.returncode != 0
        assert _calls(log) == ["check:feature"]

    def test_enqueue_failure_exit_code_propagated_and_primary_check_skipped(self, repos, tmp_path):
        _primary, wt, env, log = repos
        env["FAKE_ENQUEUE_RC"] = "3"

        result = _run([wt.as_posix()], env, tmp_path)

        assert result.returncode == 3, result.stdout + result.stderr
        assert _calls(log) == ["check:feature", "enqueue"]

    def test_primary_check_exit_code_propagated_after_merge(self, repos, tmp_path):
        _primary, wt, env, log = repos
        env["FAKE_MAIN_CHECK_RC"] = "4"

        result = _run([wt.as_posix()], env, tmp_path)

        assert result.returncode == 4, result.stdout + result.stderr
        assert _calls(log) == ["check:feature", "enqueue", "check:main"]

    def test_missing_argument_prints_usage_exit_2(self, repos, tmp_path):
        _primary, _wt, env, log = repos

        result = _run([], env, tmp_path)

        assert result.returncode == 2
        assert "usage" in (result.stdout + result.stderr).lower()
        assert _calls(log) == []

    def test_nonexistent_worktree_path_prints_usage_exit_2(self, repos, tmp_path):
        _primary, _wt, env, log = repos

        result = _run([(tmp_path / "no_such_wt").as_posix()], env, tmp_path)

        assert result.returncode == 2
        assert "usage" in (result.stdout + result.stderr).lower()
        assert _calls(log) == []
