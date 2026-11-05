# 0084: Pal chat gets a dedicated POST /chat route (MEM-142)

Status: Accepted
Date: 2026-11-04

## Context

- Pal chat showed no model reply: `static/pal_bubble.js` selfMount passed only `act`, no `reply`, and no chat route
  existed.
- Needs a model call without exposing provider keys, behind the existing passcode, BYOK and rate gates.

## Options considered

- (A) New dedicated POST /chat route; server-side Pal system prompt; provider via `MEMRIPAL_CHAT_PROVIDER` plus BYOK
  (chosen).
  Pros: key stays server-side; reuses passcode/BYOK/rate gates; `create_app(pal_chat=callable)` gives tests a clean
  injection seam.
  Cons: one more route to maintain.
- (B) Piggyback the existing spark/recall JSON route.
  Pros: no new route.
  Cons: couples chat to the recall grading schema.
- (C) Browser calls the model provider directly.
  Pros: no server code.
  Cons: leaks provider keys; bypasses every server gate.

## Decision

Option (A), per MEM-142: POST /chat `{message, history}` -> `{text}`; 400 on invalid input; upstream failure -> 502
`{"error":"chat_unavailable"}` with no provider detail; fixture mode returns a canned reply with no network call.
Frontend `static/pal_reply.js` `createPalReply(fetchFn)` posts /chat; selfMount passes it as `reply`.

## Why this over the others

(A) is the only option that keeps the key server-side and the gates intact while staying independently testable.
(B) ties chat's contract to recall grading, so a change to either breaks the other; (C) is a key leak.

## Consequences

- Chat spends the shared chat-provider key unless the visitor supplies BYOK.
- History is capped at 40 turns and messages at 4000 chars, bounding prompt size per call.
