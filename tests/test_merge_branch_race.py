# Covers: MEM-068
# Requirement: on the no-queue fast-forward path, when `git merge --ff-only` fails because main
# moved while the branch was being checked, `sh scripts/merge_branch.sh <worktree>` recovers
# with no manual step: it drops the branch's trailing `chore: bump version to X...` commit,
# rebases the remaining feature commits onto the new main, re-bumps the version to main's
# version + 1 patch in all four release files (CHANGELOG.md heading, pyproject.toml [project]
# version, src/memripal/__init__.py __version__, the memripal stanza of uv.lock) while keeping
# the CHANGELOG entry body, commits that as the new tail bump commit (same subject, version
# swapped), re-runs the worktree's scripts/check.sh and retries the fast-forward. It allows at
# most 3 such re-bump rounds after the first attempt; a 4th race exits 1 with "gave up after 3".
# A branch whose last commit is not a bump commit is refused (exit 1, "not a version bump",
# branch untouched); a conflicting rebase during a retry is aborted (exit 1, "rebase" in stderr)
# and the branch restored to its pre-retry tip with the bump commit intact.
#
# Seams (shared with tests/test_merge_branch.py): MEMRIPAL_REQUEST_MERGE_CMD and
# AGENT_WORKFLOW_DIR unset selects the ff path; the worktree's scripts/check.sh is a fake that
# logs `check:<branch>` to $MERGE_TEST_LOG and, on its Nth non-main run with FAKE_RACE_MAIN_IN
# set, fast-forwards the primary's main to ref `raceN` (if that ref exists) -- the race.
import os
import re
from pathlib import Path

import pytest
from test_merge_branch import FAKE_UV, GIT, SH, _calls, _commit_file, _git, _head, _ok, _run

pytestmark = pytest.mark.skipif(not (SH and GIT), reason="merge_branch.sh test needs sh and git")

FAKE_RACE_CHECK = """#!/bin/sh
branch=$(git -C "$(dirname "$0")" rev-parse --abbrev-ref HEAD)
echo "check:$branch" >> "$MERGE_TEST_LOG"
if [ "$branch" != main ] && [ -n "${FAKE_RACE_MAIN_IN:-}" ]; then
  n=$(grep -cx "check:$branch" "$MERGE_TEST_LOG")
  if git -C "$FAKE_RACE_MAIN_IN" rev-parse -q --verify "refs/heads/race$n" >/dev/null; then
    git -C "$FAKE_RACE_MAIN_IN" merge --ff-only -q "race$n" || exit 90
  fi
fi
exit 0
"""

BASE_CHANGELOG = """# Changelog

All notable changes to this project are documented here.

## [0.1.0] - 2026-10-01

### Added

- Initial release.
"""

# `zzdep>=0.1.1` equals the branch's stale bump version: a blind text replace corrupts it.
BASE_PYPROJECT = """[project]
name = "memripal"
version = "0.1.0"
dependencies = ["zzdep>=0.1.1"]
"""

BASE_INIT = '"""MemriPal."""\n\n__version__ = "0.1.0"\n'

# Top-level `version = 1` and the zzdep stanza must survive: only the memripal stanza changes.
BASE_LOCK = """version = 1
requires-python = ">=3.13"

[[package]]
name = "memripal"
version = "0.1.0"
source = { editable = "." }
dependencies = [
    { name = "zzdep" },
]

[[package]]
name = "zzdep"
version = "0.1.1"
source = { registry = "https://pypi.org/simple" }
"""

FEATURE_ENTRY = "- Feature work (MEM-900)."
BUMP_SUBJECT = "chore: bump version to {v}, CHANGELOG (MEM-900)"


def _write(repo, rel, text):
    path = repo / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


