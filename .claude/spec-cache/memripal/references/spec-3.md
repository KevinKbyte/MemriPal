# MemriPal spec (continuation)

Continuation of [spec-2.md](spec-2.md), which is at its 500-line cap.

## MEM-041 v6 Review prototype kept as a design reference

Source of the claude.ai "MemriPal Prototype" artifact (Version 7, https://claude.ai/artifact/RBvuQkU4vM3u7f5AhhdbKN)
committed under `docs/design/v6/`: `memripal-prototype.html`, `app.js`, `review.js`, `sched.js`, `tags.js`,
`styles.css`. Standalone design reference (v6: palace tags Talk/Exam/user tags, optional dates, Review sort/filter),
not served by the app; nothing under `static/` changes.
- Regression rule: `photo()` in `docs/design/v6/app.js` renders cropped place photos with
  `<use href="#room" width="800" height="560"></use>`. Without explicit width/height the room symbol sizes to the crop
  viewBox, so Review cards and Scenes tier-2 cards for off-origin places (e.g. Wedding toast clock, window, armchair,
  rug) render blank.
- The node test runs in `scripts/check.sh` alongside `static/*.test.mjs`.

Tests: docs/design/v6/tests/crop_use_size.test.mjs

## MEM-042 Palace backup export/import

ADR [0028](../../../../docs/decisions/0028-palace-backup-export-import.md) (supersedes the import/export rejection in
[0003](../../../../docs/decisions/0003-stateless-backend-client-state.md)). Palace data lives only in one browser's
storage. Stored state = palace-store entries `{record, status, sig?}` under `associationKey(item, locus)` plus the
route array under `ROUTE_KEY` "route" (`palace_store.js`), and rehearsals for palace id "demo" (`flow.js`
`DEMO_PALACE_ID`, the only palace). No photo or scene image is ever stored (`encode.js` `runEncode` re-requests every
scene on each Load demo; only Load demo runs it, so a custom-photo palace stores nothing). A backup restores rehearsal
history, cached associations and the route, never photos or scene images. New `static/palace_export.js`;
`static/index.html`, `static/flow.js`, `static/encode.js` (I7), `src/memripal/app.py` (C1); `app.js` untouched (line cap).
- E1 Export: a "Download backup" button writes `memripal-backup.json`: Blob URL on an `<a download>` with that fixed
  name, clicked, then `URL.revokeObjectURL`. Body `{v: 1, palace_id: "demo", route, associations, rehearsals}`: route =
  the stored route (`[]` when none); associations = every palace-store value except the route (`list()` returns values,
  not keys); rehearsals = `list("demo")`. Every object rebuilt from the I3/I4/route allow-lists: no image, no storage
  key. Beside the button, one textContent line: "The backup file contains your recall transcripts and place names."
  A store over an I1 cap -> error line, no file, so every exported file imports.
- I1 Caps, named in `palace_export.js`: `MAX_IMPORT_BYTES` = 1048576 (= `recall_relay.py` `MAX_CHUNK_BYTES`), checked
  on `file.size` before reading; `MAX_IMPORT_ASSOCIATIONS` = 500 and `MAX_IMPORT_REHEARSALS` = 1000 (entries
  accumulate per item + locus pair across runs, so not 12); route <= 12 loci (`loci.py` `max_loci`); points per
  rehearsal <= 12 (`split.py` `MAX_POINTS`).
- I2 Parse with `JSON.parse` only (no reviver). Top level must be an object with exactly {v, palace_id, route,
  associations, rehearsals}, `v === 1`, `palace_id === "demo"`, the other three arrays. An I1 or I2 failure rejects
  the whole file, nothing written; an I3, I4 or route failure skips that entry only.
- Route: each locus rebuilt with exactly {n, label, phrase, box {x1, y1, x2, y2}, outline [[x, y], ...]} (`app.py`
  `_locus_json`): n integer, label and phrase strings, coordinates finite numbers; any other key or type -> route
  skipped. No production code reads the route today (`loadRoute` is called only in tests).
- I3 Association entry: exactly {record, status} or {record, status, sig}. record has exactly the 15 `associate.py`
  `FIELDS` (item, locus, 8 channels, scene_prompt_details, walk_cue, reencode_hint, question, answer), all strings;
  item and locus non-blank, <= 100 chars trimmed (`MAX_ITEM_LEN`, `MAX_LOCUS_LEN`); spatial, visual,
  scene_prompt_details <= 300 (`MAX_SCENE_FIELD_CHARS`); every other field <= 2000 (`MAX_FIELD_CHARS`). Unknown key ->
  entry skipped, never stripped: stripping changes the canonical JSON `record_sign.py` signs. status "valid" or
  "invalid"; sig, when present, matches `/^[0-9a-f]{64}$/`. Key = `associationKey(record.item, record.locus)`, never
  read from the file. The server accepts an echoed item/locus equal after `normalize` only (`validate_association`),
  so an entry whose echo differs from the requested text lands under a different key and regenerates once.
- I4 Rehearsal: exactly {id, palace_id, timestamp, transcript, points}; id a lowercase UUID; palace_id "demo";
  timestamp a string with `new Date(t).toISOString() === t`; transcript a string; points an array (else rejected: a
  non-array crashes `history.js` `runItem`), each rebuilt by `pointOf` (`rehearsals.js`, exported for reuse); stored
  via `restore(record)`. Every object is built fresh key by key, so `__proto__` / `constructor` never reach the store.
- I5 Merge is additive: an existing entry wins (palace `get(key) !== undefined`, rehearsal `get(id) !== null`), an
  invalid entry is skipped (the `storage_migrate.js` rule); import never overwrites or deletes. Result is one
  textContent line "Imported <n>, skipped <m>"; a rejected file -> "Import failed: <reason>". History and hit rates
  re-render after import.
- I6 Imported strings reach the page only via textContent or attribute values (no innerHTML, insertAdjacentHTML or
  outerHTML in `static/`). Test: `<img src=x onerror=alert(1)>` in an imported transcript, point label and record
  field renders as literal text; no img element is created.
- I7 A sig verifies only under the issuing instance's `MEMRIPAL_RECORD_KEY` (ADR 0027). A /scenes 403
  `bad_signature` makes the client re-put that stored entry with status "invalid" (record kept), so the next run's
  `runAssociations` (regenerates any non-"valid" entry) fetches a fresh signed record. Applies to every stored entry,
  imported or not; without it a "valid" entry with a dead sig is reused every run and its scene stays tier 3.
- C1 Every response from `create_app` carries `Content-Security-Policy: default-src 'self'; img-src 'self' data:
  blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` and
  `X-Content-Type-Options: nosniff`; tested on `/` and `/static/app.js`. Nothing breaks: `index.html` has no inline
  script, style element, style attribute or handler attribute; all fetches are same-origin; scene srcs are data: or
  blob: (`isSafeImageSrc`); `scenes.js` sets `img.style` via CSSOM, which CSP does not block. FastAPI `/docs` and
  `/redoc` (CDN + inline script) stop rendering. App-wide XSS control, independent of import.
- R1 Round trip: export of an app-written store, imported into an empty store, gives equal associations (by key),
  route and rehearsals; importing the same file again -> "Imported 0, skipped <all>".

Tests: static/palace_export.test.mjs, static/app_scene_demote.test.mjs, tests/test_security_headers.py

## MEM-043 Generated hard rooms as E2E test fixtures

ADR [0029](../../../../docs/decisions/0029-generated-test-rooms-fixture-provenance.md). Generated rooms are TEST
FIXTURES ONLY: README.md sells "Photograph a familiar space", so no generated room is demo content, README art, video
footage or marketing. 3-5 hard rooms from Muse Image text-to-image, committed as bytes (the API has no seed), each
replayed offline in fixture mode after one live record. Starts after the core demo is green; dropped past about half
a day. A live probe on one real room photo stays the realism check. New: `MetaClient.image_generate`,
`scripts/gen_room_fixtures.py`, `scripts/promote_live_cache.py` (the promote step `backend.py` `_store` names),
`fixtures/rooms/`, `e2e_drive.py --room`. Changed: `app.py` `/demo/photo.jpg`, the Load demo fetch, `.dockerignore`,
`scripts/make_synthetic_fixtures.py` + `tests/test_fixtures_manifest.py` (M1), README script entries.
- T1 Testing only. `.dockerignore` excludes `fixtures/rooms` (`.gcloudignore` includes `.dockerignore`), so the Cloud
  Run image has no room file and `?room=` there -> 404 `room_missing`. No file under `static/` or `docs/submission/`
  and no README image references a room; README names rooms only in its script entries, as generated test fixtures.
  Accept: `tests/test_deploy_artifacts.py` asserts `fixtures/rooms/<id>.webp` is excluded; 0 room image refs in
  `static/`, `docs/submission/`, README.
- G1 `MetaClient.image_generate(*, prompt, model="muse-image-1.0", output_format="webp", timeout=None) ->
  CallResult`: POST `/images/generations` (`DEFAULT_BASE_URL` https://api.meta.ai/v1;
  https://dev.meta.ai/docs/api-reference/images/create-image), payload keys exactly {model, prompt, n: 1,
  output_format}. No `seed` or other key (unknown fields -> 400); no `size` (valid values unverified, as MEM-038).
  `retries=0` (paid, as `image_edit`). Bytes via the existing `image_bytes(body)` (`data[0].b64_json`). Accept: a fake
  transport sees 1 request to `/images/generations` with exactly 4 payload keys; a 5xx makes 0 retries.
- G2 `scripts/gen_room_fixtures.py`, run by Kev only: `scripts/run_live.ps1 uv run python
  scripts/gen_room_fixtures.py`; Claude never reads the key. MEM-038 shape: `main(argv, make_client=MetaClient)`,
  client `max_retries=0`; key from `META_API_KEY` only, unset or blank -> stderr "META_API_KEY is not set; launch via
  scripts/run_live.ps1", exit 2 before any call or write. `ROOMS` = fixed tuple of 3-5 `(room_id, subject)`, room_id
  `^[a-z0-9-]{1,32}$`, list order = call order. Output `fixtures/rooms/<room_id>.webp` = returned bytes unchanged; a
  body Pillow cannot decode, or carrying an EXIF marker (`precommit_scan.py` blocks it), fails that room, nothing
  written. A room whose file exists is skipped with no call: committed bytes are never regenerated. `--dry-run`: one
  line per room (id, path, "skip" when present) then "calls: <missing count>"; no key, no client, no write, exit 0.
  Failure: MEM-038 rule (stderr "<room_id>: failed (<CallResult.error, else bad_image>)", next room runs, exit 1).
  Accept: a fake-client full run makes <= 5 calls, a second run 0; unset key -> exit 2, 0 calls.
- G3 Prompts are module constants: per-room `subject` + shared `REALISM` suffix asking for a casual smartphone
  snapshot, not a clean render: tilted framing, wide-angle distortion, mixed light, blown-out windows, sensor grain,
  everyday clutter. Accept: every prompt = subject + REALISM; >= 1 room each is cluttered, dim, tilted.
- V1 Variants: pure offline `make_variants(base: bytes) -> dict[str, bytes]` (Pillow, deterministic: same input, same
  bytes). Never committed: two carry EXIF, which `precommit_scan.py` blocks; tests derive them into a temp dir from
  `fixtures/demo/photo.jpg` and from each committed room. Variants are intake tests only (no E2E, no live record).
  Expected `imaging.process_upload` outcome per variant:
  - `orientation`: pixels rotated 90 degrees + the EXIF Orientation tag that restores them -> accepted, processed size
    equals the base's processed size.
  - `gps`: fake EXIF GPS IFD -> accepted; the processed JPEG has no EXIF APP1 marker (strip test).
  - `heic`: ISO-BMFF `ftyp` box, brand `heic` -> 400 `bad_magic` (`sniff` knows jpeg/png/webp only); no `pillow-heif`
    dependency.
  - `oversize`: upscaled to long side 6000 (> `LONG_SIDE` 2048, within `MAX_SIDE`, `MAX_PIXELS`,
    `MAX_UPLOAD_BYTES`) -> accepted, processed long side 2048.
  - `heavy-jpeg`: JPEG quality 10 -> accepted.
  - `aspect`: center crop to 9:16 portrait -> accepted, processed aspect within 1% of 9:16.
  Accept: 6 variants, 6 outcome assertions, a second call byte-identical.
- M1 Provenance manifest. Every room file and every promoted replay file gets a `fixtures/MANIFEST.md` row. Room row:
  Source "generated with Muse Image (muse-image-1.0) by scripts/gen_room_fixtures.py, room <room_id>, <YYYY-MM-DD>;
  test fixture only (ADR 0029)"; promoted row: Source "live Meta responses for room <room_id>, promoted by
  scripts/promote_live_cache.py, <YYYY-MM-DD>"; License for both cites ADR 0029. `make_synthetic_fixtures.py` owns
  only rows whose Source is its `SOURCE` or `PLACE_SOURCE` and their files: a run keeps every other row and file
  byte-for-byte. `test_committed_fixtures_match_generator_output` compares generator-owned paths only;
  `test_manifest_lists_every_fixture_file` covers every committed file. Accept: a foreign row + file seeded in the
  sandbox survive a generator run; both tests green with rooms and promoted files committed.
- P1 `python scripts/promote_live_cache.py --room <room_id> [--dry-run]`: offline, no key. Copies from
  `refs/private/live-cache/<method>/` into `fixtures/replay/<method>/` only entries recorded for the room's processed
  photo (`process_upload(fixtures/rooms/<room_id>.webp).sha`); never `photos/`, never another photo's entry (private
  live runs share that cache, ADR 0017). Cache file names are key digests, not photo shas: an entry the script cannot
  attribute to the room is not copied. Target exists with equal bytes -> skipped; different bytes -> stderr, exit 1,
  nothing written. Adds the M1 rows; copied files pass `precommit_scan.py`. `--dry-run` prints the paths, writes
  nothing. Accept: a cache seeded with 2 photos' entries -> only the room's copied, 0 from `photos/`; a re-run copies
  0; a conflicting target -> exit 1.
