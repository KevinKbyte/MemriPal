# 0062: Paper Crown theme (direction A) with direction C's lantern stations

Status: Accepted
Relates: [0030](0030-adopt-v6-css-markup-only.md) (v6 tokens the theme remaps), MEM-044 (painterly theme), MEM-102
(amends MEM-044's "--body never set" clause).
Date: 2026-11-04

## Context

The painterly theme (`static/theme-painterly.css`, MEM-044) read as generic. The demo needs a distinct storybook look
before the hackathon freeze, Wed 2026-11-04 12:00 ET, without breaking MEM-044's CSP, contrast and layout guarantees.
Four directions were researched with WCAG-checked palettes mapped onto the existing token names
(`--bg --surface --ink --muted --line --primary --on-primary --lamp --ok --bad`).

## Options considered

- (A) Paper Crown: warm paper, ink line, cut-paper layering, one crown gold; Fraunces display, Nunito UI (chosen).
  Pros: matches the mascot canon (Pal's paper crown, `docs/design/mascot.md`); a token remap of the existing painterly
  theme, so lowest effort before the freeze; a light base keeps the muted basemap and photos readable; one scarce
  gold accent.
  Cons: warm paper themes are common, so less novel; gold is 1.9:1 on paper, so it needs an ink outline or glyph to
  pass non-text contrast.
- (B) Field Atlas: cartographic notebook, contour lines, red survey route; Literata + Atkinson Hyperlegible.
  Pros: puts the real-map differentiator front and center; well-established label rules.
  Cons: red route collides with red miss; reads as a navigation app, not a memory companion; Pal has little room.
- (C) Lantern Walk: dark indigo palace, each station a lantern that ignites on recall; Bricolage Grotesque + Nunito.
  Pros: maximum contrast on the recall peak; avoids pure black and desaturates accents.
  Cons: dark map tiles and street photos are harder to keep legible; whole-app dark is a bigger restyle than A in
  the time left; Pal artwork must work on dark.
- (D) Pop Palace: chunky ink outlines, flat saturated blocks, hard offset shadows.
  Pros: thick ink borders pass non-text contrast for free; legible in compressed video.
  Cons: many saturated colours compete, so the recalled accent stops being distinct; loud frames fight photos and
  map; tone clashes with calm eyes-closed recall.

## Decision

(A) Paper Crown, plus (C)'s one idea: lit recall items glow like lanterns, and nothing else uses gold. Dark mode uses
(C)'s indigo / off-white / lamp roles.

- Fonts: Fraunces (`--display`: `.brand`, `h2`, `h3`, `.map-chip`) and Nunito (`--body`), self-hosted as woff2 under
  `/static/fonts/` with their OFL licence files; `font-src 'self'`, no remote fonts.
- New tokens `--on-lamp` (ink on gold) and `--glow` (lantern box-shadow; transparent in light, gold haze in dark).
- Gold (`--lamp`) only marks recalled state: `.live-board li.lit` and `.route-node.lit`.
- Crown edge: `.topbar::after` draws the zigzag crown strip.
- The reduced/reset media block (`forced-colors: active`, `prefers-contrast: more`, `print`) drops the crown edge and
  the glow.
- All 17 contrast pairs pass WCAG AA in light and dark.

Files: `static/theme-painterly.css`, `static/fonts/`, `docs/design/paper-crown/`. Spec: MEM-102.

## Why this over the others

(A) is the only direction that fits the mascot canon and ships as a token remap of the theme already in place, so it
fits the freeze. Borrowing (C)'s lantern puts the scarce accent on the recall peak, the beat (C) was best at, without
(C)'s whole-app dark restyle or its map/photo legibility cost. (B) and (D) lose on the same axis: (B)'s red route
blurs into miss, and (D)'s saturated blocks leave no distinct recalled accent.

## Consequences

- MEM-044's "--body never set" clause is amended: the theme may set a non-serif `--body` (MEM-102).
- Gold must stay reserved for recalled state; any new gold use dilutes the lantern beat.
- Gold on paper always needs `--on-lamp` ink or a glyph; it fails non-text contrast alone.
