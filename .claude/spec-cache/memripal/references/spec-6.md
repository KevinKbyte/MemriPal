# MemriPal spec (continuation)

Continuation of [spec-4.md](spec-4.md), which is at its 500-line cap. spec-5.md is held by in-flight branches
(mem088-wire, gcp-deploy-harden); this file takes the next free name so the two never collide.

## MEM-097 Copilot tool dispatcher: per-tool allow/ask/off, every action undoable (PLANNED)

PLANNED, not built. Item 21 "Memri copilot".
ADR [0064](../../../../docs/decisions/0064-memri-copilot-street-photo-scenes.md).
Decided-by: ADR-0064
Root problem: a copilot that acts on the app needs one audited path for its actions, user control over which tools
it may use, and a way back from any action it takes.
Actors: the user; the copilot model; the UI action dispatcher; `static/tool_policy.js`, `static/undo_stack.js` (new,
pure modules; S11 / MEM-093 may import them). <!-- claim-exempt: planned -->
NFR: pure modules, no DOM or network; ASCII only.
- Every copilot tool call runs through the UI action dispatcher; no tool touches state directly.
- Per-tool policy allow | ask | off (`static/tool_policy.js`): ask prompts the user before running; an off tool is
  rejected by the dispatcher and absent from the tool list sent to the model.
- Every action pushes exactly one inverse onto `static/undo_stack.js`; undo replays it.
- Accept: an off tool is rejected and missing from the model's tool list; an ask tool runs only after confirm; each
  action adds one undo entry and undo restores the prior state.

## MEM-098 Copilot street-photo scene tool via POST /baseline (PLANNED)

PLANNED, not built. Item 21. ADR [0064](../../../../docs/decisions/0064-memri-copilot-street-photo-scenes.md)
(amends map-to-palace D1); server core MEM-053 (spec-3.md).
Decided-by: ADR-0064
Root problem: a photo-less station needs a scene; a real Kendall street photo can supply it if licence and privacy
conditions hold.
Actors: the copilot; `fetch_street_photo{station_id}` tool; `src/memripal/app.py`; `baseline_router` from
`src/memripal/routes_baseline.py`; `FixtureBaselineProvider`; SAM; Muse Image; `scripts/run_live.ps1`.
NFR: 0 live calls in fixture mode; token never in `.env`, the repo, logs or chat (ADR 0005); ASCII only.
- Mount POST `/baseline` in `app.py` (`baseline_router`); fixture mode uses `FixtureBaselineProvider`, as `app.py:177`
  does for places. Passcode checked before the body; budget 429; busy 429.
- `fetch_street_photo{station_id}` -> `/baseline` -> station photo -> SAM -> Muse Image scenes.
- Every derived scene carries the licence credit block: Mapillary logo linked to the image page, contributor
  username, link to the original image, "AI-modified" note, "CC BY-SA 4.0" with a licence link.
- Muse Image prompts say not to alter or restore faces or plates.
- The MEM-094 spend guard counts Muse Image `/images/edits` before live use.
- `scripts/run_live.ps1` decrypts `~/.secrets/mapillary-token.dpapi` into `MEMRIPAL_MAPILLARY_TOKEN` for the child
  process only, when the file exists.
- Accept: fixture mode makes 0 live calls; passcode 401 precedes any body read; every derived scene renders the full
  credit block; every Muse Image prompt carries the no-restore rule; the spend guard counts each edit.

## MEM-099 Copilot placement: Messenger-style Pal chat bubble with on-device chats

Item 21. ADR [0064](../../../../docs/decisions/0064-memri-copilot-street-photo-scenes.md)
(amendment 2026-11-03: chat bubble). Kev asked for a Messenger-style bubble, draggable, with multiple user-managed
chats kept in the on-device SQLite db and carried by export/import.
Decided-by: ADR-0064
Root problem: the copilot must be reachable from every screen, not one tab, and its chats are user data that must
stay on the device and travel with the palace backup.
Actors: the user; `static/pal_bubble.js` + `static/pal_bubble.css` (self-mounting DOM);
`static/chat_store.js`; `static/db/schema.js` (migration V2); `static/db/worker.js` (opfs-sahpool);
`static/palace_export.js`; one `<script type="module">` line in `static/index.html`.
NFR: no server storage of chats; CSP unchanged; ASCII only; touch, mouse and keyboard all work; the only S6 hot-file
edit is the mount line, landed after MEM-088.
- B1: the bubble shows on every screen; tap, click or Enter opens the panel; an outside click or Esc collapses it;
  reopening resumes the same chat.
