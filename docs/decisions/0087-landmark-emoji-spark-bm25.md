# 0087: Landmark station emoji: Spark first, then BM25 over an emoji corpus, then pushpin (MEM-140)

Status: Accepted
Date: 2026-11-05

## Context

- Station icons came only from a name keyword table (`static/landmark_emoji.js` `emojiFor`) with pushpin U+1F4CD as
  the default, so routes between arbitrary places mostly showed pushpins.
- Kev asked that icons auto-generate "to the best of Spark's ability" with "a fallback keyword search ... similar to
  how sqlite does it with bm25 ... against the emoji".

## Options considered

- (a) Keyword table only (status quo).
  Pros: deterministic, offline, zero cost.
  Cons: only names containing a listed keyword match; most arbitrary places get pushpins.
- (b) BM25 only, offline over a local emoji corpus.
  Pros: deterministic, offline, unit-testable; ranks partial matches and uses POI category and tags, not just name.
  Cons: lexical only; misses landmarks whose words appear in no emoji's name or keywords.
- (c) Spark (LLM) only.
  Pros: best semantic fit for any landmark.
  Cons: network, latency and spend per station; nondeterministic; no icon offline or on failure.
- (d) Spark, then the keyword table plus BM25, then pushpin (chosen).
  Pros: Spark's fit when online; deterministic offline result; never blocks or errors.
  Cons: two code paths; online icons are nondeterministic. Mitigated: the reply is validated and every failure
  falls back to the deterministic chain.

## Decision

Option (d). Client `pickLandmarkEmoji` (`static/landmark_emoji_spark.js`) calls backend `POST /landmark-emoji`
(`src/memripal/routes_landmark_emoji.py`), which prompts the `ChatProvider` for one best-fit emoji and returns
`{"emoji": null}` on any failure, never a 500. The client waits at most 2.5s and accepts only a single pictographic
grapheme. Otherwise `emojiFor` runs: the keyword table, then Okapi BM25 (k1 1.2, b 0.75, in the style of SQLite FTS5
`bm25()`) over `static/emoji_corpus.js` (>= 100 entries, name + keywords), queried with the landmark name, POI
category and tag values (`static/emoji_bm25.js`), then pushpin. Offline uses BM25 only. Chat `create_route` passes
Spark through.

## Why this over the others

Only (d) meets both halves of Kev's ask: Spark picks the icon when it can, and an SQLite-style BM25 search covers
every case where it cannot. (a) is what produced the pushpins; (b) alone drops Spark; (c) alone leaves no icon
offline and fails per station on any network or provider error.

## Consequences

- Online icons can differ between runs; offline icons are deterministic.
- New icon coverage comes from adding corpus entries, not keyword-table rows.
- The endpoint spends one Spark call per station lookup that reaches it.
