# 0039: Route design files split under the 500-line cap; gate follows the preview's stylesheet links

Status: Accepted
Date: 2026-11-01
Source: MEM-067 (design tools), MEM-072 (route-first flow) (`.claude/spec-cache/memripal/references/spec-4.md`);
amends the inputs of [0036](0036-design-gate.md).

## Context

The route design files outgrew the 500-line file cap: `route.css` 1716 lines, `preview.html` 840, `map-shell.html`
624. `scripts/design_gate.py`, `scripts/check_route_css.py` and `scripts/screenshot_design.py` each assumed one
stylesheet and one preview page, so splitting the files breaks the gate unless the tools learn where the pieces are.

## Options considered

- (A) Explicit page map + gate follows `<link>` hrefs (chosen). CSS splits into `route.css` (shell, chips, undo, route
  map, thumbnails), `route-s1-s2.css`, `route-s3.css`, `route-s4-s5.css`, `route-s6-s9.css`, linked in that order
  after `static/style.css` and `static/theme-painterly.css`. `preview.html` holds screens 1-4, `preview-2.html`
  screens 5-9; `map-shell.html`'s inline script moves to `map-shell.js`. The gate concatenates every stylesheet
  `preview.html` links by relative href inside `docs/design/route/`, in link order (a missing linked file is a
  problem; hrefs outside the dir are ignored). `check_route_css.py` takes `<css>... <contract>`.
  `screenshot_design.py` maps screens 1-4 to `preview.html` and 5-9 to `preview-2.html`; shot names and the 32-shot
  order are unchanged. A test caps every tracked `.css`/`.html` under `docs/design/route` below 500 lines.
  Pros: deterministic; works offline from files on disk; no runtime JS; the gate lints exactly the CSS the browser
  loads, in the same order.
  Cons: the screen-to-page map is hardcoded in `screenshot_design.py` and must change if screens move pages.
- (B) Redirect/stub page. `preview.html` stays the single entry and redirects or frames the per-screen pages.
  Pros: the tools keep one URL.
  Cons: the gate would still read one file that no longer holds the CSS or markup; redirects/frames add load timing
  and page-error noise to screenshots; the stub hides which file a screen lives in.
- (C) Runtime fetch/concat of CSS in the preview. A script in the preview fetches the split CSS files and injects them.
  Pros: one `<link>`-free page; split files are invisible to the gate's page list.
  Cons: needs JS and an HTTP server (fetch fails on `file://`); the gate's static read no longer matches what renders;
  load order and failures happen at runtime, not as lint problems.

## Decision

Option A, under MEM-067. The preview pages' `<link>` tags are the single source for which CSS the gate reads and in
what order.

## Why this over the others

A keeps the gate's view identical to the browser's: both read the same linked files in the same order, with no
runtime step. B leaves the gate reading a page that holds nothing; C moves load order and failure into runtime JS the
static gate cannot see and breaks offline `file://` renders.

## Consequences

- Adding a route stylesheet means linking it in both preview pages; an unlinked file is invisible to the gate.
- Moving a screen between preview pages requires updating `screenshot_design.py`'s page map.
- A preview page absent at a revision yields a per-shot error, not a crash.
- The 500-line test fails any route design file that regrows past the cap.