- Mount: `static/index.html` loads `/static/pal_bubble.js` once, right after `/static/app.js`; `mountPalBubble` adds
  exactly one `<link rel="stylesheet" href="/static/pal_bubble.css">` to `<head>` (idempotent on re-mount), so
  index.html carries no bubble `<link>`.
- B2: pointer-event drag (touch and mouse); the bubble stays where dropped, clamped to the viewport and re-clamped on
  resize; arrow keys move it; its position persists across reloads; a drag never opens it.
- B3: `chats` and `chat_messages` tables arrive in migration V2; soft delete via `deleted_at`; rows are never
  hard-deleted.
- B4: list, switch, new, rename and delete chats; delete is a click plus a confirm, always followed by an Undo that
  revives the row.
- B5: `buildBackup` writes `chats[]` as backup `v: 3`; `importBackup` accepts v2 (no chats) and v3; chats are rebuilt
  through an allow-list with caps (chat count, messages per chat, text length, role enum, ids); an invalid chat is
  skipped with 0 partial writes; a stored id counts as present.
- B6: chat and message ids mint through `static/uuid.js` `newId` (`crypto.getRandomValues` fallback), so creating a chat
  works where `crypto.randomUUID` is absent but Web Locks and OPFS exist. A plain-http non-localhost origin also lacks
  Web Locks and OPFS, so there the bubble still mounts and shows "Chats unavailable in this tab".
- Accept: the bubble is on every tab; outside click and Esc collapse it and reopening resumes the chat; drag clamps
  at all 4 edges, survives a reload and is keyboard-movable; V2 migrates a V1 db with routes intact; delete confirm
  plus Undo restores the chat; export then import round-trips chats; a v2 file still imports; a hostile `chats[]` is
  rejected or skipped with 0 partial writes.

Tests: static/pal_bubble.test.mjs (incl. "MEM-099 Pal bubble loads its own stylesheet"), static/chat_store.test.mjs,
static/palace_export_chats.test.mjs, static/store_ids_insecure.test.mjs,
tests/test_assets_wiring.py::test_index_loads_pal_bubble_module_once_after_app_js

## MEM-116 Pal chat panel reads like a messenger (bubbles, greeting, composer)

Kev ask (2026-11-04): "the chat interface should look much more ui/ux friendly - similar to messenger, whatsapp and
other chat interfaces like chatgpt/copilot" (or Claude). Restyles the MEM-099 panel; no approach choice, so no ADR.
Root problem: the MEM-099 panel listed messages as "You: ..." / "Pal: ..." text with no way to type, so it read as a
log, not a chat.
Actors: `static/pal_chat.js` (messageNodes, typingNode, createComposer, timeLabel); `static/pal_bubble.js` render
and sendMessage; `static/pal_bubble.css` `.pal-panel` rules onward.
NFR: DOM via textContent only (no innerHTML); theme tokens for colours; ASCII only; launcher button, drag and position
code untouched; typing dots stop under `prefers-reduced-motion`.
- B1: user messages sit right in a `--primary` bubble; Pal's sit left with Pal's face; each shows a local `h:mm`
  `<time datetime>` when `created_at` is a valid ISO string, else no time.
- B2: an empty chat shows a Pal greeting with Pal's face; it goes once a message exists.
- B3: a bottom sticky composer (auto-growing textarea, max `MAX_MESSAGE_CHARS`, send button): Enter sends the
  trimmed text and clears the box; Shift+Enter is a newline; blank text never sends and keeps send disabled; with no
  active chat, sending creates one. The composer hides when chats are unavailable.
