# MemriPal spec (continuation)

Continuation of [spec.md](spec.md), which is at its 500-line cap. Continued in [spec-3.md](spec-3.md) (MEM-041 onward).

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
  across threads (10 concurrent scenes peak at exactly 3 in flight). The slot wait is bounded by `SLOT_WAIT_S` = 10 s;
  no slot by then -> tier 3 `busy`, no model call. The slot is released on every path.
- `render_scene(backend, processed, box, record) -> Scene(tier, image, reason)` (frozen). Exactly one
  `backend.call(ModelRequest(method="image_edit", image_jpeg=processed.jpeg, subject="scene", attempt=0,
  model="muse-image-1.0", prompt_template_id="scene", gen_params={PROMPT_ARGS: {"record": record}}, schema=None))`;
  never retried, never raises. `box` is not sent (whole-photo edit, client zooms the overlay). Distinct records ->
  distinct cache keys.
- Tier 1: reply must be non-empty bytes <= `imaging.MAX_UPLOAD_BYTES` with PNG/JPEG/WEBP magic, header within
  `MAX_SIDE` / `MAX_PIXELS` (checked before decode); then RGB, LANCZOS-resized to (processed.width,
  processed.height), always re-encoded JPEG at `imaging.JPEG_QUALITY` (90); reason None.
- Tier 3: image None, reason one of `busy` (slot wait expired), `fixture_missing` (FixtureMissing), `upstream`
  (BackendCallFailed: content-policy 400, malformed reply), `timeout` (TimeoutError, checked first: a live read
  timeout is a BackendTimeout, both), `internal` (any other exception), or a hostile-reply
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
- Live mode: passcode-gated (MEM-034) once merged with the S7 gate.

Tests: tests/test_scenes_api.py

## MEM-029 Scene panel (client)

ADR [0024](../../../../docs/decisions/0024-scene-render-contract.md). Plan S5. `static/scenes.js`, `static/index.html`
(`#scenes`, `#scene-overlay` hidden). Wired via `runEncode` (MEM-030).
- `runScenes(cards, {doc, fetch, image})`, card = `{item, locus: {n, label, box}, entry: {record, status} | null}` ->
  one result per card, null = skipped. Eligible = entry status "valid" and a locus box; others send nothing. No
  image -> no request, no throw. One POST /scenes (MEM-028) per eligible card, body exactly `{image, box, record}`.
- `MAX_SCENES_IN_FLIGHT` = 3 (= server `MAX_CONCURRENT_SCENES`): never more than 3 requests in flight; panel order
  follows the cards whatever the answer order. Each card: `<h3>` "<n>. <item> at <label>", then the scene slot.
- `isSafeImageSrc(v)`: only `data:image/(png|jpeg|webp);base64,` or `blob:` strings; script, SVG, HTML, remote and
  non-string refused. Unsafe tier-1 image -> no `<img>`, "Scene unavailable: bad_image".
- Tier 1 -> `<img>` of the whole edited photo zoomed to the box: `zoomFor(box, width, height)` -> `{scale, tx, ty}`
  (scale >= 1, 0.8 margin, box fully in frame, photo always covers the frame; full-image or invalid box ->
  identity). Click -> full-size image in `#scene-overlay`; click on it or Escape closes it.
- Failure -> "Scene unavailable: <code>": tier-3 reason; non-2xx -> its `error` code else `http_<status>`; network
  error `network`; other reply shape `bad_response`. Code `fixture_missing` (demo server, no recorded scene)
  instead shows "Scene unavailable: no demo scene for this". Fallback cards never open the overlay.
- Item, label and reason via textContent only; no HTML-string sinks in `scenes.js`.

Tests: static/scenes.test.mjs, static/app_flow.test.mjs

## MEM-030 Encode UI: route review, walk view

Plan S5 (D13, D19). `static/encode.js`, `static/palace_store.js`, `static/style.css`, `static/index.html`. Wired
by `static/flow.js` `wireApp`: `#load-demo` runs `runDemoPalace`; `app.js` backs the palace store with
`selectStore` (MEM-033).
- `createRouteReview(loci)` (input never mutated): `move(i, +-1)` swaps neighbours, refused past either end, clears a
  pending drop; `requestDrop(i)` only marks; `confirmDrop()` removes; `cancelDrop()`; `undo()` restores the newest
  drop at its index (stack); `canUndo()`.
