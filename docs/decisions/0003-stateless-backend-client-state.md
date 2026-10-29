# 0003: Stateless backend; palace state in browser IndexedDB

Status: Accepted
Date: 2026-10-26
Source: `docs/plans/2026-10-26-memripal.md` D5, D18, "Rejected alternatives" (Server DB + accounts, Palace JSON
import/export), "Ledger" (F5 resumability, S5 client-side privacy/import, stateless server vs S4).

## Context

Single-user demo. S4 scenes need the processed photo; resumable generation needs per-record persistence.

## Options considered

- Stateless server; client holds the processed photo and re-sends it (JPEG <= 2048 long side, <= 6 MB body) on
  every loci/scene request; palace in IndexedDB, scenes as Blobs.
  Pros: no server storage, accounts, or auth surface; per-record saves make generation resumable; 10 webp scenes at
  1024 px ~ 2-3 MB, far under browser quota.
  Cons: photo re-uploaded per request; server must re-validate on every endpoint.
- Server DB + accounts.
  Pros: none recorded.
  Cons: unneeded for a single-user demo; auth surface.
- Palace JSON import/export.
  Pros: none recorded.
  Cons: XSS/tracking surface for no Goal value.
  Superseded in part by ADR [0028](0028-palace-backup-export-import.md): validated additive JSON backup.
- Scenes stored as b64 strings (Ledger F5).
  Pros: none recorded.
  Cons: rejected by the Finisher's size check in favor of Blobs.

## Decision

Stateless backend. Every endpoint re-validates image bytes, dims and text caps and builds every model prompt
server-side. IndexedDB holds structured records with scene Blobs, saved per completed record. No accounts, no
import/export. Q1: stored rehearsals (D18) are human-readable JSON text records in the same store; audio is never
stored. "No import/export" superseded in part by ADR [0028](0028-palace-backup-export-import.md).

## Why this over the others

Removes server storage and auth for a demo that needs neither; the logical cache key uses the photo sha, so replay
still hits when the client re-sends the photo.

## Consequences

- Repeated photo upload per request (accepted; streaming scene generation over one request was rejected as
  complexity).
- Clearing browser storage loses palaces; there is no export. Superseded in part by ADR
  [0028](0028-palace-backup-export-import.md): a backup file restores rehearsals and cached associations.
