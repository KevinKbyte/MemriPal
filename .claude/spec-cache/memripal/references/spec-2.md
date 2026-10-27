# MemriPal spec (continuation)

Continuation of [spec.md](spec.md), which is at its 500-line cap.

## MEM-023 Demo notes + replayed associations

Plan S3d. Extends the MEM-017 demo fixtures to the split + associate flow; `scripts/make_synthetic_fixtures.py`,
`src/memripal/app.py`, `fixtures/demo/notes.txt`.
- `fixtures/demo/notes.txt`: committed demo speaker notes, non-blank UTF-8, <= `MAX_NOTES_BYTES` (MEM-020 notes cap),
  listed in `fixtures/MANIFEST.md`. Its bytes are part of the split replay key, so `.gitattributes` pins it
  `text eol=lf` (a `core.autocrlf=true` CRLF checkout would miss the replay); `eol=lf` or `-text` both satisfy the
  test.
- GET /demo/notes.txt: serves the file as stored bytes, byte-identical, `text/plain`; file missing -> 404
  {"error": "demo_missing"} JSON, never 500.
- Generator: writes the notes, replays the demo loci (FixtureBackend, frozen clock), then runs the real
  `split_notes` and `associate` against `ReplyRecorder`, which caches one canned reply under each request's own
  `cache_key()`, so replay keys match lookup exactly. Split reply = 12 points, each `source_quote` verbatim from the
  notes; one association record per (point label, locus label) pair, paired in order.
- Fixture replay: notes-mode split of the notes against the processed demo photo -> exactly 12 points (= demo loci
  count = `MAX_POINTS`); label non-blank, <= `MAX_LABEL_CHARS`; `normalize(source_quote)` in `normalize(notes)`;
  speech order; labels distinct after `normalize`. Each of the 12 pairs -> `associate` status "valid", 1 <=
  attempts <= 3, record passes `validate_association` (MEM-021).
- Offline end to end: MEMRIPAL_MODE=fixture, no META_API_KEY, `socket.getaddrinfo` / `socket.create_connection`
  blocked. GET /demo/photo.jpg -> POST /loci (served bytes) -> GET /demo/notes.txt -> POST /split (mode notes,
  photo = base64 from the /loci data URL, loci_count 12) -> POST /associate per pair in order with the /loci data
  URL; every call 200, every association "valid" and validator-clean.

Tests: tests/test_demo_assoc_fixtures.py