- Page review (`#route-review`, `#route`): per locus Up / Down (disabled at the ends) / Drop; Drop shows "Drop this
  place?" + Confirm drop / Cancel; `#route-undo` shown while a drop can be undone. Nothing generated until
  `#generate`; a dropped locus is never generated for.
- `runEncode({image, loci, points, auto}, {doc, fetch, store})`: review (skipped when `auto`, D19: zero clicks) ->
  `store.saveRoute(order)` -> pairs = order[i] with points[i] -> `runAssociations` (MEM-022, resume reuses valid
  records) -> `runScenes` (MEM-029) -> walk view at step 1.
- Walk view (`#walk`): "Step <k> of <n>", "<item> at <label>", the scene (`sceneView`), the 8 channels in
  `KAVE_CHANNELS` order, question, answer; non-valid record adds "Needs regeneration"; no record -> "Could not
  generate this association". Prev disabled at step 1, Next at the last.
- `runDemoPalace({auto}, deps)`: demo photo -> /loci (same bytes) -> /demo/notes.txt -> /split (notes mode, plain
  base64) -> `runEncode`; a failed step writes `#upload-status` ("Demo failed: <code>") and stops; never throws.
- Kev decision Q24(ii), keep: non-auto `#load-demo` stays disabled until `#generate` (`flow.js` line 359
  holds it across `runDemoPalace`): `reviewRoute` assigns the route only on Generate (`static/encode.js`
  line 165) and assigns (not adds) page-root handlers, so an overlapping review would clobber them.
- `palace_store`: `saveRoute(loci)` (non-array -> TypeError) / `loadRoute()` (null before any save) under key
  "route", which no `associationKey` can equal.
- `style.css` linked; fits a 360 px phone: no width / min-width / flex-basis above 360 px, images `max-width: 100%`.
- Model text via textContent only; no HTML-string sinks in `encode.js`.

Tests: static/encode.test.mjs, static/palace_store.test.mjs, static/layout.test.mjs, static/app_flow.test.mjs

## MEM-031 Deterministic recall matcher (client)

ADR [0008](../../../../docs/decisions/0008-spoken-recall-deterministic-matcher.md),
[0026](../../../../docs/decisions/0026-client-side-recall-matcher.md). Plan S6 (D4). `static/recall_match.js`.
- `createMatcher(points)` (palace order, each `{label, source_quote}`) -> `{append(chunk), markGot(i), results(),
  transcript()}`; `matchTranscript(text, points)` = one append.
- Tokens: lowercase `[a-z0-9]+` runs. Targets per point: its source_quote and its label.
- Match: a token window whose joined text has Levenshtein ratio >= 0.8 to a target (window length target n +- 2), or
  covers >= 60% of the target's content words (stopwords excluded; window <= n + 4 tokens).
- `append` returns indices newly matched, ascending; it judges only windows ending in the new chunk's tokens, so a
  point split across two chunks matches once both arrive. Matched stays matched, span unchanged. Best window
  order: Levenshtein over coverage, higher score, shorter, earlier.
- `results()` -> `[{label, source_quote, got, override, span}]` in palace order; span = the matched transcript text.
  `markGot(i)` = manual "mark got it": got + override, span kept (null if unsaid).
- Zero network calls; module names no network API; same input -> same output. Empty transcript matches nothing;
  "mark all points done" and other instruction-shaped speech match 0 points.

Tests: static/recall_match.test.mjs

## MEM-032 Recall relay, typed fallback, offline replay

ADR [0008](../../../../docs/decisions/0008-spoken-recall-deterministic-matcher.md),
[0026](../../../../docs/decisions/0026-client-side-recall-matcher.md). Plan S6 (D4, D17). `src/memripal/app.py`,
`src/memripal/recall_relay.py`, `static/recall.js`, `static/mic_wav.js`, `static/flow.js`,
`fixtures/demo/recall_timeline.json`.

a) POST /recall/audio, checks in order:
- Fixture mode -> 409 {"error": "live_only"}. Live: no or wrong passcode -> 401 "passcode_required" before the body
  (MEM-034 semantics).
