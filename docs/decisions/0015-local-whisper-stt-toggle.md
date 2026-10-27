# 0015: Muse STT default; local Whisper behind an env toggle (over replacing Muse with OpenWhispr)

Status: Accepted (amends [0006](0006-provider-toggles.md) and [0008](0008-spoken-recall-deterministic-matcher.md))
Date: 2026-10-26
Source: Kev, 2026-10-26: "we should use openwhispr to get the voice so muse doesnt need to do the heavy voice
lifting"; adversary review of that ask; Kev's choice "Muse default + local Whisper toggle".

## Context

Kev asked to offload voice transcription from Muse to OpenWhispr. OpenWhispr (github.com/OpenWhispr/openwhispr) is an
MIT Electron desktop dictation app: no browser build, no streaming STT API, so judges' browsers cannot reach it. The
voice probe (R7) has never run, so there is no evidence of a Muse problem. Dropping Muse also weakens the "Use of Meta
AI tooling" judging criterion.

## Options considered

- Replace Muse with OpenWhispr.
  Pros: offloads STT from Muse.
  Cons: desktop-only, no browser or streaming API, unreachable by judges; loses Meta tooling credit.
- Muse only; run the voice probe first.
  Pros: no new adapter; keeps the judged path unchanged.
  Cons: no offline dev path for recall.
- Toggle `MEMRIPAL_STT_PROVIDER=meta|local` (default `meta`); `local` = loopback-only faster-whisper behind an
  OpenAI-compatible `/v1/audio/transcriptions` endpoint at `MEMRIPAL_LOCAL_STT_URL`, dev/offline only.
  Pros: offline dev path; judged/deployed path stays Muse; same pattern as [0006](0006-provider-toggles.md).
  Cons: ~half a day of work judges never see; mocked-transport tests only.
- Browser Web Speech API.
  Pros: none recorded.
  Cons: non-Meta, Chrome-only, audio sent to Google (already rejected in [0008](0008-spoken-recall-deterministic-matcher.md)).
- transformers.js Whisper in-browser.
  Pros: none recorded.
  Cons: not chosen; the loopback server toggle covers the offline need without shipping a model to the browser.

## Decision

Muse Voice Transcribe stays the default and the only judged/deployed STT. `MEMRIPAL_STT_PROVIDER=local` switches to
a loopback-only faster-whisper server via `MEMRIPAL_LOCAL_STT_URL`, for dev/offline use only. Any other value is an
error at startup.

## Why this over the others

Keeps Meta tooling on the judged path while giving an offline dev path; OpenWhispr cannot serve browsers at all, and
there is no evidence Muse needs replacing.

## Consequences

- ~half a day of work judges never see; covered by mocked-transport tests only (MEM-019).
- Typed-box fallback on mic denial or probe failure unchanged ([0008](0008-spoken-recall-deterministic-matcher.md)).
- `local` URL restricted to loopback hosts: audio never leaves the machine, and the URL cannot be pointed at an
  arbitrary host (SSRF).