- D1 `GET /demo/photo.jpg?room=<room_id>`. No param -> today's demo photo, unchanged. A room_id matching
  `^[a-z0-9-]{1,32}$` that names an existing `fixtures/rooms/<room_id>.webp` -> those bytes unchanged (raw, ADR 0016:
  a browser re-encode breaks sha replay), media type from `imaging.sniff`. Anything else (unknown id, `..`, `/`,
  `%2F`) -> 404 `room_missing`; the path is built only from a validated id. Route guards unchanged. Accept: absent,
  valid (byte-equal), unknown and traversal cases tested.
- D2 A page opened as `/?room=<room_id>` makes Load demo fetch `/demo/photo.jpg?room=<encodeURIComponent(room_id)>`;
  without the param the fetch URL is unchanged. Notes, place and recall demo fetches unchanged; the id is never
  written into the DOM. Accept: 2 client tests (with, without).
- X1 `scripts/e2e_drive.py --room <room_id>`: id checked against the D1 pattern (`parser.error` otherwise); drives
  the existing steps on `/?room=<room_id>` in fixture mode, so every model call replays from P1 entries and a
  `fixture_missing` is a FAIL. DOM asserts only; screenshots land in `--out` as artifacts, never compared. Without
  `--room` the run is unchanged (`EXPECTED_STEPS` 22). Accept: 2 parse tests; default run 22/22; exit 0 per promoted
  room.
