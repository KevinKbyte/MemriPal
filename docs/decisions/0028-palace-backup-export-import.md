# 0028: Palace backup as one JSON file with a validated, additive client-side import

Status: Accepted
Supersedes: the "Palace JSON import/export" rejection in [0003](0003-stateless-backend-client-state.md) (Options,
Decision "no import/export", Consequences "there is no export") and its plan sources
(`docs/plans/2026-10-26-memripal.md` D5, Rejected alternatives, Ledger S5 "import cut").
Date: 2026-10-28
Source: MEM-042 (`.claude/spec-cache/memripal/references/spec-3.md`); three-adversary design review 2026-10-28;
`static/palace_store.js`, `rehearsals.js`, `storage_migrate.js`, `encode.js`, `flow.js`, `history.js`,
`src/memripal/record_sign.py`, `associate.py`, `app.py`.

## Context

Palace data lives only in one browser's storage: clearing it or switching device loses it (0003 Consequences).
0003 rejected import/export as "XSS/tracking surface for no Goal value", before stored rehearsals (D18) existed.

Stored state is smaller than 0003 and plan D5 say. Their "structured records with scene Blobs" was never built: no
photo and no scene image is persisted; `runEncode` (`encode.js`) re-requests every scene from the signed record on
each Load demo. Stored:
- palace store `memripal-palace`: `{record, status, sig?}` per `associationKey(item, locus)`, plus one route array
  under `"route"`;
- rehearsal store `memripal-rehearsals`: JSON-string records `{id, palace_id, timestamp, transcript, points}`.

The only palace id is `"demo"` (`flow.js`), and only Load demo runs `runEncode`, so a palace from a custom photo
stores nothing. No production code reads the route back (`loadRoute` is called only in tests).

## Options considered

Chosen option first in each item.

- (a) Scope. One backup file `{v, palace_id, route, associations, rehearsals}`.
  Pros: equal to per-palace today (one palace); one button.
  Cons: needs a schema change once a second palace exists. Alternative: a per-palace file (no palace id beyond
  "demo" yet, so a selector with one choice).
- (b) Images. None in the file.
  Pros: none are stored; no base64/magic-byte decode sink on import.
  Cons: the user reloads the demo or re-uploads the photo; scenes regenerate. Alternative: embed photo and scenes
  (an untrusted-image sink for no gain).
- (c) Merge. Additive: an existing entry wins, an invalid entry is skipped (the `storage_migrate.js` rule), counts
  reported.
  Pros: an import can never destroy data; re-importing is a no-op.
  Cons: a backup cannot replace a stale entry. Alternative: overwrite on import (an old or bad file clobbers newer
  data).
- (d) Where import runs. Client only.
  Pros: backend stays stateless (0003); the /scenes signature check (0027) already guards the one paid path a
  forged record could reach.
  Cons: validation lives in JS. Alternative: a server import endpoint (needs server state or a duplicate validator,
  adds no guard).
- (e) Unknown record keys. The entry is rejected, never stripped.
  Pros: stripping changes the canonical JSON `record_sign.py` signs, leaving a valid-looking entry that only 403s.
  Cons: entries from a future schema import as skipped. Alternative: strip unknown keys.
- (f) Dead signatures. On /scenes 403 `bad_signature` the client re-puts the entry with status "invalid".
  Pros: `runAssociations` regenerates any non-"valid" entry, so imported or restart-orphaned entries recover.
  Cons: one /associate call per such entry (paid in live mode). Alternative: leave it (a "valid" entry is reused
  every run, so its scene stays tier 3 forever).
- (g) XSS control. App-wide CSP + `nosniff` on every response, on top of textContent-only rendering.
  Pros: independent of import; nothing in `static/` breaks.
  Cons: FastAPI `/docs` and `/redoc` stop rendering. Alternative: textContent discipline alone.

## Decision

The chosen option in each of (a)-(g), specified as MEM-042 clauses E1, I1-I7, C1, R1. A backup restores rehearsal
history, cached associations and the route; it never restores photos or scene images.

## Why this over the others

"No Goal value" stopped holding once rehearsal history lived in one browser only. The XSS concern is met by parsing
into fresh allow-listed objects with exact keys, types and caps, textContent-only rendering, and a CSP. Import
makes no request, so it adds no tracking path.

## Consequences

- The backup file exposes recall transcripts and place names wherever the user keeps it; mitigated only by the
  one-line UI note.
- Restoring on another deployment, or after a restart without `MEMRIPAL_RECORD_KEY`, regenerates each entry on its
  first scene 403 (paid in live mode) unless both share the key.
- An entry whose echoed item/locus differs from the requested text (accepted after `normalize`,
  `validate_association`) restores under a different key and regenerates once.
- 0003's and plan D5's "scene Blobs" are recorded here as never built.
