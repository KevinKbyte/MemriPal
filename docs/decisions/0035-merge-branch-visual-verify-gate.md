# 0035: merge_branch.sh runs the visual-verify gate itself on the ff and override paths

Status: Accepted
Date: 2026-10-31
Source: MEM-069 (`.claude/spec-cache/memripal/references/spec-4.md`); `CLAUDE.md` "Dispatch and merge" (UI diffs
need a visual-verify record before merge).

## Context

`request_merge.py`'s preenqueue gates refuse a UI diff without a visual-verify record
(`visual_verify_merge_gate.refuse_reason`). `scripts/merge_branch.sh` has two other merge paths that never reach that
queue: the `git merge --ff-only` fallback and the `MEMRIPAL_REQUEST_MERGE_CMD` override. A UI change could land on
`main` unverified through either.

## Options considered

- (A) In-script gate: `merge_branch.sh` classifies the `main...HEAD` diff and, on any UI path, consults a lookup
  before the ff or override enqueue; the `request_merge.py` path skips it.
  Pros: closes both bypasses; the default lookup is the queue's own `refuse_reason`, so verdicts match; the queue path
  is not double-gated; a lookup seam keeps tests hermetic.
  Cons: `is_ui_path` is duplicated in shell (drift pinned by a test against the real table); the ff path now needs
  agent-workflow (or the seam) to merge any UI diff.
- (B) Rely on `request_merge.py`'s preenqueue gates only.
  Pros: one gate implementation, no shell copy.
  Cons: ff and override merges land UI changes unverified; enforcement depends on which path resolution picks.

## Decision

(A), specified as MEM-069. Seam: `MEMRIPAL_VISUAL_VERIFY_CMD`, run as `<cmd> <primary> <branch> main`, exit 0 =
verified. Unset, the default lookup calls `refuse_reason` from
`${AGENT_WORKFLOW_DIR:-$HOME/projects/agent-workflow}/scripts/visual_verify_merge_gate.py`; a missing module fails
closed (exit 1, stderr names the path). That default dir is used only for the lookup, never to select the
`request_merge.py` path.

## Why this over the others

The bypass was the paths that skip the queue; gating only in the queue leaves them open. Reusing `refuse_reason`
keeps one source of truth for what counts as verified.

## Consequences

- A refused merge exits 1 before any merge or enqueue; stderr names the lookup's reason and each unverified UI path.
- Diffs with no UI path never consult the lookup.
- Without agent-workflow installed and no seam set, UI diffs cannot merge via the ff path.
- Record a pass with agent-workflow's `sdlc_phase_gate.py record ... --gate visual-verify` (its `scripts/` dir, located via the
  `AW` env var, default `$HOME/projects/agent-workflow`; `CLAUDE.md`).