def _bump(repo, env, version, entry, subject):
    """Commit a release bump of all four files to `version` with a CHANGELOG `entry` body."""
    py = (repo / "pyproject.toml").read_text(encoding="utf-8")
    _write(repo, "pyproject.toml", re.sub(r'(?m)^version = "[^"]+"', f'version = "{version}"', py, count=1))
    _write(repo, "src/memripal/__init__.py", f'"""MemriPal."""\n\n__version__ = "{version}"\n')
    lock = (repo / "uv.lock").read_text(encoding="utf-8")
    _write(repo, "uv.lock", re.sub(r'(name = "memripal"\nversion = ")[^"]+', rf"\g<1>{version}", lock))
    log = (repo / "CHANGELOG.md").read_text(encoding="utf-8")
    section = f"## [{version}] - 2026-10-30\n\n### Added\n\n{entry}\n\n"
    idx = log.index("## [")
    _write(repo, "CHANGELOG.md", log[:idx] + section + log[idx:])
    files = ["pyproject.toml", "src/memripal/__init__.py", "uv.lock", "CHANGELOG.md"]
    _ok(_git(repo, env, "add", "--", *files))
    _ok(_git(repo, env, "commit", "-q", "-m", subject))


@pytest.fixture
def race_repos(tmp_path):
    """Primary on main at 0.1.0 (four release files) plus worktree `feature`: a feature commit
    and a trailing `chore: bump version to 0.1.1` commit. ff path selected, guarded fake uv."""
    log = tmp_path / "calls.log"
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "uv").write_text(FAKE_UV, encoding="ascii", newline="\n")
    home = tmp_path / "home"
    home.mkdir()
    env = {
        k: v
        for k, v in os.environ.items()
        if not k.startswith(("FAKE_", "MEMRIPAL_")) and k != "AGENT_WORKFLOW_DIR"
    }
    env.update(
        {
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_AUTHOR_NAME": "Merge Test",
            "GIT_AUTHOR_EMAIL": "merge-test@example.invalid",
            "GIT_COMMITTER_NAME": "Merge Test",
            "GIT_COMMITTER_EMAIL": "merge-test@example.invalid",
            "MERGE_TEST_LOG": log.as_posix(),
            "PATH": str(bin_dir) + os.pathsep + os.environ.get("PATH", ""),
            "FAKE_ALLOWED_ROOT": (tmp_path / "agent-workflow").as_posix(),
            "HOME": home.as_posix(),
            "USERPROFILE": str(home),
        }
    )
    primary = tmp_path / "primary"
    primary.mkdir()
    _ok(_git(primary, env, "init", "-q", "-b", "main"))
    for key, value in (("core.autocrlf", "false"), ("commit.gpgsign", "false")):
        _ok(_git(primary, env, "config", key, value))
    for rel, text in (
        ("scripts/check.sh", FAKE_RACE_CHECK),
        ("shared.txt", "base\n"),
        ("CHANGELOG.md", BASE_CHANGELOG),
        ("pyproject.toml", BASE_PYPROJECT),
        ("src/memripal/__init__.py", BASE_INIT),
        ("uv.lock", BASE_LOCK),
    ):
        _write(primary, rel, text)
    _ok(_git(primary, env, "add", "-A"))
    _ok(_git(primary, env, "commit", "-q", "-m", "base 0.1.0"))

    wt = tmp_path / "wt"
    _ok(_git(primary, env, "worktree", "add", "-q", "-b", "feature", str(wt), "main"))
    _commit_file(wt, env, "feature.txt", "feature work\n", "feature work")
    env["FAKE_RACE_MAIN_IN"] = primary.as_posix()
    return primary, wt, env, log


def _make_races(primary, env, kinds):
    """Create refs race1..raceN chained off main: 'bump' = racer commit + bump to 0.1.N,
    'plain' = racer commit only. The primary stays on main, which does not move here."""
    _ok(_git(primary, env, "switch", "-q", "-c", "racers", "main"))
    for n, kind in enumerate(kinds, start=1):
        _commit_file(primary, env, f"racer{n}.txt", f"racer {n}\n", f"racer work {n}")
        if kind == "bump":
            _bump(
                primary, env, f"0.1.{n}", f"- Racer work {n} (MEM-90{n}).", f"chore: bump version to 0.1.{n}"
            )
        _ok(_git(primary, env, "branch", f"race{n}"))
    _ok(_git(primary, env, "switch", "-q", "main"))


