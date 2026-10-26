# 0002: `meta|fixture` backend modes with a logical-key replay cache

Status: Accepted (association key amended Q1 2026-10-26; seam reshaped by [0011](0011-s2-loci-request-shape.md))
Date: 2026-10-26
Source: `docs/plans/2026-10-26-memripal.md` D3, A1, "Ledger" (F2 fixture key fragility, P4 record mode, C1/F1
fixtures unavailable).

## Context

The demo loop must run live against the Meta Model API and reproduce offline from a clean clone, with fixtures
available from day 1 (before the key arrived).

## Options considered

- Two modes, `meta` (live, write-through cache of raw response bodies) and `fixture` (replay only), keyed by logical
  identity (method, processed-photo sha256, phrase|item, attempt n, PROMPT_VERSION).
  Pros: one code path records and replays; keys survive incidental request changes; no auth headers in fixtures.
  Cons: key must name every input that changes the answer (see Consequences: the item-only association key bug).
- Separate `record` mode (Ledger P4).
  Pros: none recorded.
  Cons: an extra mode; folded into `meta` write-through instead.
- Key by raw request bytes (Ledger F2).
  Pros: exact match.
  Cons: fragile (any byte change misses), and can carry auth headers into fixtures.

## Decision

`meta` with write-through and `fixture` replay-only, keyed by logical identity plus PROMPT_VERSION. Fixture miss
raises typed `FixtureMissing`; the UI falls back (tier 3 scenes, last recorded association attempt).

## Why this over the others

Logical keys plus PROMPT_VERSION were the Ledger fix for fixture fragility; write-through removed the need for a
separate record mode; synthetic fixtures in S0 unblocked S2-S6 before the key.

## Consequences

- Q1 bug fix: an item-only association key re-pairs items with the wrong locus after reorder/drop/dedupe; the
  association key adds the locus short label (lands in S3).
- The original seam had no channel for image bytes/prompt/schema; [0011](0011-s2-loci-request-shape.md) replaces
  it with a `ModelRequest`-derived key.
