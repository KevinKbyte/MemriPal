# Design previews

Preview pages under `docs/design/<area>/` are rendered and screenshotted before UI work lands
(`scripts/screenshot_design.py`, MEM-067; gate: [ADR 0036](../decisions/0036-design-gate.md)).

- Version every stylesheet link with `?v=N` (`href="paper-crown.css?v=5"`) and bump N on every CSS change: the
  Claude browser pane caches CSS served by `python -m http.server` (no cache headers), so an unversioned link shows
  stale styles.
