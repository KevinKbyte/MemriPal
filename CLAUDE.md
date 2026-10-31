# MemriPal

## Architecture decisions

Every architectural decision (any choice between 2+ viable technical approaches) gets an ADR in `docs/decisions/` in
the same change that adopts it: options with pros/cons, the decision, and why it beat the others. Update
`docs/decisions/README.md`.

Assign ADR numbers at dispatch, in planned land order; on a collision the later-landing branch renumbers at rebase
(file, title, README index, cross-links). Reference: two branches both took 0016; the live-cache ADR became 0017.

## Dispatch and merge

- Dispatch every ready brief before inspecting merge logs; log triage never blocks ready work.
- Diff touches `static/` or `docs/design/**` `.css`/`.html` -> before `request_merge`, screenshot the UI
  (`scripts/screenshot_ui.py`, landing on branch `screenshot-ui`; design previews: `scripts/screenshot_design.py`,
  MEM-067) and record it with agent-workflow's `scripts/sdlc_phase_gate.py record --repo <wt> --run <run>
  --phase Verify --gate visual-verify --evidence <png>`; the merge queue's visual-verify gate reads that record.
- Design tasks render a preview page and screenshot it before writing past a skeleton: global rule
  `~/.claude/rules/design-tasks-render-first.md`.