def _show(repo, env, rev, rel):
    return _ok(_git(repo, env, "show", f"{rev}:{rel}"))


def _sections(changelog):
    """[(version, body)] in file order."""
    parts = re.split(r"(?m)^## \[([^\]]+)\][^\n]*$", changelog)
    return [(parts[i], parts[i + 1]) for i in range(1, len(parts), 2)]


def _assert_release(repo, env, rev, version):
    """All four release files at `rev` agree on `version`; unrelated version strings untouched."""
    py = _show(repo, env, rev, "pyproject.toml")
    assert re.findall(r'(?m)^version = "([^"]+)"', py) == [version], py
    assert '"zzdep>=0.1.1"' in py, py
    assert f'__version__ = "{version}"' in _show(repo, env, rev, "src/memripal/__init__.py")
    lock = _show(repo, env, rev, "uv.lock")
    assert f'name = "memripal"\nversion = "{version}"\n' in lock, lock
    assert 'name = "zzdep"\nversion = "0.1.1"\n' in lock, lock
    assert lock.startswith("version = 1\n"), lock
    changelog = _show(repo, env, rev, "CHANGELOG.md")
    top_version, top_body = _sections(changelog)[0]
    assert top_version == version, changelog
    assert re.search(rf"(?m)^## \[{re.escape(version)}\] - \d{{4}}-\d{{2}}-\d{{2}}$", changelog), changelog
    assert FEATURE_ENTRY in top_body and "### Added" in top_body, changelog
    assert changelog.count(FEATURE_ENTRY) == 1, changelog
    assert "<<<<<<<" not in changelog and ">>>>>>>" not in changelog


def _no_rebase_state(wt, env):
    for state_dir in ("rebase-merge", "rebase-apply"):
        git_path = _ok(_git(wt, env, "rev-parse", "--git-path", state_dir))
        state = Path(git_path) if Path(git_path).is_absolute() else wt / git_path
        assert not state.exists(), f"worktree left mid-rebase: {state}"


