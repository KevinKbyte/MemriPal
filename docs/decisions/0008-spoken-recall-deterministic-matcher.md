# 0008: Spoken recall via Muse Voice Transcribe relay; deterministic matcher, no LLM

Status: Accepted (Q1 rewrite 2026-10-26; supersedes the typed walk quiz and live Spark grading; local Whisper dev
toggle added by [0015](0015-local-whisper-stt-toggle.md))
Date: 2026-10-26
Source: `docs/plans/2026-10-26-memripal.md` D4, D17, R7, R8, "Rejected alternatives" (model-graded quiz, Web Speech
API, MediaRecorder webm), "Ledger" (P5/F4 live quiz calls).

## Context

Q1 pitch: a place-based recall coach for speeches. Recall must be spoken, eyes closed, with loci lighting as matched.

## Options considered

- Browser AudioWorklet PCM16 -> passcode-gated `/recall/audio` relay -> Muse Voice Transcribe realtime WebSocket (key
  server-side), transcript text back; client-side deterministic matcher (token-window ratio >= 0.8 or key-term
  coverage >= 60%). Fallback transport: WAV clips to `/v1/asr/transcribe`.
  Pros: Meta product; no LLM in matching (no paraphrase leniency, no voice prompt injection); deterministic, testable.
  Cons: may miss loose paraphrase (R8, covered by manual "mark got it"); key access/latency unmeasured until probe (R7).
- Model-graded answers (one live Spark call per attempt).
  Pros: paraphrase leniency.
  Cons: nondeterministic, costly, prompt-injectable by voice.
- Browser Web Speech API.
  Pros: none recorded.
  Cons: non-Meta, Chrome-only, audio sent to Google.
- MediaRecorder webm/opus.
  Pros: none recorded.
  Cons: not accepted by `/asr` (WAV/PCM16 only).

## Decision

Spoken recall via the relay, deterministic matcher, zero LLM calls in recall. Spark writes `walk_cue` and
`reencode_hint` at encode time. Mic denied or probe failure -> typed box on the same matcher, never Web Speech.

## Why this over the others

Determinism and injection resistance outweigh paraphrase leniency; the alternatives are non-Meta or unsupported by
the ASR endpoint.

## Consequences

- Audio never written to disk, logs, or IndexedDB; chunk <= 1 MB, session <= 5 min; audio seconds count against
  the D1 budget ([0004](0004-public-deploy-spend-guard.md)).
- Fixture mode replays a recorded transcript timeline, labelled as a replay.