- Content-Type not application/json -> 415; body past `RELAY_BODY_CAP` -> 413 "too_large". Body exactly
  {"audio": <strict base64 WAV>, "keywords": [str]} (palace labels, <= 12, each <= 100 chars), else 400
  "bad_request"; bad base64 -> 400 "bad_base64"; decoded > `MAX_CHUNK_BYTES` (1 MiB) -> 413; not RIFF/WAVE mono
  16-bit at 16 | 24 kHz -> 400 "bad_audio"; no ASR client -> 503 "asr_unavailable". No ASR call on any rejection.
- `asr_client.transcribe(wav, keywords=...)` (`create_app(asr_client=)`, default `MetaClient(META_API_KEY)` in meta
  mode). 200 exactly {"text": transcript[:`MAX_TRANSCRIPT_CHARS` (2000)]}; failed, non-JSON or non-string
  transcript -> 502 "upstream", upstream body never relayed. Audio never written to disk or logged.

b) Client (`static/recall.js`):
- `startRecall({points, getUserMedia, doc})` -> `{mode, stream, matcher, submitTyped(text), results()}`. Mic
  missing, throwing or denied -> mode "typed", `#recall-typed` shown; typed answers use the same matcher. Never
  constructs `SpeechRecognition` (D17).
- `static/mic_wav.js`: `recordClip({stream, AudioContext, maxMs})` -> `{stop()}` resolving one 16 kHz mono 16-bit WAV
  (box-average downsample, at most maxMs kept; sliced `take()`: see MEM-037). `postRecallAudio({fetch, wav, keywords, passcode})` -> `{text}`, else
  `RecallAudioError(code)`: 401/409/413/429/502 -> `passcode_required`/`live_only`/`too_large`/`budget_exhausted`/
  `upstream`, other status `unexpected`, fetch throws `network`, reply without string text `upstream`.
- Page (`static/flow.js` `wireApp`): `#recall-start` asks for the mic only on that click and records up to
  `MAX_RECALL_MS` (3 min); no AudioContext -> mic released, typed box. `#recall-submit` (Done) stops and releases the
  mic, re-splits the WAV under `MAX_CHUNK_BYTES`, posts each chunk (keywords = point labels, passcode via
  `withPasscode`), appends each transcript to the matcher, saves the rehearsal. A `RecallAudioError` keeps the run
  open typed, with "Speech relay failed (<code>)". `#recall-replay` replays `/demo/recall.json`, results labelled
  `REPLAY_LABEL`.
- Kev decision Q24(iii), empty Done: the guard (`static/flow.js` line 455, in `recall-submit` from line 419)
  keys on "no WAV", so a spoken run that fell back typed after a relay failure (`fallBackTyped`) with points
  already got saves nothing. Narrowed: skip saving ONLY when the typed box is empty AND no result is got
  (`!typed.trim() && !current.results().some((r) => r.got)`), else save. Empty plain-typed run, nothing
  got -> still no save, prompt shown (app_ux_done_guard tests); spoken-empty path untouched; 102c relay
  failure message stays visible.
- `replayRecording(timeline, matcher, {wait})`: appends each chunk in order after waiting its `t_ms` gap; resolves
  to `matcher.results()`; no network. Optional `onMatch(indices)` per chunk (live board: see MEM-037).

c) GET /demo/recall.json: `fixtures/demo/recall_timeline.json` (generated by `make_synthetic_fixtures.py`) as JSON
{"label": "replay of a recorded session" (`REPLAY_LABEL`), "chunks": [{"t_ms", "text"}]}, t_ms non-decreasing; the
demo replay gets >= 1 point and misses >= 1. Missing -> 404 "demo_missing".

Tests: tests/test_recall_audio.py, static/recall.test.mjs, static/mic_wav.test.mjs, static/app_spoken.test.mjs,
static/app_flow.test.mjs

## MEM-033 Stored rehearsals

Plan S6 (D18). `static/rehearsals.js`, `static/idb_adapter.js`, `static/flow.js`, `static/palace_store.js`.
- Storage: `app.js` builds the rehearsal and palace stores on `selectStore(globalThis, {dbName, storeName, prefix})`
  (`flow.js`): `createIdbAdapter` when `indexedDB` exists, else `localStorageAdapter(prefix)` (localStorage read
  lazily). Distinct databases `memripal-rehearsals` / `memripal-palace`: the adapter creates its object store only on
  a database's first open. A write resolves on transaction complete. Records already in localStorage migrate
  once (MEM-039).
