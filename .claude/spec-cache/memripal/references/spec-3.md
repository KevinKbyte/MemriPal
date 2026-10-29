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
