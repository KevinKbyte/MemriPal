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

## MEM-026 Chat provider toggle

ADR [0023](../../../../docs/decisions/0023-chat-provider-adapter-reuses-meta-client.md). Plan D12 (ADR 0006).
`src/memripal/chat_provider.py`, `backend.py`, `meta_client.py`, `scripts/run_live.ps1`.
- Env MEMRIPAL_CHAT_PROVIDER = "meta" (default) | "baseten" | "fireworks" | "local", exact match; other ->
  ValueError naming the env var and the allowed set (`CHAT_PROVIDERS`).
- Wiring: read only in `select_backend("meta")`; fixture mode never reads it or any provider var. "meta" -> Spark
  chat on Meta, unchanged. Only Spark chat (`spark_json`) routes to the provider; segment calls stay on Meta;
  META_API_KEY always required.
- `ChatProvider(name, client, model)`, client = `MetaClient` at the provider's base URL:
  - baseten: `https://inference.baseten.co/v1`, model `meta-models/muse-spark-open-1026`, key BASETEN_API_KEY.
  - fireworks: `https://api.fireworks.ai/inference/v1`, model `accounts/fireworks/models/muse-spark-open` (full
    path required), key FIREWORKS_API_KEY.
  - Keyed provider with its key unset or empty -> `MissingApiKey` at startup.
  - local: MEMRIPAL_LOCAL_CHAT_URL (unset or empty -> `http://localhost:11434/v1`; trailing slash stripped);
    MEMRIPAL_LOCAL_CHAT_MODEL required (unset or empty -> ValueError at startup); `MetaClient(None, ...)` sends no
    Authorization header. `MetaClient("")` still raises `MissingApiKey`.
- Payload identical to Meta's (`max_completion_tokens`, strict `json_schema`), with the provider's model id. Live
  compatibility of that shape with Baseten / Fireworks / local is UNVERIFIED (open); plain chat connectivity to all
  three verified 2026-10-27.
- Cache key: `dataclasses.replace(req, model=<provider> + "/" + <provider model>).cache_key()` (e.g.
  `local/llama3.2`), the ADR 0018 `modal/` convention: never stored or replayed as a Meta entry; two local models
  never share an entry.
- No provider key in the backend repr/str, nor in a failed chat call's logs or error.
- run_live.ps1: MEMRIPAL_CHAT_PROVIDER baseten | fireworks (case-sensitive) also decrypts
  `$HOME/.secrets/<provider>-api-key.dpapi` into the child's BASETEN_API_KEY / FIREWORKS_API_KEY beside
  META_API_KEY; file missing -> stderr names it, exit 2, child never launched. Unset, meta and local load only the
  Meta key. Keys never printed.

Tests: tests/test_chat_provider.py, tests/test_chat_provider_wiring.py, tests/test_run_live.py

## MEM-027 Scene rendering (scenes.py)

ADR [0007](../../../../docs/decisions/0007-scene-render-tiers.md),
[0024](../../../../docs/decisions/0024-scene-render-contract.md). Plan S4. `src/memripal/scenes.py`, `backend.py`,
`meta_client.py`.
- `SCENE_PROMPT`: fixed PG ("family-friendly (PG)") template with fields ITEM, LOCUS, SPATIAL, VISUAL, DETAILS.
  `scene_prompt(record)` fills them from item, locus, spatial, visual, scene_prompt_details, each collapsed to one
  line (`" ".join(text.split())`): injected new lines add or alter no framing line; braces in field text stay literal.
- `MAX_CONCURRENT_SCENES` = 3: one module-level `threading.BoundedSemaphore` around `backend.call`, so the cap holds
  across threads (10 concurrent scenes peak at exactly 3 in flight). The slot wait has no timeout.
- `render_scene(backend, processed, box, record) -> Scene(tier, image, reason)` (frozen). Exactly one
  `backend.call(ModelRequest(method="image_edit", image_jpeg=processed.jpeg, subject="scene", attempt=0,
  model="muse-image-1.0", prompt_template_id="scene", gen_params={PROMPT_ARGS: {"record": record}}, schema=None))`;
  never retried, never raises. `box` is not sent (whole-photo edit, client zooms the overlay). Distinct records ->
  distinct cache keys.
