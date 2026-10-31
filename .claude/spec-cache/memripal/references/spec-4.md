# MemriPal spec (continuation)

Continuation of [spec-3.md](spec-3.md), which is over its 500-line cap.

## MEM-068 merge_branch ff race: auto re-bump + retry

Decided-by: ADR [0034](../../../../docs/decisions/0034-merge-branch-rebump-retry.md). Amends MEM-024 (spec.md, at
its line cap): a non-ff on the solo fallback because `main` moved no longer exits with git's code.
- Trigger: no-queue path (`MEMRIPAL_REQUEST_MERGE_CMD` unset, no `$AGENT_WORKFLOW_DIR/scripts/request_merge.py`);
  `git merge --ff-only` fails and `main` is not an ancestor of the branch. `main` still an ancestor -> exit with
  git's code, no re-bump.
- Round: the last commit's subject must start `chore: bump version to `, else exit 1, stderr "not a version bump",
  branch untouched. Drop it, `rebase main`; conflict -> `rebase --abort`, branch reset to its pre-round tip (bump
  commit intact), exit 1, stderr names the rebase. Re-bump to main's `pyproject.toml` version + 1 patch in: the
  first `version =` of `pyproject.toml`, `__version__` in `src/memripal/__init__.py`, the memripal stanza of
  `uv.lock` only, and a new top `## [<v>] - <today>` CHANGELOG heading carrying the dropped entry's body. Re-commit
  with the same message, version swapped. Main's version unreadable -> branch reset, exit 1. Re-run the worktree's
  `scripts/check.sh` (failure -> its code), retry the ff.
- Cap: 3 re-bump rounds after the first attempt; a 4th race -> exit 1, stderr "gave up after 3 re-bump rounds",
  `main` left at the racer.
- Accept: one race -> main + 1 lands, entry body kept; a racer that did not change the version still re-bumps from
  main's version; 3 races land on round 3; a 4th exits 1; non-bump tail refused, branch unchanged; retry conflict
  restores the branch with its bump; `dependencies = ["zzdep>=0.1.1"]`, lock top-level `version = 1` and the zzdep
  stanza survive.

Tests: tests/test_merge_branch_race.py

## MEM-069 merge_branch visual-verify gate on ff + override paths

Decided-by: ADR [0035](../../../../docs/decisions/0035-merge-branch-visual-verify-gate.md). Amends MEM-024.
- Scope: runs before the merge on the `git merge --ff-only` fallback and the `MEMRIPAL_REQUEST_MERGE_CMD` override
  path; skipped on the `request_merge.py` path, whose preenqueue gates run `visual_verify_merge_gate.refuse_reason`.
- UI paths: `git diff --name-only main...HEAD` classified like agent-workflow
  `hooks.global/visual-verify-commit-gate.py::is_ui_path`: `.js .mjs .ts .tsx .jsx .html .vue .svelte .css`, except
  under `scripts/` or any `test/`/`tests/`/`__tests__/` dir, `.test.`/`.spec.` filenames, and `.js`/`.mjs`/`.ts`
  under `core/`/`bg/`/`workflows/`/`workflows.global/` or named `background`/`service-worker`/`service_worker`. No UI
  path -> lookup not consulted.
- Lookup seam: `MEMRIPAL_VISUAL_VERIFY_CMD` (word-split) run as `<cmd> <primary> <branch> main`; exit 0 = verified,
  else refuse (its stderr surfaced). Unset: `refuse_reason(<primary>, <branch>, "main")` from
  `${AGENT_WORKFLOW_DIR:-$HOME/projects/agent-workflow}/scripts/visual_verify_merge_gate.py` via `uv run`; file
  missing -> fail closed, exit 1, stderr names the path. That default dir never selects the `request_merge.py` path.
- Refusal: exit 1 before any merge/enqueue (`main` untouched, primary `scripts/check.sh` not run); stderr
  "visual-verify gate refused; unverified UI path(s):" plus only the UI paths.
- Accept: ff and override UI diff without a record refused, with one merges/enqueues; non-UI diff skips the lookup;
  classification table matches the real `is_ui_path`; request_merge path delegates; missing module fails closed;
  `AGENT_WORKFLOW_DIR` honored for the lookup only.

Tests: tests/test_merge_branch_visual_verify.py
