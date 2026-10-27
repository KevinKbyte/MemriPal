# 0021: Client palace store is IndexedDB behind an injected KV adapter, keyed by item + locus label

Status: Accepted
Date: 2026-10-27
Source: S3c (MEM-022) RED tests `static/palace_store.test.mjs`, `static/app_associations.test.mjs`; plan S3 block
(per-record save, resume regenerates only missing/invalid, D3 key fix).

## Context

[0003](0003-stateless-backend-client-state.md) puts palace state in browser IndexedDB. S3 generation must survive a
reload: each association record is saved as it arrives, and a resume regenerates only missing or invalid records.
The store must be testable under `node --test`, which has no IndexedDB, and the key must change when an item moves
to another locus (D3).

## Options considered

- (a) `createPalaceStore(adapter)` over an injected async `{get, put, list}` KV adapter (IndexedDB-backed in the
  browser, in-memory Map in node tests); records keyed by `associationKey(item, locusLabel)`; `put` acks only after
  `adapter.put` settles.
  Pros: same store code runs in browser and node tests; durable-before-ack bounds reload loss to the in-flight
  item; key includes the locus label, so a moved item regenerates instead of reusing a stale record.
  Cons: the IndexedDB adapter itself is browser-only and not exercised by node tests.
- (b) Call IndexedDB directly from `app.js`.
  Pros: no adapter layer.
  Cons: node tests need an IndexedDB shim or cannot run the generate flow at all.
- (c) localStorage.
  Pros: simplest API.
  Cons: ~5 MB per-origin quota; synchronous calls block the main thread; strings only, so S4 scene Blobs do not fit.
- (d) Server-side storage.
  Pros: survives clearing browser data; cross-device.
  Cons: contradicts the stateless backend of [0003](0003-stateless-backend-client-state.md); adds storage and an
  auth surface.

## Decision

(a). Entry per pair is `{record, status}` under `associationKey(item, locus.label)`; the key is collision-free even
when a field contains separator characters.

## Why this over the others

Only (a) keeps the 0003 IndexedDB decision while letting the whole generate flow run under node tests; (c) cannot
hold S4 Blobs and (d) reverses 0003.

## Consequences

- Reload loses at most the record whose request is in flight; resume skips stored `valid` entries.
- An item moved to another locus is a new key, so it regenerates (D3).
- IndexedDB adapter correctness rests on browser checks, not `node --test`.
- Clearing browser storage still loses palaces (0003).
