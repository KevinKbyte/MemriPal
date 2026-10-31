# 0036: Design gate re-shoots the design at the branch tip itself, plus Kev's recorded approval for changed shots

Status: Accepted
Date: 2026-10-31
Source: MEM-070 (`.claude/spec-cache/memripal/references/spec-4.md`); builds on the MEM-067 tools
(`scripts/screenshot_design.py`, `scripts/check_route_css.py`).

## Context

Route design work lives in `docs/design/route/` (`preview.html`, `route.css`, `route-contract.md`). MEM-067 codified
the screenshot and CSS-lint tools, but nothing forces a branch touching `docs/design/**` to run them, and evidence a
branch carries can be stale (a PNG from an earlier commit) or not evidence at all (a `README.md` passed as the
evidence path). A merge check needs proof the design renders correctly at the commit being merged, and a human
sign-off when the rendered look changes.

## Options considered

- (A) Gate re-shoots at the tip itself (chosen). `scripts/design_gate.py` renders the preview at the branch tip via
  `screenshot_design.py` and checks the result: no page errors, `check_route_css.py` passes, no horizontal overflow
  at 375 px, zero axe contrast and tap-target violations, every CSS-selector and contract id/class present in the
  rendered DOM. Changed shots need Kev's approval recorded by `scripts/approve_design.py` (ask-listed, human-run).
  Pros: evidence is produced by the gate at the merged commit, so it cannot be stale or fabricated; the checks are
  deterministic; reuses MEM-067 tools.
  Cons: needs Playwright + local Chrome and a render per run (slower); approval adds a human step on every visual
  change.
- (B) Gate trusts committed PNG evidence. The branch commits screenshots; the gate checks they exist.
  Pros: fast, no browser in the gate.
  Cons: a PNG from an earlier commit, or a non-image path such as `README.md`, passes; nothing ties the evidence to
  the tip; the DOM, overflow and axe checks cannot run on a PNG.
- (C) Reviewer-only manual check. A reviewer opens the preview and eyeballs it; no gate.
  Pros: zero tooling.
  Cons: nondeterministic; misses overflow, contrast and missing-id regressions; no record of what was reviewed or at
  which commit.

## Decision

Option A, specified as MEM-070. Evidence that is a `README.md` or a PNG not produced at the current tip is refused.
Fresh tip shots with every check clean and every changed shot approved -> pass.

## Why this over the others

Only A makes stale or fabricated evidence impossible: the gate never reads evidence it did not produce at the tip.
B accepts exactly the stale and non-image evidence the gate exists to stop; C is judgment, not a check.

## Consequences

- Running the gate needs Playwright and local Chrome (as `screenshot_design.py` already does).
- Every visual change to `docs/design/**` waits on Kev running `approve_design.py`; agents cannot self-approve.
- `approve_design.py` must be on the permission ask list so only a human run records approval.
