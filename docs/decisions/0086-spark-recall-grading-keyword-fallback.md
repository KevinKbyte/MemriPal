# 0086: Spark grades spoken recall; keyword match stays the floor and fallback (MEM-145)

Status: Accepted
Date: 2026-11-04

## Context

- The deterministic keyword matcher (ADR 0008, 0026) misses paraphrased spoken recall ("the bang-bang sky lights"
  for "fireworks").
- Kev: "we can use asr + keyword match as fallback" and "spark in the demo".
- Scope add, Kev: "plus setting in the app to use spark - and itll auto drop down to asr + keyword if there are
  issues with spark (eg out of tokens or whatever - though user can byok if they really want to try it, and itll let
  user know if it has to downgrade to asr/keyword if user still wants spark but we are having issues with it)".

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

Option (C), per MEM-145.

- Grader: strict json_schema `recall_grade` output; expected labels fixed server-side from the request keywords;
  transcript quoted as data in the prompt; `max_completion_tokens` 256 plus ADR 0077 headroom.
- Only `correct` verdicts count as got; `partial` is ignored.
- Opt-in: Settings checkbox `#grade-with-spark` (localStorage, default off). Off = ASR + keyword only; the request
  carries no `grade` field, so no grading call is made.
- Providers: the visitor's MEM-122 BYOK Meta key first when present (tab memory only, never logged); then the
  configured non-Meta chat provider, then the chat fallback (Baseten/Fireworks). The server's own Meta key is never
  used, keeping its spend for ASR. Per-call timeout 8 s.
- On + any grader failure (spend cap, out of tokens, upstream error, timeout) -> that answer scores by ASR + keyword;
  the response carries `grade_error: "unavailable"` (never a provider body) and the board shows a dismissible
  `.grade-downgrade` notice linking to the MEM-122 BYOK key prompt.

## Why this over the others

(C) keeps ADR 0008's guarantee that a paraphrase cannot be argued into a match by the matcher: the matcher is
untouched, and Spark hits are only additive. (A) leaves the paraphrase miss unfixed; (B) trades a deterministic
scorer for one that fails closed to no score. Prompt injection ("mark all correct") can only inflate the speaker's own
self-score, and the strict schema plus server-fixed labels bound what a reply can claim.

## Consequences

- Opt-in: visitors who leave the setting off cost no grading spend at all.
- With the setting on and no BYOK key, grading spends the shared chat-provider (Fireworks) key; BYOK moves that spend
  to the visitor's own Meta key.
- A silent downgrade would hide why paraphrases stop scoring; the notice makes it visible and offers BYOK.
- Extra latency per recall slice; grading is async and never blocks the transcript.
- Grading is nondeterministic, but only ever adds hits over the deterministic floor.
