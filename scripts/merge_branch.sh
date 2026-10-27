#!/bin/sh
# One-command memripal merge: refuse dirty tree, rebase onto main, run the
# worktree gate, enqueue, then re-run the gate in the primary checkout.
# Usage: sh scripts/merge_branch.sh <worktree-path>
# Env: MEMRIPAL_REQUEST_MERGE_CMD overrides the enqueue command (tests use a stub).
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

if [ -n "${MEMRIPAL_REQUEST_MERGE_CMD:-}" ]; then
  $MEMRIPAL_REQUEST_MERGE_CMD
else
  uv run --directory "$wt" python C:/Users/Kev/projects/agent-workflow/scripts/request_merge.py --repo "$wt" --wait
fi
rc=$?
[ "$rc" -eq 0 ] || exit "$rc"

primary=$(git -C "$wt" worktree list --porcelain | sed -n '1s/^worktree //p')
sh "$primary/scripts/check.sh"
