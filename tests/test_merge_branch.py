# Covers: MEM-024
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
if [ "$branch" != main ] && [ -n "${FAKE_RACE_MAIN_IN:-}" ]; then
  git -C "$FAKE_RACE_MAIN_IN" commit --allow-empty -q -m race || exit 90
fi
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


# Fake `uv`: strips `run` and its options, then execs the command only when it targets a
# script under $FAKE_ALLOWED_ROOT; anything else (e.g. a real request_merge.py) is blocked.
FAKE_UV = """#!/bin/sh
[ "${1:-}" = run ] && shift
while [ $# -gt 0 ]; do
  case "$1" in
    --directory|--project|--with) shift 2 ;;
    -*) shift ;;
    *) break ;;
  esac
done
for a in "$@"; do
  case "$a" in
    "$FAKE_ALLOWED_ROOT"/*) exec "$@" ;;
  esac
done
echo "uv-blocked" >> "$MERGE_TEST_LOG"
exit 97
"""

# Stub agent-workflow request_merge.py: logs that it ran, exits with a configurable code.
FAKE_REQUEST_MERGE = """import os
import sys

with open(os.environ["MERGE_TEST_LOG"], "a", encoding="ascii") as log:
    log.write("request_merge\\n")
sys.exit(int(os.environ.get("FAKE_ENQUEUE_RC", "0")))
"""


@pytest.fixture
def fallback(repos, tmp_path):
    """`repos` with no enqueue override, AGENT_WORKFLOW_DIR unset, and a guarded fake uv."""
    primary, wt, env, log = repos
    env.pop("MEMRIPAL_REQUEST_MERGE_CMD", None)
    env.pop("AGENT_WORKFLOW_DIR", None)
    aw = tmp_path / "agent-workflow"
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "uv").write_text(FAKE_UV, encoding="ascii", newline="\n")
    env["PATH"] = str(bin_dir) + os.pathsep + env.get("PATH", "")
    env["FAKE_ALLOWED_ROOT"] = aw.as_posix()
    return primary, wt, env, log, aw


def _install_request_merge_stub(aw: Path) -> None:
    (aw / "scripts").mkdir(parents=True, exist_ok=True)
    (aw / "scripts" / "request_merge.py").write_text(FAKE_REQUEST_MERGE, encoding="ascii", newline="\n")


# Covers: MEM-024
# Requirement: with MEMRIPAL_REQUEST_MERGE_CMD unset, merge_branch.sh enqueues via
# "$AGENT_WORKFLOW_DIR/scripts/request_merge.py" when AGENT_WORKFLOW_DIR is set and that file
# exists; otherwise it fast-forwards main to the branch with `git merge --ff-only` in the
# primary checkout, refusing a non-fast-forward with a nonzero exit and main untouched.
# MEMRIPAL_REQUEST_MERGE_CMD keeps top precedence, and the script hardcodes no
# user-specific path (no "C:/Users/Kev").
class TestMergeFallback:
    def test_no_env_fast_forwards_main_in_primary_and_exits_0(self, fallback, tmp_path):
        primary, wt, env, log, _aw = fallback
        _commit_file(primary, env, "main_only.txt", "advance\n", "main advances")

        result = _run([wt.as_posix()], env, tmp_path)

        assert result.returncode == 0, result.stdout + result.stderr
        assert _head(primary, env) == _head(wt, env)
        assert _ok(_git(primary, env, "rev-parse", "--abbrev-ref", "HEAD")) == "main"
        assert _calls(log) == ["check:feature", "check:main"]

    def test_no_env_non_ff_refused_nonzero_and_main_unchanged(self, fallback, tmp_path):
        primary, wt, env, log, _aw = fallback
        env["FAKE_RACE_MAIN_IN"] = primary.as_posix()

        result = _run([wt.as_posix()], env, tmp_path)

        assert result.returncode != 0, result.stdout + result.stderr
        assert _ok(_git(primary, env, "log", "-1", "--format=%s", "main")) == "race"
        feature_tip = _head(wt, env)
        assert _git(primary, env, "merge-base", "--is-ancestor", feature_tip, "main").returncode != 0
        assert _ok(_git(primary, env, "status", "--porcelain")) == ""
        assert _calls(log) == ["check:feature"]

    def test_agent_workflow_dir_with_request_merge_invokes_it(self, fallback, tmp_path):
        primary, wt, env, log, aw = fallback
        _install_request_merge_stub(aw)
        env["AGENT_WORKFLOW_DIR"] = aw.as_posix()
        main_before = _head(primary, env)

        result = _run([wt.as_posix()], env, tmp_path)

        assert result.returncode == 0, result.stdout + result.stderr
        assert _calls(log) == ["check:feature", "request_merge", "check:main"]
        assert _head(primary, env) == main_before

    def test_agent_workflow_dir_without_request_merge_falls_back_to_ff(self, fallback, tmp_path):
        primary, wt, env, log, aw = fallback
        aw.mkdir()
        env["AGENT_WORKFLOW_DIR"] = aw.as_posix()

        result = _run([wt.as_posix()], env, tmp_path)

        assert result.returncode == 0, result.stdout + result.stderr
        assert _head(primary, env) == _head(wt, env)
        assert _calls(log) == ["check:feature", "check:main"]

    def test_override_cmd_takes_precedence_over_agent_workflow_dir(self, fallback, tmp_path):
        primary, wt, env, log, aw = fallback
        _install_request_merge_stub(aw)
        env["AGENT_WORKFLOW_DIR"] = aw.as_posix()
        env["MEMRIPAL_REQUEST_MERGE_CMD"] = f"sh {(tmp_path / 'enqueue_stub.sh').as_posix()}"
        main_before = _head(primary, env)

        result = _run([wt.as_posix()], env, tmp_path)

        assert result.returncode == 0, result.stdout + result.stderr
        assert _calls(log) == ["check:feature", "enqueue", "check:main"]
        assert _head(primary, env) == main_before

    def test_script_has_no_hardcoded_user_path(self):
        text = MERGE_SCRIPT.read_text(encoding="utf-8").lower()

        assert "c:/users/kev" not in text
        assert "c:\\users\\kev" not in text
