# 0026: Recall matcher runs client-side; server only relays one WAV clip to ASR

Status: Accepted (amends [0008](0008-spoken-recall-deterministic-matcher.md) transport)
Date: 2026-10-28
Source: plan S6 (D4, D17, MEM-031, MEM-032); tests `static/recall_match.test.mjs`, `static/recall.test.mjs`,
`tests/test_recall_audio.py`; GREEN commits `c07d2f2`, `6fe6ed9`.

## Context

0008 chose a deterministic matcher and the Muse STT relay, but not where matching runs, its window rules, or
which transport ships.

## Options considered

Chosen option first in each item.

- (a) Where matching runs. Client JS (`static/recall_match.js`).
  Pros: backend stays stateless ([0003](0003-stateless-backend-client-state.md)); typed fallback and fixture
  replay match offline with no request.
  Cons: matcher logic is JS-only. Alternative: server Python matcher (per-session state, a request per typed answer).
- (b) Rule. Token window Levenshtein ratio >= 0.8 (length n +- 2) or >= 60% content-word coverage (<= n + 4
  tokens), against source quote and label; total-order tie-break.
  Pros: deterministic, no model, voice injection matches nothing.
  Cons: loose paraphrase can miss (manual "mark got it"). Alternative: embedding or LLM similarity
  (nondeterministic, costly, injectable).
- (c) Incremental append. Only windows ending in new tokens are judged; matched stays matched.
  Pros: bounded work per chunk; results never flip.
  Cons: a later better span never replaces the first. Alternative: re-match the whole transcript each chunk (quadratic, spans can change).
- (d) Transport. JSON `{audio, keywords}` with one base64 WAV clip per request -> `{text}`; fixture mode 409
  `live_only`, the client replays `/demo/recall.json`.
  Pros: plain HTTP under the same caps and passcode gate; audio stays in request memory.
  Cons: per-clip latency. Alternatives: realtime WebSocket relay (0008 primary; long-lived connection, harder to
  cap); browser Web Speech (rejected D17: non-Meta, audio to Google).

## Decision

The chosen option in each of (a)-(d).

## Why this over the others

Client-side deterministic matching keeps the server a stateless, capped ASR relay and works offline, where the
alternatives add server state, model calls, or a non-Meta speech path.

## Consequences

- Client mic capture to WAV clips and the /recall/audio post are not built yet.
- Mic missing or denied falls back to a typed box on the same matcher.
