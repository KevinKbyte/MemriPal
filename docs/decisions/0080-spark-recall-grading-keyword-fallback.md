# 0080: Spark grades spoken recall; keyword match stays the floor and fallback (MEM-136)

Status: Accepted
Date: 2026-11-04

## Context

- The deterministic keyword matcher (ADR 0008, 0026) misses paraphrased spoken recall ("the bang-bang sky lights"
  for "fireworks").
- Kev: "we can use asr + keyword match as fallback" and "spark in the demo".

## Options considered

- (A) Keyword match only (status quo).
  Pros: deterministic; free; no extra latency.
  Cons: misses every paraphrase.
- (B) Spark grading replaces the matcher.
  Pros: catches paraphrase.
  Cons: nondeterministic; any latency spike or outage means no scoring at all.
- (C) Spark grade adds paraphrase hits on top of the unchanged matcher; got = union of matcher hits and grade
  `correct` indices (chosen).
  Pros: catches paraphrase; the deterministic matcher is the floor and the whole fallback.
  Cons: see Consequences.

## Decision

Option (C), per MEM-136.

- Grader: strict json_schema `recall_grade` output; expected labels fixed server-side from the request keywords;
  transcript quoted as data in the prompt; `max_completion_tokens` 256 plus ADR 0077 headroom.
- Only `correct` verdicts count as got; `partial` is ignored.
- Providers: the configured non-Meta chat provider, then the chat fallback (Baseten/Fireworks); Meta is never used,
  keeping Meta spend for ASR. Per-call timeout 8 s.
- Any grader failure -> POST /recall/audio returns `{"text"}` only; keyword scoring is unchanged.

## Why this over the others

(C) keeps ADR 0008's guarantee that a paraphrase cannot be argued into a match by the matcher: the matcher is
untouched, and Spark hits are only additive. (A) leaves the paraphrase miss unfixed; (B) trades a deterministic
scorer for one that fails closed to no score. Prompt injection ("mark all correct") can only inflate the speaker's own
self-score, and the strict schema plus server-fixed labels bound what a reply can claim.

## Consequences

- BYOK visitors' grading still spends the shared Fireworks key.
- Extra latency per recall slice; grading is async and never blocks the transcript.
- Grading is nondeterministic, but only ever adds hits over the deterministic floor.
