# MemriPal spec (continuation)

Continuation of [spec-2.md](spec-2.md), which is at its 500-line cap.

## MEM-041 v6 Review prototype kept as a design reference

Source of the claude.ai "MemriPal Prototype" artifact (Version 7, https://claude.ai/artifact/RBvuQkU4vM3u7f5AhhdbKN)
committed under `docs/design/v6/`: `memripal-prototype.html`, `app.js`, `review.js`, `sched.js`, `tags.js`,
`styles.css`. Standalone design reference (v6: palace tags Talk/Exam/user tags, optional dates, Review sort/filter),
not served by the app; nothing under `static/` changes. Superseded in part by MEM-044: the v6 look (tokens, type,
component styles) is adopted into `static/style.css` and `static/index.html`; v6 JS (`app.js`, `review.js`,
`sched.js`, `tags.js`) and the screen-per-step navigation stay reference-only; `docs/design/v6/` is unchanged.
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
`scripts/make_synthetic_fixtures.py` + `tests/test_fixtures_manifest.py` (M1), `backend.py` `_store`
(P1 sidecar), README script entries.
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
  `refs/private/live-cache/<method>/` into `fixtures/replay/<method>/` only entries recorded for the room's
  processed photo (`process_upload(fixtures/rooms/<room_id>.webp).sha`); never `photos/`, never another
  photo's entry (private live runs share that cache, ADR 0017). Cache file names are key digests, not photo
  shas: an entry the script cannot attribute to the room is not copied. Attribution (Kev Q23(ii); replaces
  replaying the room photo, which reached only `find_loci` entries): write-time sidecars.
  - Write: `MetaBackend._store` (or `ResponseCache.put`) also writes, per cache entry, a sidecar next to it
    naming the photo sha of the run that produced it (`RequestKey.photo_sha` = `process_upload(photo).sha`),
    for every method: loci, spark, re-ask, segment, notes, associate. One sidecar file per entry, atomic
    (temp file, then `os.replace`), so concurrent writes cannot clash; an `OSError` is logged as the entry's
    is, never failing the call.
  - Promote: copies exactly the entries whose sidecar names the room sha, plus their sidecars; 0 from other
    photos. An entry without a sidecar (incl. any recorded before sidecars landed) is skipped; stderr prints
    the skip count.
  Target exists with equal bytes -> skipped; different bytes -> stderr, exit 1, nothing written. Adds the M1
  rows (entries and sidecars); copied files pass `precommit_scan.py`. `--dry-run` prints the paths, writes
  nothing. Accept: a cache seeded with 2 photos' entries -> only the room's copied, 0 from `photos/`; a re-run
  copies 0; a conflicting target -> exit 1; a room with 0 attributed entries -> stderr "0 entries for room
  <room_id>", exit 1, nothing copied (Q25).
- D1 `GET /demo/photo.jpg?room=<room_id>`. No param, or an empty `?room=` (Kev Q23(iii): treated as no param)
  -> today's demo photo, unchanged. A room_id matching `^[a-z0-9-]{1,32}$` that names an existing
  `fixtures/rooms/<room_id>.webp` -> those bytes unchanged (raw, ADR 0016: a browser re-encode breaks sha
  replay), media type from `imaging.sniff`. Anything else (a non-empty id outside the pattern, unknown id,
  `..`, `/`, `%2F`) -> 404 `room_missing`; the path is built only from a validated id. Route guards unchanged.
  Accept: absent, empty (default photo), valid (byte-equal), unknown and traversal cases tested.
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
  - B3b P1 sidecars. CRITERIA: each of loci, spark, re-ask, segment, notes, associate writes 1 sidecar naming
    its photo sha; sidecar write is temp + `os.replace`; a sidecar `OSError` fails 0 calls; promote over 2
    photos' entries copies the room's entries + sidecars, 0 from the other photo; no-sidecar entry skipped,
    count printed; re-run 0; conflict exit 1, 0 writes; `--dry-run` 0 writes; existing P1 tests green.
    SIGNALS: none.
  - B4 T1, D1, D2, X1. CRITERIA: 5 route cases; 2 client cases; 2 `--room` parse cases; `.dockerignore`
    assert; default E2E 22/22. SIGNALS: `e2e_drive.py` exit 0; screenshot gate (diff touches `static/`).
  - B5 K1 (Kev). CRITERIA: 3-5 rooms committed with M1 rows; each promoted; `e2e_drive.py --room <room_id>` exit 0
    per room. SIGNALS: ownership clause confirmed; Meta usage about $1.

Tests: tests/test_meta_client.py, tests/test_gen_room_fixtures.py, tests/test_promote_live_cache.py,
tests/test_fixtures_manifest.py, tests/test_backend.py, tests/test_app.py, tests/test_e2e_drive.py,
tests/test_deploy_artifacts.py, static/app.test.mjs

## MEM-044 v6 look adoption + painterly theme

ADR [0030](../../../../docs/decisions/0030-adopt-v6-css-markup-only.md); supersedes in part MEM-041 (nothing under
`static/` changes) and MEM-040 (no new link tags). Kev (Q22): adopt the v6 look ourselves. Take v6 CSS + markup ONLY
(`docs/design/v6/styles.css` tokens and component looks, `memripal-prototype.html` patterns), retargeted to live ids and
elements. v6 JS (`app.js`, `review.js`, `sched.js`, `tags.js`) is reference-only: a self-contained mock (0 fetch,
hard-coded data, innerHTML against MEM-042 I6, globals, ids `#s1`-`#s9`/`#jump`); its step rail, screen-per-step
navigation, Review and tags stay out. `docs/design/v6/` is unchanged. The live CSP (MEM-042 C1) has no `style-src` or
`font-src`, so `<style>`, `style=` and remote fonts are refused. Changed: `static/style.css`, `static/index.html`,
`static/rehearsals.js`, `static/app.js` (badge constants only, file <= 500 lines); new `static/theme-painterly.css`.
- A1 Tokens + base (`static/style.css` rewritten in place): the 21 v6 tokens (`--bg`..`--shadow`, `--display`,
  `--body`, `--mono`) under `:root`, `@media (prefers-color-scheme: dark) :root:not([data-theme="light"])` and
  `:root[data-theme="dark"]`, `color-scheme` under all 3; every token consumed by a `var(` (0 dead). System font stacks
  only: 0 `@font-face`, 0 `@import`, 0 `http`; a later web font is self-hosted under `/static/` (C1 `default-src
  'self'`). CSP-clean: 0 inline style, 0 `<style>`, no eval. Kept: the live `[hidden]` rule spelling (`display: none
  !important`; the parsed spelling is test-pinned), the `#empty-state`, `img` and `#scene-overlay` (position fixed,
  inset 0, z-index >= 10) rules. On `html`, `:root`, `body`, `main`: none of filter, backdrop-filter, transform,
  perspective, will-change, contain, mix-blend-mode, isolation, z-index, overflow (keeps `#scene-overlay`
  viewport-fixed); v6 `body::before` fixed layer dropped. Contrast from tokens, light and dark: >= 4.5:1 for ink/bg,
  ink/surface, muted/bg, muted/surface, muted/surface-2, on-primary/primary, primary/surface, lamp-ink/lamp-soft,
  ink/lamp-soft, ok/ok-soft, bad/bad-soft, on-bad/bad; >= 3:1 for focus/bg, line/surface. Every rule setting a
  background has an effective text colour >= 4.5:1 (`.live-board li.lit` -> `var(--lamp-soft)` + `color:
  var(--ink)`). A rule setting `color` on input/textarea/select/button also sets `background`.
- A2 Markup (`static/index.html`; F13): v6 shell and control markup (topbar brand, `.panel`, `.field`, `.btn`,
  `.btn-primary`, `.eyebrow`, `.notice`) around the live elements. Every existing id kept and its `hidden` attribute
  unchanged: id set and initially-hidden id set equal 748a5e1's. Link list unchanged; 0 `style=`, 0 `<style`;
  `#empty-state` still directly before `#scene-wrap`. 0 orphan classes (each `index.html` class has a `style.css`
  rule) and 0 orphan selectors (each `style.css` class is in `index.html` or a class literal in `static/*.js`). F13:
  the `#auto` label sits in the same container as `#load-demo`, before it; every text/file/password input has a `<label
  for>` inside one `.field` wrapper (display grid or block); 0 bare top-level `<label>`/`<input>` children of `main`.
  `#auto` stays a native visible checkbox. `button` and `.btn` min-height >= 44px. No new wrapper between `main` and
  `#scene-overlay` carries an A1-forbidden property.
- A3 Components (`static/style.css`, `static/rehearsals.js`, `static/app.js`; F6, F12 numbering, F15 badge
  contrast): 0 classes added to the `said-vs-palace` OL/LI (exact className asserts unchanged). F6:
  `span.said-label`/`.said-text`/`.said-quote` display block; each row gains textContent labels "You said:" before
  said-text and "In your palace:" before said-quote. F12: each `#route li` shows its number (counter or list-item
  marker), `#route li > span:first-child` stays the label; `#loci` numbering matches the canvas badges. F15: badge
  fill and text are exported constants in `app.js` (net <= +2 lines) at >= 4.5:1 (today `#ff3b30`/`#fff` = 3.55:1;
  e.g. `#A1341A` on `#FFFFFF`). `#associations > section` and `#scenes > section` stay direct children; `.live-board
  li.lit` takes background and color from tokens; 0 filter/transform on `#scene-wrap`, `#scenes`, `#walk`,
  `#recall`, `#recall-live` or their ancestors.
- P1 Painterly theme (`static/theme-painterly.css`, after A1-A3; droppable). No-op guard: the theme remaps v6 tokens
  that the live `style.css` consumes; every theme token is a v6 token or consumed in the theme, so the theme
  visibly changes the live app (a token-only theme over unconsumed tokens passes green and changes nothing).
  1. `index.html`: the theme is the LAST `rel=stylesheet` link; `test_assets_wiring` LINKS list = 4 links in that
     order, its comment cites MEM-044 P1; 0 `style="`, 0 `<style`.
  2. 0 http(s) URLs, 0 `@import`; every `url()` is data: or `/static/`; each data: URI parses as SVG XML with xmlns,
     has no raw `#`, no `<style`/`style=`/`<script`/`href`/`url(`, explicit width/height <= 256; data URIs total
     <= 4096 bytes.
  3. Tokens declared under the identical 3 A1 selectors; 0 dead tokens; `color-scheme` in all 3; the theme never
     sets `--body` (serif only via `--display`).
  4. Contrast: pairs extracted mechanically from every rule setting a background in every linked stylesheet (own
     color or inherited ink), `var()` resolved per mode, >= 4.5:1 text, >= 3:1 focus/line; ink/bg, muted/bg and
     primary/bg >= 4.5:1 against the worst-case grain composite; grain alpha <= 0.08.
  5. 0 width/min-width/flex-basis > 360px (`layout.test.mjs` scans the theme); 0 A1-forbidden properties on `html`,
     `:root`, `body`, `main` or any ancestor of `#scene-overlay`; 0 `filter:url(`, 0 inline `<svg><filter>` in
     `index.html`; deckle via a mask-image data: SVG on `.panel::before` only; grain as a capped-alpha body
     background; 0 mix-blend-mode; 0 `background-attachment: fixed`.
  6. 0 lines changed in `static/style.css`, `docs/design/v6/`, `src/memripal/security_headers.py`.
  7. 0 orphan selectors: every theme id/class/tag is in `index.html` or the `static/*.js` class allowlist.
  8. `@media (forced-colors: active)`, `(prefers-contrast: more)` and `print` each reset
     background-image/filter/mask-image/border-image for every theme selector that sets them; 0
     `@keyframes`/animation/transition.
  9. 0 `!important`; `[hidden]` still wins (the `test_hidden_wins` scan covers the theme).
  10. `scripts/check.sh` green (ruff, pytest, both node suites).
- P2 watercolour asset regen (paid, nondeterministic, 192 px icon legibility) deferred past Nov 3.
- Build slices (CRITERIA; SIGNALS), sequential in one worktree:
  - S1 A1. CRITERIA: A1 clauses; `test_assets_wiring` + `layout.test.mjs` green unmodified; 0 lines changed in
    `index.html`, `*.js`, `docs/design/v6/`, `security_headers.py`; check.sh green. SIGNALS: screenshot_ui 0 console
    errors; e2e 22/22 incl. step 13 360px no-hscroll; human look 360px light + dark; visual-verify record.
  - S2 A2. CRITERIA: id + initially-hidden set equality; 0 orphans; F13 asserts; 44px min-height; check.sh green.
    SIGNALS: e2e 22/22 (`page.check("#auto")`); screenshot_ui 0 errors; 360 + 1100 px screenshots; visual-verify
    record.
  - S3 A3. CRITERIA: className asserts pass unmodified; F6 both labels + hostile-input test; F12 numbering; F15 >=
    4.5:1 from the exported constants; `app.js` <= 500 lines; check.sh green. SIGNALS: e2e steps 6, 7 (overlay
    Escape + click at (5,5)), 8, 8b, 9a, 10b; light + emulated-dark `#scene-overlay` box == viewport (no eval);
    visual-verify record.
  - P1 P1. CRITERIA: no-op guard + P1 1-10. SIGNALS: screenshot_ui 0 errors; e2e 22/22; `to_have_css` body
    background-color == theme `--bg` light + dark; `#scene-overlay` box == viewport; human sign-off 360px;
    visual-verify record.

Tests: static/style_v6.test.mjs, static/index_markup.test.mjs, static/style_v6_components.test.mjs,
static/theme_painterly.test.mjs, static/rehearsals.test.mjs, static/layout.test.mjs, tests/test_assets_wiring.py

## MEM-061 Chunked mnemonics per station (PLANNED)

PLANNED, not built: no code adopts it. An ADR in `docs/decisions/` is owed in the change that adopts chunking.
Changes MEM-020 POST /split (notes mode returns 1..min(12, loci_count) points: up to one key point per station) and
MEM-021 (one association record per (item, locus) pair): a station instead holds one mnemonic or acronym packing
>= 1 point. Kev 2026-10-31: "against what user desires to remember. So user can create routes on the map, and then
when they want to memorize something, they can paste what they want to memorize, and meta models can break down the
information into key points/acronyms/mnemonics, and hook it memorably across the loci. The mnemonic translation is a
way to chunk information so more info can be stored in each loci".
- Flow: user creates a route on the map, pastes the text to memorize; Muse Spark breaks it into key points/acronyms/
  mnemonics and packs each station's points into one mnemonic or acronym hooked across the loci.
- UI (route UX design): each association card shows the mnemonic (`.assoc-chunk`) and the points it packs
  (`ul.assoc-points`), or `p.assoc-item` when the station holds a single point; then the 8 channels (MEM-021
  `CHANNELS`). `#list-notes` label: "Paste what you want to remember. Muse Spark breaks it into key points and packs
  them into a mnemonic or acronym at each station, so one station can hold more than one point."
- At adoption, recheck MEM-042 I1 (points per rehearsal <= 12) and I3 (record = exactly the 15 `associate.py`
  `FIELDS`) against the chunk record shape, so backups still round-trip (R1).
- Accept: a station card renders >= 2 points (`ul.assoc-points` li count) under one `.assoc-chunk`; a single-point
  station renders 1 `p.assoc-item` and 0 `.assoc-chunk`; every card renders the 8 channels after its points; notes
  with more points than stations -> every returned point in exactly 1 station card, 0 dropped; every `.assoc-chunk`
  text non-blank; `#list-notes` label equals the quoted text; model text via textContent only (MEM-042 I6); ADR
  committed in the adopting change.

## MEM-062 Place facts as hooks (opt-in, landmark positions only) (PLANNED)

PLANNED, not built: no code adopts it. An ADR in `docs/decisions/` is owed in the change that adopts place facts.
Builds on MEM-025 (ADR [0022](../../../../docs/decisions/0022-opt-in-place-context-server-lookup.md)); when built,
supersedes in part MEM-025 a): toggle placement and label, and the coordinate source (photo EXIF GPS /
`navigator.geolocation` -> station landmark position). Kev 2026-10-31: "historical significance can now play a good
part in it if user route crosses with historical landmarks it can help with the generation of the memorable KAVE COGS
hooks to the loci" / "it doesnt need to just be historical significance, there can be fun facts about that location
that ties in with the memory" / "we can have a toggle in the user settings if they want to opt in. and off by default.
The location will also not even be exact location coords, it'll be at the landmarks shown by the map solution we
choose".
- Behaviour: a route station at or near a landmark with historical significance, or a fun fact about the location
  that ties in with what is being remembered -> the model uses it to make that station's KAVE COGS channel hooks
  (MEM-021 `CHANNELS`) to the locus.
