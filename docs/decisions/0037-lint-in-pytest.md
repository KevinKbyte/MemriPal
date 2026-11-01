# 0037: Lint gate runs inside pytest as one whole-repo ruff item

Status: Accepted
Date: 2026-10-31
Source: MEM-071 (`.claude/spec-cache/memripal/references/spec-4.md`).

## Context

On 2026-10-31 two E501s reached main (3da4970 via MEM-034 418fd73; e5a6ead, fixed by a8c8daf). ruff ran only in
`scripts/check.sh`, which only `scripts/merge_branch.sh` calls. MEM-034 was enqueued by calling agent-workflow
`request_merge.py` (its `scripts/` dir) directly, skipping both. The queue drain's verify (agent-workflow
`post_merge_verify.py`) runs only pytest, often affected-only on changed test files, so nothing on the drain
path linted.

## Options considered

- (A) Lint inside pytest via a `tests/conftest.py` session item linting the whole repo (chosen). One `ruff-lint`
  item appended to every session runs `sys.executable -m ruff check <rootpath>`; nonzero exit fails it.
  Pros: catches the drain path with no agent-workflow change; covers src too, not only tests; one item; ruff on
  the whole repo is sub-second.
  Cons: every pytest run pays the ruff call; a lint error elsewhere fails an unrelated targeted run (intended: main
  must stay clean); still misses drain runs that map to zero test targets.
- (A') Per-module ruff item per collected test file (the original plan-note idea).
  Pros: lints only what the run touches.
  Cons: misses src-only lint errors in affected-only runs; whole-repo is simpler and strictly stronger.
- (B) agent-workflow drain runs a per-repo pre-verify command such as `scripts/check.sh`.
  Pros: fixes it at the failure site; covers every repo.
  Cons: cross-repo change; held as a follow-up.
- (C) Change `merge_branch.sh` only.
  Pros: none for this failure.
  Cons: cannot help; the bypass never calls it.

## Decision

Option A, specified as MEM-071: `tests/conftest.py` appends one `ruff-lint` item (trylast, after `-k`/`-m`
deselection) to every pytest session. Any pytest run fails on a lint error anywhere in the repo.

## Why this over the others

A closes the observed bypass today from inside this repo: the drain already runs pytest, so pytest carrying the lint
check reaches it. A' is weaker for no gain; B is the better long-term fix but needs agent-workflow; C does not touch
the bypassed path.

## Consequences

- Every pytest run, however narrow, fails while main or the branch has a lint error anywhere.
- ruff must stay in the same dev dependency group as pytest; a missing ruff fails the item (fail closed).
- Residual: a drain run whose changed files map to zero test targets skips pytest, so its lint errors are uncaught
  until the agent-workflow follow-up (B) lands.