- B4: `mountPalBubble({..., reply})` takes an optional `reply(text, history) => Promise<string>`; while it runs a
  three-dot "Pal is typing" row shows; a non-blank answer lands as a Pal bubble; a throw keeps the user message,
  clears the indicator and shows "Pal couldn't answer just now. Try again." (role alert).
- B5: the message list is `aria-live="polite"` and scrolls to the newest message after each render.
- Open: `selfMount` passes no `reply` (no /chat backend route yet), so the composer saves user messages only until a
  reply provider is wired.
- Accept: static/pal_chat.test.mjs green (11 tests); 375 px and desktop screenshots of the open panel.

Tests: static/pal_chat.test.mjs

## MEM-045 Sticker pool and photo upload on the landmark photo

Amended by MEM-131: photo stickers drag and snap to the nearest locus box; a tap never touches the pool.
Kev ask 2026-11-04: "or upload own images to sticker onto the place (eg. the kendall station) ... we can have a
storage for stickers that have text desc so we can search the stickers rather than having to generate al the time";
"generated stickers will automatically be added to that pool"; "emojis can be the base stickers to search from";
"make it fun and friendly ui ux". Merge 1 of 2; the search picker is a follow-up MEM (merge 2), not this entry.
Root problem: the user wants their own pictures stuck on a locus of the landmark photo, kept in a described pool they
can reuse instead of regenerating each time; no client store or placement layer exists for that.
Actors: the user; `static/sticker_pool.js` (new, pure, no DOM); `static/sticker_board.js` (new, DOM);
`static/encode.js` `runDemoPalace`; `static/app.js` boot; `static/index.html` Recall tab; `static/style.css`;
`static/idb_adapter.js` via flow.js `selectStore`; `static/thumbnail.js`; `BASE_STICKERS` (`static/stickers.js`).
NFR: no server change or storage; offline and fixture mode work; textContent only, never innerHTML; the pool never
stores the original photo (client downscale: long side 256, JPEG q 0.8); ASCII only.
Decided-by: ADR-0068
- Store: `selectStore(globalThis, {dbName: "memripal-stickers", storeName: "stickers", prefix:
  "memripal.sticker:"})`; IndexedDB with localStorage fallback.
- Constants: `MAX_UPLOAD_BYTES = 2 * 1024 * 1024`; `MAX_DESC = 60`; `UPLOAD_TYPES` = image/jpeg, image/png,
  image/webp, image/gif; `SEED_TIME = "1970-01-01T00:00:00.000Z"`.
- Entry `{ id, kind: "emoji"|"upload"|"generated", desc, image, created_at }`; emoji `image` is the glyph, upload and
  generated `image` is a `data:image/(jpeg|png|webp);base64,...` URL.
- `emojiEntries()`: one per `BASE_STICKERS` item in order: id `"emoji:" + name`, desc `[name, ...words].join(" ")`,
  `created_at: SEED_TIME`.
- `uploadError(file, desc)` -> Pal-voiced string or null; non-null for: no file; type not in `UPLOAD_TYPES` (incl.
  "text/plain", "image/svg+xml", ""); size 0 or > `MAX_UPLOAD_BYTES`; trimmed desc empty or > `MAX_DESC`.
- `createStickerPool(kv, { now, newId })` (kv = `{get, put, delete, list}`), all async:
  - `list()`: emoji entries first, then stored entries by `created_at`.
  - `add({kind, desc, image})` stores `{ id: newId(), kind, desc: desc.trim(), image, created_at: now() }`; rejects
    kind other than upload/generated, bad desc, or image not matching
    `^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$` (javascript:, svg data URLs and https rejected).
  - `get(id)` -> emoji or stored entry, else null.
  - `place(placeKey, n, stickerId)` -> `{ placeKey, n, stickerId, placed_at }`; one sticker per locus (re-place
    replaces); rejects unknown stickerId, non-positive-integer n, empty placeKey.
  - `placements(placeKey)` sorted by n, other places excluded; `unplace(placeKey, n)` -> removed placement or null;
    `restore(placement)` puts it back.
  - A second pool over the same kv sees the same entries and placements.