class TestMergeRaceRebumpRetry:
    def test_single_race_rebumps_to_main_plus_one_and_lands(self, race_repos, tmp_path):
        primary, wt, env, log = race_repos
        _bump(wt, env, "0.1.1", FEATURE_ENTRY, BUMP_SUBJECT.format(v="0.1.1"))
        _make_races(primary, env, ["bump"])
        race1 = _ok(_git(primary, env, "rev-parse", "race1"))

        result = _run([wt.as_posix()], env, tmp_path)

        assert result.returncode == 0, result.stdout + result.stderr
        assert _head(primary, env) == _head(wt, env)
        assert _ok(_git(primary, env, "rev-parse", "main~2")) == race1
        assert _ok(_git(primary, env, "log", "-1", "--format=%s", "main~1")) == "feature work"
        assert _ok(_git(primary, env, "log", "-1", "--format=%s", "main")) == BUMP_SUBJECT.format(v="0.1.2")
        _assert_release(primary, env, "main", "0.1.2")
        sections = _sections(_show(primary, env, "main", "CHANGELOG.md"))
        assert [v for v, _ in sections] == ["0.1.2", "0.1.1", "0.1.0"]
        assert "Racer work 1 (MEM-901)" in sections[1][1] and FEATURE_ENTRY not in sections[1][1]
        assert _show(primary, env, "main", "feature.txt") == "feature work"
        assert _show(primary, env, "main", "racer1.txt") == "racer 1"
        assert _calls(log) == ["check:feature", "check:feature", "check:main"]

    def test_race_without_version_change_rebumps_from_mains_version(self, race_repos, tmp_path):
        primary, wt, env, log = race_repos
        _bump(wt, env, "0.1.1", FEATURE_ENTRY, BUMP_SUBJECT.format(v="0.1.1"))
        _make_races(primary, env, ["plain"])
        race1 = _ok(_git(primary, env, "rev-parse", "race1"))

        result = _run([wt.as_posix()], env, tmp_path)

        assert result.returncode == 0, result.stdout + result.stderr
        assert _head(primary, env) == _head(wt, env)
        assert _ok(_git(primary, env, "rev-list", "--count", f"{race1}..main")) == "2"
        assert _ok(_git(primary, env, "log", "-1", "--format=%s", "main")) == BUMP_SUBJECT.format(v="0.1.1")
        _assert_release(primary, env, "main", "0.1.1")
        assert _calls(log) == ["check:feature", "check:feature", "check:main"]

    def test_three_consecutive_races_land_on_third_rebump_round(self, race_repos, tmp_path):
        primary, wt, env, log = race_repos
        _bump(wt, env, "0.1.1", FEATURE_ENTRY, BUMP_SUBJECT.format(v="0.1.1"))
        _make_races(primary, env, ["bump", "bump", "bump"])
        race3 = _ok(_git(primary, env, "rev-parse", "race3"))

        result = _run([wt.as_posix()], env, tmp_path)

        assert result.returncode == 0, result.stdout + result.stderr
        assert _head(primary, env) == _head(wt, env)
        assert _ok(_git(primary, env, "rev-parse", "main~2")) == race3
        _assert_release(primary, env, "main", "0.1.4")
        assert _calls(log) == ["check:feature"] * 4 + ["check:main"]

    def test_fourth_race_exceeds_cap_exit_1_and_main_left_at_racer(self, race_repos, tmp_path):
        primary, wt, env, log = race_repos
        _bump(wt, env, "0.1.1", FEATURE_ENTRY, BUMP_SUBJECT.format(v="0.1.1"))
        _make_races(primary, env, ["bump", "bump", "bump", "bump"])
        race4 = _ok(_git(primary, env, "rev-parse", "race4"))

        result = _run([wt.as_posix()], env, tmp_path)

        assert result.returncode == 1, result.stdout + result.stderr
        assert "gave up after 3" in result.stderr
        assert _head(primary, env) == race4
        assert _calls(log) == ["check:feature"] * 4
        assert _ok(_git(primary, env, "status", "--porcelain")) == ""
        assert _ok(_git(wt, env, "status", "--porcelain")) == ""
        _no_rebase_state(wt, env)
        assert _ok(_git(wt, env, "log", "-1", "--format=%s")).startswith("chore: bump version to ")

    def test_non_bump_tail_refused_exit_1_branch_untouched(self, race_repos, tmp_path):
        primary, wt, env, log = race_repos
        _make_races(primary, env, ["bump"])
        race1 = _ok(_git(primary, env, "rev-parse", "race1"))
        before = _head(wt, env)

        result = _run([wt.as_posix()], env, tmp_path)

        assert result.returncode == 1, result.stdout + result.stderr
        assert "not a version bump" in result.stderr
        assert "chore: bump version to" in result.stderr
        assert _head(wt, env) == before
        assert _head(primary, env) == race1
        assert _calls(log) == ["check:feature"]

    def test_retry_rebase_conflict_aborts_and_restores_branch_with_bump(self, race_repos, tmp_path):
        primary, wt, env, log = race_repos
        _commit_file(wt, env, "shared.txt", "feature side\n", "feature edits shared")
        _bump(wt, env, "0.1.1", FEATURE_ENTRY, BUMP_SUBJECT.format(v="0.1.1"))
        _ok(_git(primary, env, "switch", "-q", "-c", "racers", "main"))
        _commit_file(primary, env, "shared.txt", "racer side\n", "racer edits shared")
        _ok(_git(primary, env, "branch", "race1"))
        _ok(_git(primary, env, "switch", "-q", "main"))
        race1 = _ok(_git(primary, env, "rev-parse", "race1"))
        before = _head(wt, env)

        result = _run([wt.as_posix()], env, tmp_path)

        assert result.returncode == 1, result.stdout + result.stderr
        assert "rebase" in result.stderr.lower()
        assert _head(wt, env) == before
        assert _ok(_git(wt, env, "status", "--porcelain")) == ""
        _no_rebase_state(wt, env)
        assert _head(primary, env) == race1
        assert "check:main" not in _calls(log)
