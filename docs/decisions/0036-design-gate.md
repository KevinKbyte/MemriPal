# 0036: Design gate re-shoots the design at the branch tip itself, plus Kev's recorded approval for changed shots

Status: Accepted; amended 2026-11-01 (deterministic shots: reduced motion, GPU off; see the Amendment section)
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

## Amendment 2026-11-01: deterministic shots (reduced motion, GPU off)

Approvals key on (tip, shot, sha256), so a shot must render byte-identical on every run at the same tip.
`docs/design/route/map-shell.css` runs an infinite `lm-float` animation under `prefers-reduced-motion:
no-preference`: 11 of 16 map-shell shots differed between two gate runs at one tip (pixel diffs only around emoji
glyphs), and approvals stopped matching.

Options:
- (A) Emulate `prefers-reduced-motion: reduce` (chosen). Pros: deterministic; covers the CSS and the page's JS tween
  (`map-shell.js` checks `matchMedia` reduce); shots show a real a11y state the contract already specifies
  (`docs/design/route/route-contract-2.md`: "reduced motion = instant"). Cons: shots do not show the mid-motion
  look (end state is the same; the pop-in uses fill mode `both`).
- (B) Playwright `screenshot(animations="disabled")`. Pros: one argument. Cons: CSS only; the JS tween stays
  timing-dependent.
- (C) Longer `SETTLE_MS` / wait for stable frames. Cons: an infinite animation never settles.
- (D) Perceptual-diff tolerance in approvals. Cons: the threshold is a judgment, not a check; weakens the gate.

Decision: A. Both shooters (`scripts/design_gate.py`, `scripts/screenshot_design.py`) open pages with Playwright
`reduced_motion="reduce"`.

Why A: the only option deterministic for both CSS and JS motion without loosening the hash check.

Consequence: every shot digest may change once, so the next approval at the tip covers all changed shots.

### Second finding: GPU raster

After reduced motion landed (9f4242a), two consecutive gate runs at one tip still differed on 2 of 48 shots
(`s5-6_phone_light` max channel delta 51, `s7_phone_dark` delta 1; visually identical). Probe over the full 48-shot
gate plan, 4-5 runs each: default GPU raster + one reused page = 1-2 flaky shots; fresh page per shot = 9 flaky;
Chrome launched with `--disable-gpu` + reused page = 0 flaky over 5 runs (also 0 with
`--disable-gpu-rasterization --num-raster-threads=1` added).

Options:
- (E) Keep GPU, add a perceptual tolerance. Cons: approvals key on sha256 digests; this is option D, already
  rejected.
- (F) Fresh page per shot. Cons: measured worse (9 flaky).
- (G) Launch Chrome with `--disable-gpu` (chosen). Pros: measured 0 flaky; one-argument change; software raster is
  the same on every run.
- (H) G plus raster-thread flags. Cons: no extra gain measured; more surface.

Decision: G. Both shooters (`scripts/design_gate.py` `real_shoot`, `scripts/screenshot_design.py` `run`) launch
`channel="chrome"` with `args=["--disable-gpu"]` alongside `reduced_motion="reduce"`.

Why G: the only measured option with zero flaky shots, at the smallest change.

Consequence: every shot digest changes once (one re-approval at the tip); CI/headless parity improves.