- Page: history for palace id "demo", one row per run "<timestamp>: <got>/<n> recalled" + Delete (confirm "Delete
  this rehearsal?", then `#rehearsal-undo`); `#hit-rates` rows "<label>: <hits>/<runs>", " (chronic miss)" appended.
  History rows + hit rates render on start with no Load demo when >= 1 run is stored (order = `list()`, oldest
  first); 0 runs -> the history stays hidden. Each row has a "View" button showing that run's said-vs-palace from
  the stored record (no request).
- `createRehearsalStore(adapter, {now, newId})`, adapter = async `{get, put, delete, list}`. `save(palaceId, {transcript,
  results})` -> record `{id, palace_id, timestamp (ISO), transcript, points}`, stored as a JSON string; points
  whitelist `{label, source_quote, got, override, span}`, so no audio or other field is stored. `get(id)` (unknown
  -> null), `list(palaceId)` (that palace only, oldest first), `delete(id)`, `restore(record)`. Survives a reload.
- `hitRates(records)` -> `[{label, hits, runs, rate, chronic}]` in first-seen order; an override counts as a hit;
  chronic = runs >= 2 and rate < 0.5 (0.5 is not chronic; one missed run is not chronic).
- `renderSaidVsPalace(record, doc)` -> `<ol class="said-vs-palace">`, one row per point in palace order: label, what
  was said (span, "marked got it", or "not said"), source quote; textContent only.
- End-screen override: each missed row has one `<button data-action="mark-got">` "Mark got it"; got rows have none.
  Click -> that point becomes `{got: true, override: true, span: null}` in the saved record (same id, timestamp,
  transcript; other points unchanged), the row shows "marked got it" without the button, and history + hit rates
  re-render. Survives a reload.
- `deleteRehearsalWithUndo(id, {store, confirm, showUndo})`: unknown id or declined confirm -> nothing deleted, no
  Undo; accepted -> deleted, `showUndo(undo)` where undo restores the identical record (also after a reload).

Tests: static/rehearsals.test.mjs, static/idb_adapter.test.mjs, static/palace_store.test.mjs,
static/app_spoken.test.mjs, static/app_flow.test.mjs, static/app_recall_override.test.mjs

## MEM-034 Deploy guards + Cloud Run artifacts

ADR [0004](../../../../docs/decisions/0004-public-deploy-spend-guard.md),
[0010](../../../../docs/decisions/0010-cloud-run-hosting.md),
[0025](../../../../docs/decisions/0025-passcode-gate-and-host-allowlist.md). Plan S7 (D1). `src/memripal/app.py`,
`Dockerfile`, `.dockerignore`, `.gcloudignore`, `scripts/deploy_cloud_run.sh`. Env read once at `create_app`:
- MEMRIPAL_ALLOWED_HOSTS: comma list, blanks dropped, appended to `ALLOWED_HOSTS` (MEM-015 host guard, which runs
  before every other check); unlisted non-loopback host -> 400.
- MEMRIPAL_PASSCODE: stripped (Secret Manager trailing newline); blank = unset. Live mode only (`backend.mode !=
  "fixture"`), every model route (/loci, /split, /associate, /scenes, /recall/audio) before the body is read: header
  `X-Memripal-Passcode` matches (`hmac.compare_digest`) -> pass, else 401 {"error": "passcode_required"}. Unset:
  loopback host passes (`run_live.ps1`), any other host 401 (fail closed). Fixture mode, /healthz, / and /demo/* are
  never gated.
- MEMRIPAL_CALL_BUDGET: per-instance cap on live `backend.call`; past it the call never reaches the backend -> 429
  {"error": "budget_exhausted"}. Shared across routes; 0 refuses every live call; fixture calls and 401s never
  count. Non-integer or negative -> ValueError at startup.
- MEMRIPAL_MAX_BODY_BYTES: app-wide cap ahead of route caps; declared or streamed body past it -> 413 "too_large".
  Non-integer or < 1 -> ValueError.
- Dockerfile: python:3.13-slim, `uv sync --frozen --no-dev`, copies only src, static, fixtures; non-root user;
  `MEMRIPAL_MODE=fixture`, never meta; no secret-named ENV/ARG; uvicorn on 0.0.0.0:`$PORT` (default 8080).
  `.dockerignore` excludes .git, venvs, .env*, .secrets, *.dpapi, refs, fixtures/raw, docs, tests, scripts, node
  tests; `.gcloudignore` includes it plus `.gitignore`.
- `scripts/deploy_cloud_run.sh` (env GCP_PROJECT, REGION us-central1, SERVICE memripal, EXTRA_HOSTS): `gcloud run
  deploy --source . --max-instances=1 --allow-unauthenticated`, env MEMRIPAL_MODE=fixture, MEMRIPAL_CALL_BUDGET=300,
  MEMRIPAL_MAX_BODY_BYTES=21233664 (= the largest route cap, /split), MEMRIPAL_ALLOWED_HOSTS = the deterministic
  `<service>-<project number>.<region>.run.app` host (+ EXTRA_HOSTS); secrets only via `--set-secrets`
  (MEMRIPAL_PASSCODE from secret memripal-passcode, META_API_KEY from meta-api-key); never reads a secret value.

Tests: tests/test_deploy_guards.py, tests/test_deploy_artifacts.py

## MEM-035 Web manifest + public banner

Plan S7 (D13). `static/manifest.webmanifest`, `static/icon.svg`, `static/public_banner.js`, `static/index.html`,
`static/app.js`.
- `index.html` links `/static/manifest.webmanifest` (served as JSON): name MemriPal, `start_url` and `scope` "/",
  `display` standalone, icon `/static/icon.svg` (served). No service worker anywhere in the frontend (D13).
- `#public-banner` "live needs passcode / try Load demo", hidden by default. `showPublicBanner(doc, hostname)`
  unhides it when `isPublicHost(hostname)`: not localhost, 127.0.0.1, ::1, [::1] or "" (case-insensitive). `app.js`
  calls it on load.

Tests: tests/test_deploy_web.py, static/app_public_banner.test.mjs

## MEM-036 Signed association records (security F3)

ADR 0027. Plan S7 prerequisite: without it a passcode holder can send any record text to image edit on Kev's key.
`src/memripal/app.py`, client flow modules. Both modes (fixture and live).
- Key: MEMRIPAL_RECORD_KEY read once at `create_app`, stripped, blank = unset; unset -> 32 random bytes per app
  (records signed before a restart stop verifying). Never logged or returned.
- `/associate` 200 with a record adds `"sig"`: lowercase hex HMAC-SHA256(key, canonical(record)), canonical =
  `json.dumps(record, sort_keys=True, separators=(",", ":"), ensure_ascii=True)`.
- `/scenes` body is exactly {image, box, record, sig} (other key sets -> 400 "bad_request"); `sig` not a str, or
  not equal (`hmac.compare_digest`) to the record's HMAC -> 403 {"error": "bad_signature"}, before record caps,
  photo decode or any model call.
- Caps: record `spatial`, `visual`, `scene_prompt_details` each <= 300 chars; over -> /scenes 400 "bad_record"; the
  /associate validator refuses the same records, so every signed record passes /scenes caps.
- Client: stores `sig` beside its record and sends it in every /scenes body; a stored record without `sig` (saved
  before this change) makes no /scenes request and shows the tier-3 fallback.

Tests: tests/test_record_sign.py, static/app_record_sign.test.mjs

## MEM-037 Live recall lighting

Plan item 65 (Kev: "sure live point lighting"). Points light while Kev speaks: 5 s ASR slices with 1 s overlap
through the unchanged MEM-032 relay, not streaming. `static/mic_wav.js`, `static/recall_live.js`, `static/recall.js`,
`static/flow.js`, `static/index.html`. Server unchanged; <= 37 ASR calls per 3-min run (36 slices + the Done
remainder; MEMRIPAL_CALL_BUDGET, Q17).
- `recordClip(...)` gains `take()` -> Promise<Uint8Array | null>: 16 kHz mono WAV of the samples since the previous
  take's mark, starting `LIVE_OVERLAP_MS` (1000) before that mark (clamped at 0); null when no new sample since the
  mark. `stop()` returns the untaken remainder with the same overlap, or null when a take() ran and nothing is new
  since it. Without take() calls, `stop()` is unchanged (the whole clip, empty WAV if no frames). take() after
  stop() -> null.
- `renderLiveBoard(points, doc, {label})` -> `{el, light(indices)}`: `el` holds `p.live-badge` (label, "LIVE" or
  "recorded replay") and `ol.live-board`, one `li` per point in palace order (label text, textContent only).
  `light(indices)` adds class "lit" and `data-state="got"`; unknown indices ignored; idempotent.
- `createLiveRelay({clip, post, matcher, onMatch, onFail, every = LIVE_SLICE_MS (5000), setInterval,
  clearInterval})` -> `{stop()}`. Each tick: skip if a post is in flight; else `take()`; null -> no post; else
  `post(wav)` -> `onMatch(matcher.append(text))`. Any post rejection (a `RecallAudioError` or other error) clears
  the interval, calls `onFail(err)` once, no further posts; the page shows `err.code`, else "unexpected". `stop()`
  clears the interval and awaits any in-flight post; it never rejects (that post's failure goes to onFail);
  idempotent.
- Page: `#recall-start` with mic + AudioContext renders the board ("LIVE") into `<div id="recall-live">` in `#recall`
  and starts the relay (post = `postRecallAudio`, keywords = point labels, passcode via `withPasscode`). Live
  failure = Done failure: clip stopped, mic released, typed fallback, "Speech relay failed (<code>)"; lit points stay
  lit. Done: `await relay.stop()`, post the `stop()` remainder (chunked under `MAX_CHUNK_BYTES`), light matches,
  end the run as today. `#recall-replay`: board labelled "recorded replay", each chunk's matches light as it plays.
  Typed mode: no board.

Tests: static/recall_live.test.mjs, static/mic_wav_take.test.mjs, static/app_live.test.mjs

## MEM-038 UI asset generator

Kev-approved generic style, restyled once design mockups land. `scripts/gen_assets.py`, run by Kev with his own key
(`scripts/run_live.ps1 uv run python scripts/gen_assets.py`); Claude never reads the key. Never run by the app
or the Dockerfile (`.dockerignore` excludes scripts).
- `MetaClient` has no text-to-image (chat_json, segment, image_edit, transcribe), so each asset is one
  `image_edit(image_data_url=..., prompt=...)` on a generated base: Pillow (already a dependency) 1024x1024 white RGB
  canvas -> JPEG -> `to_data_url`. No `size` sent (no caller sends one; valid values unverified). Output =
  `image_bytes(body)` (WebP).
- `ASSETS` (fixed, 2 entries, list order = call order), written under `static/assets/` (served at `/static/assets/`
  by the existing `/static` mount, shipped by the Dockerfile's static copy); `--out <dir>` overrides. `icon` ->
  `icon-512.png` + `icon-192.png` (Pillow center-crop to square, LANCZOS resize, both from the one call);
  `empty-state` -> `empty-state.webp` (returned bytes as is).
- Prompts are module constants: a per-asset subject (icon: house outline with three gold dots; empty-state: open
  doorway into a room with numbered spots on the floor) + shared `STYLE` ("flat 2D vector illustration, navy
  #1f3a5f and gold #f2b134 on plain white, no text"; colors from `icon.svg` / `theme_color`). Restyle = edit the
  constants and re-run.
- Writes files only; never edits `manifest.webmanifest`, `index.html` or `style.css`. Wiring the outputs in (PNG
  icon entries beside `icon.svg`, an empty-state `<img>`) is a separate change after Kev commits them:
  `tests/test_deploy_web.py` requires every manifest icon to be served.
- Key: `META_API_KEY` from the environment only (as `app.py`, `backend.py`, `probe_live.py`); never a file, never
  printed (`MetaClient` redacts it from errors). Unset or blank -> stderr "META_API_KEY is not set; launch via
  scripts/run_live.ps1", exit 2, before any call or write.
- `--dry-run`: one line per asset (name, output paths) then "calls: 2"; no key needed, no client built, no file
  written, exit 0.
- Budget: exactly one `image_edit` per asset (never retried: `max_retries=0`), so a full run = 2 paid calls, no other
  API call.
- Failure: a non-ok `CallResult` (non-2xx, transport, response_too_large) or a body Pillow cannot decode -> stderr
  "<name>: failed (<CallResult.error, else bad_image>)", that asset's existing files untouched, the next asset still
  runs; exit 1 if any asset failed, else 0. Each written path is printed.
- `main(argv, make_client=MetaClient)`: tests pass a fake factory returning canned `CallResult`s, sockets blocked
  (no network).

Tests: tests/test_gen_assets.py

## MEM-039 localStorage -> IndexedDB migration + replay fetch failure

Kev chose copy-then-clear. Closes two gaps: MEM-033 records stored in localStorage before IndexedDB stayed invisible,
and a `/demo/recall.json` failure in `#recall-replay` (`flow.js`) was unhandled. `static/storage_migrate.js`,
`static/app.js`, `static/flow.js`. Out of scope: `localStorageAdapter.list()` order (unsorted;
`createRehearsalStore.list` sorts).
- `migrateLocalStorage(getStorage, prefix, adapter)` -> Promise<{copied, skipped, cleared}>, never rejects. `app.js`
  runs it on page load only when `globalThis.indexedDB` exists (the `selectStore` test), once per store on that
  store's own adapter: `memripal.palace:` -> memripal-palace/palace, `memripal.rehearsal:` ->
  memripal-rehearsals/rehearsals; awaited before `wireApp` (which renders history on start). No other localStorage
  key is touched (`memripal.placeHistory`, MEM-025, stays).
- Copy: snapshot the prefixed keys first; per key, `JSON.parse` the value (the `localStorageAdapter` encoding), key
  = name minus prefix. `adapter.get(key)` !== undefined -> already in IndexedDB: it wins, nothing written (no
  duplicate, no overwrite). Else `adapter.put(key, value)` with exactly what the localStorage adapter's `get` returned
  (rehearsal: its JSON string; palace: the entry or route array).
- Malformed JSON: that key is skipped and kept in localStorage (never copied, never removed); it does not block the
  other keys.
- Clear: only after every get/put for that prefix resolved (put = transaction complete), remove that prefix's
  copied and already-present keys. Any get/put rejection (IndexedDB open or write failure) -> remove nothing for
  that prefix; the next load retries. localStorage unreadable (disabled storage throws) -> no-op. No IndexedDB ->
  not run; the MEM-033 localStorage fallback keeps serving the keys. Page wiring runs whatever the outcome.
- Idempotent: a second load finds no prefixed keys (or only kept malformed ones) -> no put, no remove.
- `#recall-replay` fetch failure -> one line in `#recall-results` (textContent); no board, no replay, no rehearsal
  saved. Fetch rejects with TypeError -> "Replay failed: network"; non-2xx -> "Replay failed: <code>", code = JSON
  body `error` string else `http_<status>` (the `encode.js` `errorCode` rule; missing fixture -> "Replay failed:
  demo_missing"); 2xx body not JSON or `chunks` not an array -> "Replay failed: bad_response"; any other error ->
  "Replay failed: unexpected error". Mirrors Load demo's "Demo failed: <code>".

Tests: static/storage_migrate.test.mjs, static/app_flow_replay.test.mjs

## MEM-040 Wire generated assets into the page

The separate wiring change MEM-038 defers. Assets committed at 2e2cf96 under `static/assets/` (MEM-038 run):
`icon-192.png` (192x192), `icon-512.png` (512x512), `empty-state.webp`. `static/manifest.webmanifest`,
`static/index.html`, `static/style.css`. No new deps, no JS module beyond the existing static files, ASCII only.
- Manifest `icons`: the existing `icon.svg` entry stays first; then append `{"src": "/static/assets/icon-192.png",
  "sizes": "192x192", "type": "image/png", "purpose": "any"}` and the same for `icon-512.png` / `"512x512"`. Each
  PNG's real pixel size equals its `sizes`; every icon is served (`tests/test_deploy_web.py` rule, unchanged).
- `index.html`: one decorative `<img id="empty-state" src="/static/assets/empty-state.webp" alt="">` directly
  before `#scene-wrap`. Nothing else in `index.html` changes (no new link tags). Superseded in part by MEM-044 P1:
  one stylesheet link `/static/theme-painterly.css`, last rel=stylesheet; MEM-044 A2 restyles the markup, ids and
  `hidden` kept.
- Visibility: shown on page load; gets the `hidden` attribute once a palace's places render in `#loci` (a photo
  upload or Load demo whose result is drawn), and stays hidden for the rest of the page session (a later failed
  upload does not bring it back).
- `style.css`: `#empty-state` is a centered block, `max-width: min(100%, 360px)`, `height: auto`.
  `#empty-state[hidden]` stays `display: none`: the existing global `[hidden] { display: none !important; }` rule
  must keep winning over the new explicit `display` (no `!important` on `#empty-state`).

Tests: tests/test_assets_wiring.py, static/app_empty_state.test.mjs
