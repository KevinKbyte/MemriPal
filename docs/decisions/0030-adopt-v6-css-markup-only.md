# 0030: Adopt the v6 look as CSS + markup retargeted to live ids; v6 JS stays reference-only

Status: Accepted
Date: 2026-10-29
Source: MEM-044 (`.claude/spec-cache/memripal/references/spec-3.md`); Kev (Q22): adopt the v6 look ourselves, CSS +
markup only; v6 adoption plan and painterly-theme failure-modes review (2026-10-29).

## Context

The v6 prototype under `docs/design/v6/` (MEM-041) is a design reference the app does not serve. The live
`static/index.html` is bare markup (3 links, 0 `style=`), `static/style.css` is 1.6 KB with 0 custom properties, and
most JS-built DOM is classless. v6 `app.js` is a self-contained mock: 0 fetch, hard-coded objects and points,
localStorage, 37 innerHTML (+7 in `review.js`; MEM-042 I6 bans innerHTML in `static/`), IIFE/UMD globals against live
ES modules, and its own ids (`#s1`-`#s9`, `#jump`). The live CSP (MEM-042 C1) has no `style-src` or `font-src`, so
v6's Google Fonts links and 12 `style=` uses are refused. 504 node tests and 22 E2E steps read live ids, `hidden`
attributes, exact classNames and CSS text; `tests/test_assets_wiring.py` pins the exact link list (MEM-040).

## Options considered

Chosen option second.

- (a) Full v6 adoption including JS (`app.js`, `review.js`, `sched.js`, `tags.js`), step rail and screen-per-step
  navigation.
  Pros: closest to the prototype; brings Review sort/filter and tags.
  Cons: replaces the live flow and ids, breaking 504 node tests and 22 E2E steps; mock data and 0 fetch; innerHTML
  violates MEM-042 I6; Review and tags are new features with no storage or spec; CSP refuses its inline styles and
  remote fonts.
- (b) v6 CSS + markup only, rewritten into `static/style.css` and `static/index.html` and retargeted to live ids and
  elements; v6 JS reference-only.
  Pros: v6 tokens, type and component looks on the live flow; every id, `hidden` attribute and className assert
  kept; CSP-clean (system fonts, no inline style); link list unchanged.
  Cons: hand port; no step rail, Review or tags; classless JS-built rows only partly match v6 cards.
- (c) Serve v6 `styles.css` verbatim as a new linked stylesheet beside `style.css`.
  Pros: least porting; v6 file stays the single source of the look.
  Cons: breaks `test_index_links_unchanged` and MEM-040; most v6 selectors (`.panel`, `.shell`, step rail) match
  nothing in live markup; its `body::before` fixed layer and font links fight the overlay and CSP; the 360px and
  `[hidden]` scans read only `style.css`, so the new file escapes them; two files own base rules.

## Decision

Option (b), specified as MEM-044 A1 (tokens + base), A2 (markup, F13) and A3 (components, F6, F12, F15).
`docs/design/v6/` is unchanged. The painterly theme (MEM-044 P1) is a separate token-remap layer,
`/static/theme-painterly.css`, linked last; it is the only new link and is covered by the extended 360px, `[hidden]`
and link-list tests.

## Why this over the others

Only (b) gives the v6 look without rewriting the live flow or its test surface, and it is the only option the current
CSP serves without console errors. (a) is a product rewrite against a mock; (c) adds a file whose rules mostly match
nothing while escaping the existing CSS scans.

## Consequences

- MEM-041 "nothing under `static/` changes" and MEM-040 "no new link tags" are superseded in part by MEM-044.
- `static/style.css` is rewritten in place; v6 ids, step rail, Review, tags and sched logic are not ported.
- New CSS tests pin token completeness, contrast in light and dark, forbidden properties on overlay ancestors and
  orphan classes/selectors.
- Android has no Iowan Old Style/Palatino/Georgia and falls back to Noto Serif; accepted.
- P2 watercolour asset regen is deferred (paid, nondeterministic).