- Tier 1: reply must be non-empty bytes <= `imaging.MAX_UPLOAD_BYTES` with PNG/JPEG/WEBP magic, header within
  `MAX_SIDE` / `MAX_PIXELS` (checked before decode); then RGB, LANCZOS-resized to (processed.width,
  processed.height), always re-encoded JPEG at `imaging.JPEG_QUALITY` (90); reason None.
- Tier 3: image None, reason one of `fixture_missing` (FixtureMissing), `upstream` (BackendCallFailed: read timeout,
  content-policy 400, malformed reply), `timeout` (TimeoutError), `internal` (any other exception), or a hostile-reply
  code `not_bytes`, `empty`, `too_large`, `bad_magic`, `decode_error`, `pixel_bomb`. No model or exception text in
  the reason; the warning log carries only the code (plus the exception type name for `internal`).
- MetaBackend `image_edit`: `MetaClient.image_edit(image_data_url=<processed JPEG data URL>,
  prompt=scene_prompt(record), model=req.model, timeout=backend.IMAGE_EDIT_TIMEOUT_S)` -> one POST /images/edits with
  a 30 s per-request read timeout. `MetaClient.image_edit(timeout=None)` keeps the client default (kwarg omitted:
  httpx reads None as no timeout). ReadTimeout is never retried (MetaClient retries pre-send connect errors only).
  Value = base64-decoded `data[0].b64_json`; non-JSON, no data, undecodable base64, empty bytes, or a body over
  `meta_client.MAX_RESPONSE_BYTES` -> BackendCallFailed, uncached.
- Write-through: with `cache_root`, any non-empty reply bytes are stored raw under the request key (photo first);
  FixtureBackend on that root replays them as bytes -> the same tier-1 scene offline. The timeout is not in the key.

Tests: tests/test_scenes.py, tests/test_scenes_live.py

## MEM-028 POST /scenes

ADR [0024](../../../../docs/decisions/0024-scene-render-contract.md). Plan S4. `src/memripal/app.py`, MEM-021
idiom; checks in this order, all before any model call:
- Content-Type not application/json -> 415 {"error": "unsupported_media_type"}; Content-Length or streamed body past
  `SCENES_BODY_CAP` (max-size photo as a data URL + `6 * MAX_FIELD_CHARS * len(FIELDS)` + 64 KiB) -> 413
  {"error": "too_large"}; malformed Content-Length -> 400 "bad_content_length".
- Body exactly {"image": str, "box", "record"}; malformed JSON, non-object, missing or unknown key, non-string image
  -> 400 {"error": "bad_request"}.
- Record, before the photo is decoded: an object whose str item and locus pass `check_inputs` (item <= 100 chars)
  and which passes `validate_association(record, item, locus)` (MEM-021), else 400 {"error": "bad_record"}.
- Image: no `data:image/jpeg;base64,` prefix -> 400 "bad_data_url"; invalid base64 -> 400 "bad_base64"; bytes
  checked by `validate_processed`, never re-encoded (replay keys hold): ImageRejected -> its status + code.
- Box: exactly {"x1", "y1", "x2", "y2"} ints (bools refused) with 0 <= x1 < x2 <= width and 0 <= y1 < y2 <= height
  of the processed photo, else 400 {"error": "bad_box"}.
- Then `render_scene` (MEM-027) in the threadpool. Tier 1 -> 200 exactly {"tier": 1, "image":
  "data:image/jpeg;base64,...", "width", "height"} (processed photo dims). Tier 3 -> 200 exactly {"tier": 3,
  "reason": <code>}, fixture miss and upstream failure included (never 404/502/500, unlike /associate).
- Error bodies only {"error": code}, no model or input text. Host guard applies.
- Fixture mode: a recorded scene replays offline (no network); a record never recorded -> tier 3.

Tests: tests/test_scenes_api.py