- `createStickerBoard({ doc, pool, makeImage, undo })` -> `{ show({ placeKey, width, height, loci }) }`:
  - unhides `#sticker-panel`; `#sticker-locus` gets one option per locus, value `String(n)`, text `${n}. ${label}`.
  - `#sticker-placed` gets one li per placement (text includes the desc); `#scene-wrap` gets ONE reused
    `.sticker-layer` with one `.sticker` per boxed placement at the box centre in percent (box {0,0,100,50} on
    200x100 -> left "25%", top "25%"); upload = img (`src` data URL, `alt` desc), emoji = span with the glyph.
  - `#sticker-add`: `uploadError` non-null -> `#sticker-error` shows it, `makeImage` not called, pool unchanged;
    `makeImage` rejects -> Pal-voiced "couldn't read that picture", nothing added; success -> `pool.add` kind upload,
    `pool.place`, re-render, error hidden, desc and file inputs cleared.
  - Peel: li button `data-action="peel"` ("Peel off") reveals `peel-confirm` ("Yes, peel it off") and `peel-cancel`
    ("Keep it"); only confirm removes, pushes one undo entry and shows `#sticker-toast`; `#sticker-undo` restores li
    and photo sticker and hides the toast.
  - Re-show over the same pool renders stored placements.
- Markup: `section#sticker-panel.sticker-panel` (hidden) right after `<ol id="loci">` in the Recall tab: h3
  "Stickers", Pal hint, `#sticker-locus` ("Spot"), `input#sticker-file` (accept = the 4 upload types, "Your
  picture"), `input#sticker-desc` maxlength 60 ("What it shows"), `button#sticker-add.btn.btn-primary` "Stick it on",
  `p#sticker-error.notice` role=alert hidden, `ul#sticker-placed`, `div#sticker-toast` role=status hidden with
  `span#sticker-toast-text` and `button#sticker-undo` "Undo".
- Wiring: `runDemoPalace` calls `deps.stickers?.show({ placeKey: "demo", width, height, loci })` once `/loci` is
  valid; a sticker failure never breaks the demo; absent `deps.stickers` is fine. `app.js` boot builds the board over
  the pool and a thumbnail.js + FileReader `makeImage`.
- CSS: die-cut look (white border, shadow, slight tilt); pop-in animation off under prefers-reduced-motion;
  `#scene-wrap` position relative.
- Accept: every `uploadError` / `add` / `place` rejection case above fails and the valid examples pass; reload over the
  same kv keeps entries and placements; one `.sticker-layer` after repeated renders; box centre maths as above;
  peel needs confirm and Undo restores; no innerHTML.
- Out of scope: search picker (follow-up MEM, merge 2); the image-generation caller (the pool already accepts kind generated); cross-device sync.
static/palace_export_chats.test.mjs, tests/test_assets_wiring.py::test_index_loads_pal_bubble_module_once_after_app_js

## MEM-113 Uncrossed route numbering

ADR [0070](../../../../docs/decisions/0070-uncrossed-route-order.md). Amends MEM-013 `route_order` (spec.md): the
reading order is now the seed, not the final numbering.
Decided-by: ADR-0070
Root problem: landmark numbers read as a route, and a path that crosses itself is harder to remember.
Actors: `src/memripal/loci.py::route_order`; the user reading numbered loci.
NFR: pure, deterministic; exact integer meeting tests; under 1 s on 4000 random layouts; ASCII only.
- Meeting: two non-adjacent legs of the 1 -> 2 -> ... -> n centroid path meet on a proper crossing, a T-touch, or a
  collinear overlap; tested in exact integers on doubled centroids (`x1 + x2`, `y1 + y2`); a coincident duplicate
  endpoint (two loci at one centroid) is not a meeting.
- 2-opt from the MEM-013 reading order: reverse the stretch between two meeting legs only on a strict decrease in
  total walk length, so the loop terminates; a clean reading order is returned unchanged.
- Fallback: a meeting that no reversal shortens -> sort by (cy, cx), a y-monotone walk that never meets itself.
- Applied as the last step of `route_order`, before n is assigned. `static/auto_loci.js` (MEM-085 along-route
  ordering) is unchanged.
- Future work, not built: a user-set manual order overrides auto numbering; no backend surface for manual numbering
  or sub-loci (ADR 0051) exists yet.
- Accept: no layout's final path has a meeting (zigzag, grid3, grid4, horizontal / vertical / diagonal
  collinear, duplicates, T-touch, X crossing, 0-3 points, 80 random seeds); each locus numbered exactly once 1..n;
  same input -> same order.

