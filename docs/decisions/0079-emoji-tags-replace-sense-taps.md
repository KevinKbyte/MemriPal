# 0079: Emoji tags replace the sense quick-taps, auto-filled by keyword match

Status: Accepted
Date: 2026-11-04
Source: MEM-134 (`.claude/spec-cache/memripal/references/spec-6.md`). Amends
[0063](0063-route-view-mounts-one-station-card.md) (card sense display).

## Context

Kev ask 2026-11-04: "also not sure why we have "birds, traffic, water, voices, quiet, music as the multisensory - can
we just have emojis, so that itll be compact and also user gets more choices - they can search through for the right
emoji, though muse can power the initial auto generation based on the context, and user can change it to however they
like afterward". Each station already carries a Muse-made `profile` (visual, spatial, conceptual) and legacy `taps`
that `associate.py`, backup and `landmark_facts` read. The backend is stateless (ADR 0003) and the public demo replays
fixtures.

## Options considered

- (A) Searchable emoji tags, auto-filled by deterministic keyword match over the Muse-made profile (chosen).
  Pros: compact chip row; many choices via search; no extra API call, cost or latency; works offline and with fixture
  replay; deterministic and testable; `taps` kept, so no data loss and no backend change.
  Cons: auto-fill quality is bounded by the keyword table; only words in the profile text can match.
- (B) A live Spark call per station to pick emojis from the context.
  Pros: richer, context-aware picks.
  Cons: an extra call per station; new prompt, endpoint and fixture recordings; fails offline; spend-guard exposure;
  nondeterministic; not doable before the deadline.
- (C) Keep the fixed sense taps.
  Pros: no change.
  Cons: bulky four-grid card; few choices; ignores Kev's ask.

## Decision

(A): `static/emoji_tags.js` seeds a station's emojis from its legacy `taps` (`migrateTaps`) plus keyword matches over
its name, profile and category (`museEmojis`), saved once with `emojisEdited` false. Any user add or remove sets
`emojisEdited` true, and a stored user edit always wins over regeneration. `taps` stay stored unchanged.

## Why this over the others

(A) meets the ask (compact, searchable, Muse-driven start, user-editable) at zero added cost and degrades to nothing
worse than `EMOJI_DEFAULT`. (B) adds cost, a network dependency and nondeterminism; (C) is the complaint.

## Consequences

- The card renders an emoji chip row instead of the sound/smell/feel/mood grids; the turn grid and the turn lines of
  `#station-tap-summary` stay.
- Follow-up: a live Spark call (B) would replace `museEmojis` behind the same `startingEmojis` contract and needs its
  own ADR.
