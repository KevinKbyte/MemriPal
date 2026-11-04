# 0068: The sticker pool lives client-side in IndexedDB behind `selectStore`

Status: Accepted
Date: 2026-11-04
Source: MEM-045 (`.claude/spec-cache/memripal/references/spec-6.md`).

## Context

Kev ask 2026-11-04: users upload their own pictures and stick them on a locus of the landmark photo; uploaded and
generated stickers join a pool with a text description so they can be searched and reused instead of regenerated;
emoji are the base stickers. The pool needs a store for entries (emoji, upload, generated) and per-place placements.
Pool sizes are a few hundred stickers per user. The backend is stateless (ADR 0003) and the public demo replays
fixtures.

## Options considered

- (a) IndexedDB key-value via `static/idb_adapter.js` behind flow.js `selectStore`, localStorage fallback (chosen).
  Pros: same injected-kv seam as palace_store and rehearsals (ADR 0021); offline and fixture mode work with zero
  server change; a downscaled JPEG data URL (<= ~50 KB) fits even the localStorage fallback; tests use an in-memory
  kv.
  Cons: per-browser only, no cross-device; no full-text index, so search is a linear scan (fine for a few hundred
  stickers).
- (b) The sqlite-wasm db (`static/db/*`, the route_store/palace_store SQL path).
  Pros: real SQL, LIKE search, one db for all data.
  Cons: the sqlite-wasm path is still a spike/adapter layer; adds migration and schema work; heavier load; no gain at
  pool sizes of hundreds.
- (c) Server-side storage.
  Pros: shared across devices; could share stickers with other users.
  Cons: breaks the ADR 0003 stateless backend; the fixture-replay public demo would fail writes offline; privacy of
  user photos; adds a spend and abuse surface.

## Decision

(a): `static/sticker_pool.js` takes an injected kv; `static/app.js` passes `selectStore(globalThis, {dbName:
"memripal-stickers", storeName: "stickers", prefix: "memripal.sticker:"})`. Uploads are downscaled client-side
(`static/thumbnail.js`, long side 256, JPEG q 0.8) before storing, so the pool never holds the original photo.

## Why this over the others

Only (a) matches the existing client persistence layer and the stateless backend, works offline and in fixture mode,
and is the smallest change. (b) pays schema and migration cost for search speed not needed at this scale; (c) breaks
ADR 0003 and the fixture demo and stores user photos on the server.

## Consequences

- Stickers and placements are per-browser; cross-device sync would need a new ADR.
- Search (follow-up MEM, merge 2) is a linear scan over `list()`; revisit (b) if pools grow to thousands.
- Only raster data URLs (jpeg, png, webp) are stored; svg and remote URLs are rejected at `add`.
