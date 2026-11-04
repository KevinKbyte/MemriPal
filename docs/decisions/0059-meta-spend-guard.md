# 0059: Server-side persisted Meta spend estimate with a cap; chat falls back to Baseten or Fireworks

Status: Accepted
Amends: [0004](0004-public-deploy-spend-guard.md) (R3: the budget no longer resets on restart). Relates:
[0023](0023-chat-provider-adapter-reuses-meta-client.md) (chat providers), MEM-094.
Date: 2026-11-03
Source: Kev, 2026-11-03: "as long as the judges are able to haev enough credits to use and judge, and that we dont
go over for our meta".

## Context

- Meta's spend limit only notifies; it does not stop calls, and Kev's card is on file, so spend past the $150 Meta
  credit is billed.
- Baseten and Fireworks have no card on file and hard-stop at $0.
- 0004's per-instance budget is in memory and resets on restart (R3 accepted there).
- Judges need live mode to keep working while they judge.

## Options considered

- (A) Server-side guard: each Meta call (Spark chat, SAM, ASR) adds a per-call cost estimate to a persisted total;
  at a configurable cap (default $135) the server refuses Meta calls with a typed error and chat falls back to
  Baseten or Fireworks (chosen).
  Pros: stops spend before the credit runs out, whatever the dashboard does; survives restarts; judges keep chat.
  Cons: an estimate, not real billing; SAM and ASR stop at the cap; persisted state to keep.
- (B) Rely on Meta dashboard notifications only.
  Pros: no code.
  Cons: a notification stops nothing; overspend bills Kev's card.
- (C) Query a real Meta billing API per call.
  Pros: exact spend.
  Cons: no such public API is known; adds latency to every call.
- (D) Hard per-process call-count limit, not persisted (0004's budget as is).
  Pros: simple; already exists.
  Cons: lost on restart, so each restart grants a fresh budget; counts calls, not cost.

## Decision

Option (A). Default cap $135, below the $150 credit to leave margin for estimate error. Refusal is a typed error, not
a generic failure. Spark chat falls back to Baseten or Fireworks; SAM and ASR return the refusal.

## Why this over the others

Only (A) and (C) stop spend; (C) has no known API and costs latency. (B) only notifies. (D) resets on restart and
ignores per-call cost. (A) keeps chat working for judges through providers that cannot overspend.

## Consequences

- Estimates can drift from real billing: Kev checks the Meta dashboard before and after recording.
- Cap default $135; raise or lower it by config.
- Past the cap, SAM and ASR features stop until the cap is raised.
