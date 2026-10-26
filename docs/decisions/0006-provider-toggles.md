# 0006: Meta as the default provider; others only behind env flags

Status: Accepted
Date: 2026-10-26
Source: `docs/plans/2026-10-26-memripal.md` D12, A1, "Rejected alternatives" (self-hosted SAM), "Ledger" (A4/C-simp
local SAM path).

## Context

Stage 1 requires using Meta AI products. Other providers' credits were not guaranteed; a no-key fallback was needed
until the key arrived.

## Options considered

- Meta default; `MEMRIPAL_CHAT_PROVIDER=meta|baseten|fireworks|local` (all OpenAI-compatible) and
  `MEMRIPAL_SEG_PROVIDER=meta|modal`, off the default path.
  Pros: default path is all Meta; `local` serves offline demos and post-hackathon personal use.
  Cons: more adapters; non-meta paths have mocked-transport tests only.
- Self-hosted SAM 3.1 (local or Modal) in the main path or as the no-key fallback.
  Pros: none recorded.
  Cons: gated weights, license "other", different output format, HF approval latency.
- No-key fallback via hand-annotated boxes on the real demo photo (A1).
  Pros: video still shows the real photo and real associations; ~30 min of work.
  Cons: stubbed loci (R1).

## Decision

Meta default for chat, segmentation and image edit. Chat and segmentation providers switch only by env flag; Modal
SAM ships as an off-by-default adapter mapping to the same Box list. Image edit stays Meta only (canvas tier 3 is the
fallback). No-key fallback = hand-annotated boxes, not self-hosted SAM.

## Why this over the others

Keeps the judged path on Meta products while allowing flagged fallbacks; self-hosted SAM's licensing and format
costs ruled it out of the main path.

## Consequences

- Each non-meta adapter must map to the same domain types.
- Q1: the local-LLM quiz fallback slot is superseded by [0008](0008-spoken-recall-deterministic-matcher.md);
  `local` stays a chat provider for encode-time calls.
