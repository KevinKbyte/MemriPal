# 0062: ADR numbering gaps allowed only for README-reserved numbers

Status: Accepted
Date: 2026-11-04
Source: MEM-018 (`.claude/spec-cache/memripal/references/spec.md`); overnight brief 2026-11-04 item 8 (retro item 11).

## Context

MEM-018 (`tests/test_decisions_structure.py`) required ADR numbers unique and contiguous from 0001. The repo
CLAUDE.md assigns ADR numbers at dispatch, in planned land order, so parallel branches each hold a number before any
of them lands. A branch carrying ADR 0036 could not commit it while 0034 and 0035 sat on unmerged branches: the
contiguity check failed on its own base, so the ADR had to wait, be renumbered, or be committed with the hook
skipped.

## Options considered

- (A) A `Reserved:` line in `docs/decisions/README.md`. A gap passes only when every missing number is listed there; a
  listed number that also exists as an ADR file fails as a stale reservation; duplicates still fail (chosen).
  Pros: a branch commits its dispatched number at once; every gap is explained in the index; stale entries cannot
  linger because the landing ADR trips the check until its reservation is dropped.
  Cons: one more line to maintain; the branch that lands the reserved ADR must also edit the `Reserved:` line.
- (B) Keep strict contiguity; commit ADRs only in land order (write the ADR at rebase time, after earlier numbers
  land).
  Pros: no test change; the index never has gaps.
  Cons: the ADR is not "in the same change that adopts" the decision while the branch is in flight; the hook blocks
  WIP commits or invites `--no-verify`.
- (C) Drop the contiguity check; keep uniqueness only.
  Pros: simplest; no bookkeeping.
  Cons: a typo'd or abandoned number leaves a silent hole; nothing tells a reader whether a missing ADR is pending
  or lost.

## Decision

(A). `numbering_errors` reads numbers from `Reserved:` lines of the README (4-digit tokens; `Reserved: none` is
empty), fails duplicates, fails each reserved number that exists as a file, and fails each number between 0001 and
the highest ADR that is neither present nor reserved. Reserved numbers above the highest ADR are allowed.

## Why this over the others

(A) keeps the property contiguity protected (every number accounted for) while letting in-flight branches commit
their ADRs on time. (B) fights the CLAUDE.md rule that the ADR ships with the change and pushes people toward skipping
the hook. (C) loses the "nothing silently missing" guarantee for no gain over (A)'s one line.

## Consequences

- When a reserved ADR lands, its branch removes the number from `Reserved:` in the same change, or MEM-018 fails.
- On a numbering collision the later branch still renumbers (repo CLAUDE.md); a reservation does not settle
  collisions.
- The check functions take a directory, so fixture tests run against `tmp_path` as well as the real
  `docs/decisions/`.
