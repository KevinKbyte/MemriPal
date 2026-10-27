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

## MEM-025 Place context (opt-in location lookup)

ADR [0022](../../../../docs/decisions/0022-opt-in-place-context-server-lookup.md) (amends 0009). Plan S3e. Kev
2026-10-27: "add a setting feature where user can enable location access to check for any historical significance of
picture being taken to use that as part of context for memory hook" / "opt-in for privacy".

a) Client (`static/place.js`, `static/app.js`, `static/index.html`):
- `index.html` has an unchecked `#place-toggle` labelled "Use my location for place history". `createPlaceState(storage)`
  -> `{enabled(), setEnabled(on), confirm(place), setTyped(title), current()}`; state in localStorage, OFF by default
  (empty or throwing storage reads as off); on and one-tap off both persist across a reload.
- `readGps(bytes)` (Uint8Array or ArrayBuffer of a JPEG) -> `{lat, lon}` | null: APP1 Exif GPS IFD, II or MM byte
  order, N/S/E/W refs; null for no Exif, no GPS IFD, non-JPEG, empty or truncated input; never throws.
- `onPhotoChange(input, deps)`, deps add `{place, geolocate}`. Toggle on: coords from `readGps` on the ORIGINAL file,
  read before `reencodeJpeg` strips EXIF (server `has_exif` rejection untouched); no GPS -> `geolocate()`
  (`navigator.geolocation`, secure context only: localhost / Cloud Run https); none -> typed place. POST /place JSON
  `{lat, lon}` rounded to 4 dp. Toggle off: no /place request, geolocation never asked.
- Top 3 places shown as chips "Near: <title>, <m> m"; the user confirms one (`confirm`). Model and Wikipedia text via
  textContent only.
- `runAssociations(pairs, deps)`, deps add `{place}`: non-null `place.current()` adds `place` {title, extract} to the
  /associate body; else the body stays exactly `{image, item, locus}`. `setEnabled(false)` discards the confirmed
  place, so no auto place is sent; re-enabling does not restore it; a typed place is still sent with the toggle off.

b) POST /place (`app.py`, `src/memripal/place.py`), stateless, never logs or stores coords:
- Content-Type not application/json -> 415 {"error": "unsupported_media_type"}; body past a small cap -> 413
  {"error": "too_large"}. Body exactly {"lat": number, "lon": number}, finite, lat in [-90, 90], lon in [-180, 180],
  bools refused; anything else -> 400 {"error": "bad_request"}. No upstream call on any rejection; never calls the
  model backend.
- `PlaceProvider(transport: httpx.BaseTransport | None = None)`, injected via `create_app(backend=...,
  place_provider=...)` (None -> default provider on the real network). Wikipedia GeoSearch (`en.wikipedia.org/w/api.php`,
  `list=geosearch`, `gscoord "<lat>|<lon>"`, `gsradius 500`) then the REST page summary per hit; descriptive
  User-Agent (not `python-httpx`); every timeout <= 2 s; in-process LRU keyed by coords (repeat -> no new GeoSearch).
- 200 {"places": [{"title", "distance_m" (int, rounded metres), "extract" (plain text, <= 400 chars)}]}, top 3 hits.
  Any upstream failure (429, 5xx, timeout, connect error, non-JSON) -> 200 {"places": []}.
- No log record (any logger, any level, incl. httpx URL logging, silenced) carries the coords.

c) POST /associate (MEM-021) optional `place`:
- Body `{image, item, locus}` or `{image, item, locus, place}`, place exactly {"title": non-blank str <= 255
  chars, "extract": str <= 400 chars} (typed place may have an empty extract). Any other bad place (non-object, missing
  or unknown key such as coords, non-string, blank title) -> 400 {"error": "bad_place"}. No model call on any rejection.
- Title over 255 chars (255 = Wikipedia max title length) or extract over 400 -> 400 {"error": "place_too_long"}
  (`associate.py::check_place`).
- With place: `gen_params[PROMPT_ARGS]` carries it (part of the cache key) and a "PLACE FACTS" template ("use only
  PLACE FACTS") is appended after ASSOCIATION_PROMPT, like ASSOCIATION_RETRY. Coords never reach Meta or the key.
- Without place: prompt args, prompt text and cache key byte-identical to pre-MEM-025 (digest pinned), so every
  recorded association fixture replays.

d) Offline demo: synthetic room photo + demo place sidecar (Little Round Top, 39.7922,-77.2366) + recorded /place
replay (Kev Q8, 2026-10-27). A real own-room photo may replace the synthetic one later.

Acceptance (plan CRITERIA):
1. Toggle default off; no /place request while off (node test).
2. Toggling off drops the place from the next /associate body (node test).
3. EXIF GPS reader parses a GPS JPEG; null on none (node test).
4. /place fixture replay offline; 429/timeout -> 200 empty list; coords absent from logs (pytest).
5. /associate with place: prompt has the extract, cache key differs; without place byte-identical to today (pytest).
6. Place extract over cap -> 400 (pytest).
7. `scripts/check.sh` rc=0; fixtures regenerated in a separate commit.

Tests: static/place.test.mjs, tests/test_place_api.py, tests/test_associate_place.py