- Setting: opt-in, OFF by default. `#place-toggle` lives in S1 `#routes-settings` next to `#passcode` and `#auto`;
  `#place-typed` and `#places` stay in S5 `#place-settings`. Toggle label: "Look up place facts for my stations (off
  by default): sends each station's landmark position, not your exact location, to Wikipedia through MemriPal's
  server."
- Egress: only the station's landmark position from the chosen map source, never the user's exact GPS coordinates,
  via MemriPal's server to Wikipedia GeoSearch.
- Card: `div.assoc-place-fact` with a `span.model-chip` "Muse Spark" and a `p.credit` "Place facts: Wikipedia, CC
  BY-SA".
- Blockers: (a) map/landmark source not chosen (ADR pending); (b) the ADR 0022 server lookup takes photo EXIF/device
  coordinates: code must switch to landmark positions before the privacy copy is true; (c)
  `docs/plans/2026-10-31-map-to-palace.md` assumption A1 (station coordinates from EXIF GPS or browser geolocation)
  must be reconciled.
- Accept: fresh profile -> `#place-toggle` unchecked, inside `#routes-settings`; `#place-typed` and `#places` inside
  `#place-settings`; toggle off -> 0 requests to the place lookup, 0 geolocation prompts; toggle on -> request payload
  holds landmark id/position only, 0 raw device lat/lon (test: payload never equals the EXIF GPS or geolocation
  coords); a station with a fact renders 1 `div.assoc-place-fact` with `span.model-chip` "Muse Spark" and `p.credit`
  "Place facts: Wikipedia, CC BY-SA", a station without -> 0; toggle label equals the quoted text; blockers (a)-(c)
  closed before the label ships; ADR committed in the adopting change.