Tests: tests/test_route_uncrossed.py (ADR 0070)
- Out of scope: search picker (follow-up MEM, merge 2); the image-generation caller (MEM-052); cross-device sync.

## MEM-052 Generated sticker from the memorized item on its locus

Kev ask: when a palace is memorized, generate a sticker from each memorized item, stick it on that item's locus of the
landmark photo, and auto-save it to the sticker pool (MEM-045) so it is searchable by the item text.
Root problem: Kev ask: when a palace is memorized, generate a sticker from each memorized item, stick it on that item's
locus of the landmark photo, and auto-save it to the sticker pool (MEM-045) so it is searchable by the item text.
Actors: `static/sticker_gen.js` (new); `static/sticker_board.js`; `static/sticker_pool.js`; `static/encode.js`
`runEncode`/`runDemoPalace`; `static/scenes.js` (`runScenes` results, `isSafeImageSrc`); `BASE_STICKERS`/`search`
(`static/stickers.js`).
NFR: no server change and no extra /scenes call (reuses the scene runScenes already produced); offline/fixture mode
works; never throws into the demo; no new error UI; textContent only; existing pop-in animation already off under
prefers-reduced-motion; ASCII.
Decided-by: ADR-0071
- `sticker_pool` gains `search(text)`: entries of `list()` whose desc contains the trimmed text, case-insensitive;
  empty/blank/non-string text -> [].
- `sticker_gen.js`: `stickMemorized(pool, placeKey, steps, scenes, { crop })` -> placed `[{ n, stickerId, kind }]`,
  never rejects. Per step i (`{item, locus: {n, label, box}}`): skip when item is blank or a placement already exists
  at (placeKey, n) (a user's own sticker is never replaced); desc = item trimmed, cut to MAX_DESC (60). A generated
  entry with the same desc is reused (re-running the demo does not duplicate the pool); else when `scenes[i]` is tier 1
  with a safe image and the locus has a box, `crop(image, box, width, height)` -> data URL -> `pool.add({kind:
  "generated", desc, image})` -> `pool.place`. Any failure there (scene tier 3 / null, offline, crop or add rejects)
  falls back to the first `stickers.js` `search(item)` emoji (`emoji:<name>`); no emoji match -> skip silently.
- `cropScene(src, box, width, height)` (browser default `crop`): square around the locus box centre, drawn to a
  128x128 canvas, JPEG data URL; rejects without a DOM (then the emoji fallback applies).
- `createStickerBoard` gains `crop` dep and `stickMemorized(steps, scenes)`: no-op `[]` before `show`; else delegates
  to sticker_gen for the shown placeKey, re-renders, returns the placed list. Generated stickers render as img with alt
  = desc; their placed-list text ends with " (AI-generated)" (MEM-046 labelling).
- Wiring: `runEncode` returns `{ steps, scenes }`; `runDemoPalace` then awaits
  `deps.stickers?.stickMemorized?.(steps, scenes)`, swallowing any failure; the walk view is already shown.
- Accept: after the demo encode a tier-1 scene yields a generated sticker placed on its locus and visible on the photo;
  `pool.search(item)` finds it; tier-3/offline yields the emoji fallback or nothing, with no rejection; existing
  placement kept; re-run adds no duplicate; failing board never breaks the demo. Covered by
  static/sticker_gen.test.mjs.
- Out of scope: a dedicated sticker-generation prompt/endpoint; a pool search picker UI; non-demo palaces.

## MEM-055 Pal bubble shows Pal's face; inert during the tour

Kev ask 2026-11-04: "the pal ai bubble should be pal's face rather than "pal" the word. Also user shouldnt be able to
click on it during the tutorial unless if it's part of the tutorial". ADR [0072](../../../../docs/decisions/0072-tour-bubble-body-data-attribute.md).
Decided-by: ADR-0072
Root problem: the bubble labelled "Pal" in text is not the mascot, and a live bubble during the tour lets the user
leave the guided flow; the two self-mounting modules (`pal_bubble.js`, `tour.js`) need a shared signal.
Actors: the user; `static/pal_bubble.js` + `static/pal_bubble.css`; `static/tour.js`; `static/assets/pal-still.svg`.
NFR: no import coupling between the two modules; ASCII only; keyboard, touch and mouse all inert together; light and
dark legible.
- B1: the bubble button renders a head crop of `static/assets/pal-still.svg` (IMG `data-pal="face"`, alt "") and no
  "Pal" text; its aria-label "Open Pal chats" names Pal; legible in light and dark.
- B2: while the tour is open, `tour.js` sets body `data-tour-target` to the current step's target selector ("" for
  target-less steps) and removes it on Skip, Escape or finish; Replay sets it again.
