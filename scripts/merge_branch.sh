#!/bin/sh
# One-command memripal merge: refuse dirty tree, rebase onto main, run the
# worktree gate, enqueue, then re-run the gate in the primary checkout.
# Usage: sh scripts/merge_branch.sh <worktree-path>
# Env: MEMRIPAL_REQUEST_MERGE_CMD overrides the enqueue command (tests use a stub);
# else AGENT_WORKFLOW_DIR/scripts/request_merge.py if present; else `git merge --ff-only`.
# MEMRIPAL_VISUAL_VERIFY_CMD overrides the visual-verify lookup (`<cmd> <primary> <branch> main`).
set -u

MAX_REBUMP_ROUNDS=3
BUMP_PREFIX="chore: bump version to "

usage() {
  echo "usage: sh scripts/merge_branch.sh <worktree-path>" >&2
  exit 2
}

# Mirrors agent-workflow hooks.global/visual-verify-commit-gate.py::is_ui_path;
# tests/test_merge_branch_visual_verify.py pins the table against the real one.
is_ui_path() {
  case "$1" in
    *.js | *.mjs | *.ts | *.tsx | *.jsx | *.html | *.vue | *.svelte | *.css) ;;
    *) return 1 ;;
  esac
  case "/$1" in
    /scripts/* | */test/* | */tests/* | */__tests__/*) return 1 ;;
  esac
  name=${1##*/}
  case "$name" in
    *.test.* | *.spec.*) return 1 ;;
    *.js | *.mjs | *.ts) ;;
    *) return 0 ;;
  esac
  case "/$1" in
    */core/* | */bg/* | */workflows.global/* | */workflows/*) return 1 ;;
  esac
  case "${name%.*}" in
    background | service-worker | service_worker) return 1 ;;
  esac
  return 0
}

# Default lookup: agent-workflow's visual_verify_merge_gate.refuse_reason, the same
# check request_merge.py's preenqueue gates run. Missing module fails closed.
default_visual_verify() {
  aw_dir=${AGENT_WORKFLOW_DIR:-$HOME/projects/agent-workflow}
  gate="$aw_dir/scripts/visual_verify_merge_gate.py"
  if [ ! -f "$gate" ]; then
    echo "merge_branch: visual-verify lookup missing: $gate (set AGENT_WORKFLOW_DIR)" >&2
    return 1
  fi
  uv run --directory "$aw_dir" python -c '
import sys
sys.path.insert(0, sys.argv[1])
from scripts.visual_verify_merge_gate import refuse_reason
reason = refuse_reason(sys.argv[2], sys.argv[3], sys.argv[4])
if reason:
    print(reason, file=sys.stderr)
    sys.exit(1)
' "$aw_dir" "$1" "$2" "$3"
}

visual_verify_gate() {
  ui_paths=""
  changed=$(git -C "$wt" -c core.quotepath=off diff --name-only main...HEAD) || return 1
  while IFS= read -r path; do
    [ -n "$path" ] && is_ui_path "$path" && ui_paths="$ui_paths $path"
  done <<EOF
$changed
EOF
  [ -n "$ui_paths" ] || return 0
  if [ -n "${MEMRIPAL_VISUAL_VERIFY_CMD:-}" ]; then
    $MEMRIPAL_VISUAL_VERIFY_CMD "$primary" "$branch" main && return 0
  else
    default_visual_verify "$primary" "$branch" main && return 0
  fi
  echo "merge_branch: visual-verify gate refused; unverified UI path(s):$ui_paths" >&2
  return 1
}

# Rewrite one file through awk (args after the file are passed to awk).
rewrite() {
  file=$1
  shift
  awk "$@" "$wt/$file" > "$wt/$file.rebump" && mv "$wt/$file.rebump" "$wt/$file"
}

# Drop the branch's tail bump commit, rebase onto main, re-bump all four release
# files to main's version + 1 patch keeping the CHANGELOG entry body, re-commit.
rebump_onto_main() {
  msg=$(git -C "$wt" log -1 --format=%B) || return 1
  case "$msg" in
    "$BUMP_PREFIX"*) ;;
    *)
      echo "merge_branch: main moved but the branch's last commit is not a version bump" \
        "(expected subject '${BUMP_PREFIX}X.Y.Z...'); rebase and re-bump manually" >&2
      return 1
      ;;
  esac
  pre=$(git -C "$wt" rev-parse HEAD) || return 1
  body=$(git -C "$wt" show HEAD:CHANGELOG.md | awk '/^## \[/ { n++; next } n == 1 { print }')
  git -C "$wt" reset -q --hard HEAD~1 || return 1
  if ! git -C "$wt" rebase -q main; then
    git -C "$wt" rebase --abort
    git -C "$wt" reset -q --hard "$pre"
    echo "merge_branch: rebase onto moved main conflicted during re-bump; aborted, branch restored" >&2
    return 1
  fi
  main_ver=$(git -C "$wt" show main:pyproject.toml | sed -n 's/^version = "\([^"]*\)"$/\1/p' | sed -n 1p)
  [ -n "$main_ver" ] || {
    echo "merge_branch: cannot read main's version from pyproject.toml" >&2
    git -C "$wt" reset -q --hard "$pre"
    return 1
  }
  new_ver=$(echo "$main_ver" | awk -F. 'BEGIN { OFS = "." } { $NF = $NF + 1; print }')
  q='"'
  rewrite pyproject.toml -v v="$new_ver" -v q="$q" \
    '!done && /^version = "/ { print "version = " q v q; done = 1; next } { print }'
  rewrite src/memripal/__init__.py -v v="$new_ver" -v q="$q" \
    '/^__version__ = "/ { print "__version__ = " q v q; next } { print }'
  rewrite uv.lock -v v="$new_ver" -v q="$q" \
    'prev == "name = " q "memripal" q && /^version = "/ { print "version = " q v q; prev = ""; next }
     { print; prev = $0 }'
  BODY=$body rewrite CHANGELOG.md -v v="$new_ver" -v d="$(date +%Y-%m-%d)" \
    '!done && /^## \[/ { print "## [" v "] - " d; print ENVIRON["BODY"]; print ""; done = 1 } { print }'
  git -C "$wt" add -- pyproject.toml src/memripal/__init__.py uv.lock CHANGELOG.md || return 1
  printf '%s\n' "$msg" | sed "1s/^\\(${BUMP_PREFIX}\\)[^ ,]*/\\1$new_ver/" \
    | git -C "$wt" commit -q -F - || return 1
}