## MEM-047 Neutral demo place text scrub

Plan B2 (docs/plans/2026-10-31-map-to-palace.md, item 112); amends MEM-025 example text (ADR 0022 amendment note,
decision unchanged). The offline demo place carries neutral text, never war-site text.
- `git grep -i -E` over the B2 war-site pattern across README.md, docs/, static/, src/, scripts/ and
  .claude/spec-cache/ (CHANGELOG history, fixtures/ and the plan doc that quotes the pattern excluded) == 0 hits.
- The MEM-025 heading stays in spec-2.md (exactly one); its example text is neutralised in place and this entry is
  its amendment record (spec-2.md is at its line cap).
- The demo place title is the placeholder "Demo route" (B10 replaces it with the chosen public place); every demo
  place title and recorded extract passes a deterministic war-term denylist.
- Deferred to B10: the generator constants (`scripts/make_synthetic_fixtures.py` PLACE_HITS + PLACE_EXTRACTS) and the
  37 place-bound replay fixtures (1 `fixtures/replay/place/`, 36 `fixtures/replay/spark_json/`). Changing the
  constants needs those fixtures regenerated (MEM-005 committed-equals-generated), which B2 must not do; B10 retires
  and re-records them. Until then the scrub grep excludes the generator and the three generator tests are
  xfail(strict).

Tests: tests/test_demo_place_scrub.py