- B3: while `data-tour-target` is present and is not `.pal-bubble`, the bubble ignores click, Enter, arrow-key moves
  and drags (handler guard plus CSS `pointer-events: none`) and carries `aria-disabled="true"`; a step targeting
  `.pal-bubble` leaves it live. After the tour ends the bubble works again.

Tests: static/pal_bubble_face_tour.test.mjs, static/tour_bubble_signal.test.mjs
## MEM-130 Sticker drag-snap with explicit regen
## MEM-131 Sticker drag-snap with explicit regen

Amends MEM-117 (tour house step) and MEM-045 (photo board). Kev ask 2026-11-04: "and also we should have as ux ui
friendl as possible for the sticker regen process - i didnt know it would regenerate imediately when i was clickin on
it since iw anted to drag it around on the picture, it should snap to the parts that are segmented and would associate
in that hitbox of that segmented object"
Root problem: a tap on a sticker re-rolled it at once, so a user reaching to drag it lost the sticker; nothing let them
move a sticker onto another segmented spot.
Actors: the user; `static/sticker_drag.js` (new, shared drag + snap); `static/tour.js` house step; `static/index.html`
(`#tour-roll`, `#tour-roll-undo`); `static/sticker_board.js` photo board.
NFR: pointer events only (touch, mouse, pen), never `click`; keyboard parity; every change undoable; textContent only,
no innerHTML; ASCII only.
Decided-by: ADR-0078
- `sticker_drag.js`: `DRAG_SLOP_PX = 6`; `boxDistance(point, box)` -> 0 inside, else distance to the nearest edge;
  `nearestBox(point, boxes)` -> index of the smallest box containing the point, else the nearest edge; ties go to the
  lower index; malformed boxes skipped; no usable box -> -1.
- `wireDrag`: pointerdown arms; a move past `DRAG_SLOP_PX` starts a drag; pointerup ends in a drop (dragging) or a
  tap (not); pointercancel cancels with no change; never listens for `click`.
- Tour house step (`static/tour.js`): click, tap, Enter or Space on a `g.tour-sticker` selects it (`is-selected`,
  `aria-pressed="true"`) and never regenerates; aria-label "Sticker on <spot>". A drag drops on the `nearestBox` spot
  and swaps sticker and item with it; arrow keys swap the selected sticker with its neighbour.
- `#tour-roll` ("New sticker") re-rolls the selected sticker, or all when none is selected; `#tour-roll-undo`
  ("Undo") undoes the latest New sticker or move; replay clears the selection and undo history.
- `STEPS[2].after`: "I break each item into keywords and mash their emoji into one sticker. Drag a sticker onto
  another spot, or tap New sticker for a fresh one."
- Photo board (`static/sticker_board.js`): each `.sticker` face carries `data-n`, `pointer-events: auto`,
  `touch-action: none`. A drop snaps to the `nearestBox` locus box (the segmented hitbox) and moves the placement
  there, swapping with any placement already on it; one undo entry; `#sticker-toast` reads `Moved "<desc>" to
  <label>.`; `#sticker-undo` restores. A tap never touches the pool.
- Accept: a tap selects and never re-rolls; a move under 6 px stays a tap; pointercancel leaves state unchanged; a
  drop outside every box snaps to the nearest edge; New sticker re-rolls only the selection (all when none); Undo
  restores the prior stickers and items; a photo drop moves or swaps the placement, toasts, and Undo restores it.

