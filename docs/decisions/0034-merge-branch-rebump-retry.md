# 0034: merge_branch.sh recovers an ff-only race by dropping the tail bump, rebasing and re-bumping, capped at 3 rounds

Status: Accepted
Date: 2026-10-31
Source: MEM-068 (`.claude/spec-cache/memripal/references/spec-4.md`); amends MEM-024's solo fallback.

## Context

With no merge queue (`MEMRIPAL_REQUEST_MERGE_CMD` unset, no `$AGENT_WORKFLOW_DIR/scripts/request_merge.py`),
`scripts/merge_branch.sh` fast-forwards `main` in the primary checkout. If another branch lands between the rebase +
`scripts/check.sh` run and the `git merge --ff-only`, the ff fails and the script exited with git's code. Every branch
ends in a `chore: bump version to X...` commit touching the four release files (CHANGELOG heading, `pyproject.toml`,
`src/memripal/__init__.py`, `uv.lock`), so the racer took the same next version: recovery meant a manual drop, rebase,
re-bump and re-run.

## Options considered

- (A) Merge queue: serialize every merge through `request_merge.py`.
  Pros: no race by construction; the drain owns the full suite.
  Cons: needs agent-workflow and a live drain; the ff path exists for exactly the case where no queue is available,
  so it leaves that path broken.
- (B) Auto re-bump + retry: on a non-ff where `main` moved, drop the trailing bump commit, rebase onto `main`,
  re-bump the four release files to main's version + 1 patch (CHANGELOG entry body kept), re-run `scripts/check.sh`,
  retry the ff; cap 3 rounds; refuse a branch whose last commit is not a bump.
  Pros: no manual step; works with no queue; versions stay monotonic; the retried tree is re-checked.
  Cons: rewrites the branch tail; the bump-subject convention becomes load-bearing; per-file awk rewrites are coupled
  to each file's format; heavy churn can still exhaust the cap; each round re-runs the full check.
- (C) Changelog fragments: branches carry no version files; the version is assigned at release.
  Pros: release files never conflict.
  Cons: repo-wide convention change (bump scripts, version-sync tests, every in-flight branch); a moved `main` still
  fails the ff and needs a rebase + re-check.

## Decision

(B), Kev's pick ("Auto re-bump + retry"), specified as MEM-068. A non-ff where `main` is still an ancestor of the
branch exits with git's code, no re-bump. A rebase conflict during a round aborts and restores the pre-round tip with
its bump commit. The queue path is unchanged.

## Why this over the others

Only (B) fixes the ff fallback itself without changing the release convention: (A) does not apply where the ff path
runs, and (C) is a larger convention change that still leaves the non-ff race to handle.

## Consequences

- The branch's tail bump commit gets a new sha and today's date in its CHANGELOG heading.
- A branch not ending in `chore: bump version to ` is refused when `main` moved: rebase and re-bump manually.
- A 4th race exits 1 ("gave up after 3 re-bump rounds"), `main` left at the racer.