# Fast-forward main; when main moved meanwhile (a race), re-bump and retry, capped.
ff_merge_with_rebump() {
  rounds=0
  while :; do
    git -C "$primary" merge --ff-only -q "$branch" && return 0
    rc=$?
    git -C "$primary" merge-base --is-ancestor main "$branch" && return "$rc"
    if [ "$rounds" -ge "$MAX_REBUMP_ROUNDS" ]; then
      echo "merge_branch: main kept moving; gave up after $MAX_REBUMP_ROUNDS re-bump rounds" >&2
      return 1
    fi
    rounds=$((rounds + 1))
    rebump_onto_main || return 1
    sh "$wt/scripts/check.sh" || return $?
  done
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

# Skip the rebase when main is already an ancestor: rebasing would flatten the
# branch's merge commits and can conflict on history it already contains.
if ! git -C "$wt" merge-base --is-ancestor main HEAD \
  && ! git -C "$wt" rebase -q main; then
  git -C "$wt" rebase --abort
  echo "merge_branch: rebase onto main conflicted; aborted" >&2
  exit 1
fi

sh "$wt/scripts/check.sh" || exit $?

primary=$(git -C "$wt" worktree list --porcelain | sed -n '1s/^worktree //p')
branch=$(git -C "$wt" rev-parse --abbrev-ref HEAD) || exit 1
request_merge="${AGENT_WORKFLOW_DIR:-}/scripts/request_merge.py"

# The request_merge.py path skips the visual-verify gate: its preenqueue gates run it.
if [ -n "${MEMRIPAL_REQUEST_MERGE_CMD:-}" ]; then
  visual_verify_gate || exit 1
  $MEMRIPAL_REQUEST_MERGE_CMD
elif [ -n "${AGENT_WORKFLOW_DIR:-}" ] && [ -f "$request_merge" ]; then
  uv run --directory "$wt" python "$request_merge" --repo "$wt" --wait
else
  # No merge queue available: fast-forward main directly.
  visual_verify_gate || exit 1
  ff_merge_with_rebump
fi
rc=$?
[ "$rc" -eq 0 ] || exit "$rc"

sh "$primary/scripts/check.sh"