Tests: static/sticker_drag.test.mjs, plus updated tour and markup tests, tagged `// Covers: MEM-131`
## MEM-135 Remove the next-turn direction cue

Source: Kev, 2026-11-04: "also the next turn stuff - not sure why the user would need that when they can see it on the
map themselves, and depending on the way they're facing they would have a different direction". A removal with no
approach choice, so no ADR. Supersedes the turn group of MEM-050 and the turn cue of MEM-051 practice (spec-3.md).
Decided-by: none
Root problem: a Left/Right/Straight/Arrive cue is relative to the walker's facing, so it is wrong whenever they face
another way, and the route map already draws the route.
Actors: the walker; `static/station_card.js` (`TAP_GROUPS`, `TAP_GROUP_LABELS`, `tapSummary`); `static/route_view.js`
S5 `#route-view-stations` rows.
NFR: no data migration; stored routes keep loading; ASCII only.
- The station card has no `#tap-turn` group and no "Next turn" heading.
- `TAP_GROUPS` / `TAP_GROUP_LABELS` (`static/station_card.js`) have no `turn` key, so `tapSummary` lists no turn line.
- `static/route_view.js` renders no " then <turn>" span in the S5 `#route-view-stations` rows.
- A stored legacy `station.taps.turn` still loads harmlessly: ignored, not rendered. Backup export/import and
  landmark_facts already allowlist only sound/smell/feel/mood.
- Route geometry, map markers and the route map are unchanged.
- Accept: no next-turn element on the route view; the map still renders one node per station.

Tests: static/no_next_turn.test.mjs
## MEM-114 Routes empty-state map, call to action and slogan

Amends MEM-088 (`#map-empty` notice) and MEM-074 (real map loader).
Decided-by: ADR-0074
Root problem: a zero-route Routes tab showed a blank sketch box with a text notice; Load demo / Map a new route lived
only inside the closed "Route settings" drawer; the app slogan appeared nowhere.
Actors: `static/routes_empty_map.js` (`createEmptyMap`, `EMPTY_MAP_CENTER`, `EMPTY_MAP_ZOOM`, `SLOGAN`);
`static/real_map.js` (loader `mountAt(svg, center, zoom)`); `static/route_view.js` (`renderHome`);
`static/index.html` (`#empty-slogan`); `static/style.css`.
NFR: no network tiles beyond the bundled extract; ASCII; text via `textContent`.
Source: Kev 2026-11-04, "why isnt the routes showing anything, shouldnt it have some sort of default location, maybe
the main meta office or something"; "should we have the slogan somewhere - find a home for every memory".
- Zero routes: the real-map loader runs `mountAt(#route-map, EMPTY_MAP_CENTER {lat 42.3664, lon -71.0832} Kendall
  Square, zoom 15)`, which fetches the self-hosted extract (no station overlay). A center outside `REAL_MAP_BBOX`
  resolves null with no Map. A later station mount on the same svg removes it.
- A `.empty-map-cta` card in `.map-wrap` carries the slogan "Find a home for every memory" and two buttons, Load demo
  (`data-action` `empty-load-demo`) and Map a new route (`empty-new-route`), which click the drawer's `#load-demo` /
  `#routes-new` (one copy of their handlers). Visible without opening the drawer. It stands in for `#map-empty`
  (hidden on show; `#map-empty` stays in the markup as the pre-boot notice).
- `show()` is idempotent. Once any route exists the CTA is removed and no `mountAt` runs.
- A loader without `mountAt`, or a `mountAt` that rejects, still shows the CTA with no unhandled rejection.
- `#empty-slogan` "Find a home for every memory" is the next sibling after Pal's `#empty-state`, visible in the
  markup, hidden once a route exists.

Tests: static/routes_empty_map.test.mjs, static/real_map_mount_at.test.mjs, static/app_routes_empty_map.test.mjs,
static/index_markup.test.mjs (MEM-114 describe), static/app_route_new_flow.test.mjs (`#map-empty` gives way to the CTA)
