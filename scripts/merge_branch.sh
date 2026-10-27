#!/bin/sh
# One-command memripal merge: refuse dirty tree, rebase onto main, run the
# worktree gate, enqueue, then re-run the gate in the primary checkout.
# Usage: sh scripts/merge_branch.sh <worktree-path>
# Env: MEMRIPAL_REQUEST_MERGE_CMD overrides the enqueue command (tests use a stub);
# else AGENT_WORKFLOW_DIR/scripts/request_merge.py if present; else `git merge --ff-only`.
set -u

usage() {
  echo "usage: sh scripts/merge_branch.sh <worktree-path>" >&2
  exit 2
}

[ $# -eq 1 ] || usage
wt=$1
[ -d "$wt" ] || usage

dirty=$(git -C "$wt" status --porcelain) || exit 1
if [ -n "$dirty" ]; then
  echo "merge_branch: worktree has uncommitted changes:" >&2
  echo "$dirty" >&2
  exit 1
fi

if ! git -C "$wt" rebase -q main; then
  git -C "$wt" rebase --abort
  echo "merge_branch: rebase onto main conflicted; aborted" >&2
  exit 1
fi

sh "$wt/scripts/check.sh" || exit $?

primary=$(git -C "$wt" worktree list --porcelain | sed -n '1s/^worktree //p')
request_merge="${AGENT_WORKFLOW_DIR:-}/scripts/request_merge.py"

if [ -n "${MEMRIPAL_REQUEST_MERGE_CMD:-}" ]; then
  $MEMRIPAL_REQUEST_MERGE_CMD
elif [ -n "${AGENT_WORKFLOW_DIR:-}" ] && [ -f "$request_merge" ]; then
  uv run --directory "$wt" python "$request_merge" --repo "$wt" --wait
else
  # No merge queue available: fast-forward main directly; a non-ff (main moved) is refused.
  branch=$(git -C "$wt" rev-parse --abbrev-ref HEAD) || exit 1
  git -C "$primary" merge --ff-only -q "$branch"
fi
rc=$?
[ "$rc" -eq 0 ] || exit "$rc"

sh "$primary/scripts/check.sh"
