# MemriPal spec (continuation)

Continuation of [spec-6.md](spec-6.md). A new file so in-flight branches appending to spec-6.md never collide with it.

## MEM-132 Landmark photo slots: SAM 3.1 segments an uploaded landmark photo into 3 Payoff slots

Decided-by: ADR-0080
ADR [0080](../../../../docs/decisions/0080-landmark-slots-from-loci.md).
Root problem: the demo shows SAM 3.1 segmenting a photo the user took (the Kendall station landmark) and then placing
the three Payoff parts into regions of that photo, without new server surface hours before the deadline.
Actors: the user; `static/slots.html` + `static/slots_page.js` + `static/landmark_slots.css` (page);
`static/landmark_slots.js` (module); POST `/loci` (MEM-015, `src/memripal/loci.py` `find_loci`, unchanged);
`static/sticker_drag.js` (optional, loaded by dynamic import); `scripts/gen_landmark_slots_fixture.py`;
`static/fixtures/landmark_slots_kendall.json`.
NFR: no server change; CSP `script-src 'self'` (no inline script or style); every label written via `textContent`,
never parsed as HTML; ASCII only; 0 live calls in fixture mode.
- `static/landmark_slots.js` exports `PAYOFF_PARTS` = `[{id:"resolve",label:"Resolve the question"},
  {id:"useful",label:"Something useful"},{id:"memorable",label:"Something memorable"}]` and `SLOT_COUNT` = 3.
- `parseSegmentation(json)` accepts a `/loci` reply only when `image` matches `data:image/(jpeg|png|webp);base64,`,
  `width`/`height` are finite positive numbers and `loci` is an array; else returns null.
- `pickSlots(loci, count)`: drops loci without a finite positive-area box; keeps one locus per label
  (case-insensitive, the largest box wins); takes the top `count` by box area; renumbers `n` from 1 ordered by `y1`
  then `x1`; keeps `outline` when it has >= 3 finite points, else uses the box rectangle; never mutates its input.
- `segmentLandmark({fetch, file, storage, landmarkId, fixtureUrl, timeoutMs = 45000})` never rejects. It POSTs the
  file to `/loci` (via `apiUrl`); a 2xx reply that parses and yields `SLOT_COUNT` slots returns
  `{source:"live", image, width, height, slots}` and caches it in `storage` under `memripal.slots.<landmarkId>`.
  On a non-2xx, timeout, network error, bad JSON or too few slots it returns the cached entry as
  `source:"cached"`, else the bundled fixture as `source:"sample"`, else null.
- `placePart(placements, partId, n)` is pure: returns a new map with `partId` in slot `n`; a part sits in one slot
  at most and a slot holds one part at most (the part displaced from `n` moves to `partId`'s old slot, or is unplaced).
- `createSlotBoard({doc, root, parts, wireDrag, nearestBox})` returns `{show, placements, place}`. `show(result)`
  renders the photo `<img>`, an SVG overlay (`viewBox="0 0 <width> <height>"`) with one `.slot-shape` polygon per slot
  (`data-n`) plus a numbered label, a source badge ("Live SAM 3.1" | "Cached SAM 3.1" | "Sample photo"), one
  `.slot-row` per slot, and a `.payoff-chip` tray. Tap a chip (sets `aria-pressed="true"`), then tap a slot shape or
  row, to place it. When `wireDrag` and `nearestBox` are given, dropping a chip maps client px to photo px via the
  img rect and places it in `nearestBox`'s slot.
- `static/slots_page.js` loads `sticker_drag.js` with `import("./sticker_drag.js").catch(() => null)`, so tap-to-place
  works whether or not that module is deployed.
- `scripts/gen_landmark_slots_fixture.py <photo> [--out PATH]` runs `/loci` in-process (TestClient, base_url
  `http://127.0.0.1`) and writes the fixture; exits 1 on a non-200 or fewer than `SLOT_COUNT` loci.
- At 375 px: no horizontal scroll; chips and slot rows are >= 44 px tall.
- Accept: a `/loci` reply with >= 3 loci yields 3 slots; duplicate labels and bad boxes are dropped; a live 5xx,
  timeout or bad JSON falls back to cached then sample; the bundled fixture yields 3 slots; a hostile label renders
  as text; tap-place and drag-snap each place a part.