- K1 Kev run (paid, about $1 total; Claude never reads keys or makes paid calls): confirm the output-ownership
  clause in Meta's API terms (start at dev.meta.ai) before the first room commit; run G2; per room one live record
  (`scripts/run_live.ps1` server, page `/?room=<room_id>`, the X1 step sequence); P1; X1 exit 0.
- Build slices (CRITERIA; SIGNALS):
  - B1 G1. CRITERIA: request path, 4 payload keys, 0 retries on 5xx asserted. SIGNALS: none.
  - B2 G2, G3, V1. CRITERIA: dry-run exit 0 offline with "calls: <n>"; fake run <= 5 calls, re-run 0; unset key
    exit 2 with 0 calls; 6 variant outcomes. SIGNALS: none.
  - B3 M1, P1. CRITERIA: seeded foreign row survives a generator run; promote copies only the room's entries, 0 from
    `photos/`, re-run 0, conflict exit 1; `tests/test_fixtures_manifest.py` green. SIGNALS: none.
  - B4 T1, D1, D2, X1. CRITERIA: 4 route cases; 2 client cases; 2 `--room` parse cases; `.dockerignore` assert;
    default E2E 22/22. SIGNALS: `e2e_drive.py` exit 0; screenshot gate (diff touches `static/`).
  - B5 K1 (Kev). CRITERIA: 3-5 rooms committed with M1 rows; each promoted; `e2e_drive.py --room <room_id>` exit 0
    per room. SIGNALS: ownership clause confirmed; Meta usage about $1.

Tests: tests/test_meta_client.py, tests/test_gen_room_fixtures.py, tests/test_promote_live_cache.py,
tests/test_fixtures_manifest.py, tests/test_app.py, tests/test_e2e_drive.py, tests/test_deploy_artifacts.py,
static/app.test.mjs
