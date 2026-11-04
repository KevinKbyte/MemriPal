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

## MEM-115 Pal chat history is a sidenav; title is text; actions are icons

Kev ask (2026-11-04): "the palchat "new chat" chat title looks like a button that shouldnt be there - shouldnt it be
similar to copilot/claude, as a message sidenav in the chat rather than looking like a new chat/rename/delete button?
and we can use icon for delete to make it less cluttered". Restyles the MEM-099/MEM-116 header; follows the
Copilot/Claude pattern with no competing approach, so no ADR.
Root problem: the header showed the chat title beside a row of New/Rename/Delete text buttons and the chat list as
buttons, so the title read as a control and the panel looked cluttered.
Actors: `static/pal_bubble.js` mountPalBubble header, render, delete flow; `static/pal_bubble.css` `.pal-panel` rules.
NFR: DOM via textContent/createElementNS only (no innerHTML); ASCII-only source bytes; every icon button has an
`aria-label`; launcher, drag, composer and MEM-116 behaviour untouched.
- B1: no `.pal-actions` element; the header row is a sidenav toggle icon button (`data-pal=sidenav-toggle`,
  `aria-label="Chats"`, `aria-expanded`), the chat title as plain `h2` text, and a new-chat icon button
  (`data-pal=new`, `aria-label="New chat"`).
- B2: a `nav.pal-sidenav` (`data-pal=sidenav`, `aria-label="Chat history"`) lists chats as full-width text rows
  (`button[data-pal-chat]`, active row `.pal-chat-active`).
- B3: only the active row carries a rename icon (`data-pal=rename`, `aria-label="Rename chat"`) and a delete icon
  (`data-pal=delete`, `aria-label="Delete chat"`); exactly one of each in the DOM.
- B4: delete still needs the confirm step and then offers Undo (`rules.global/ui-delete-needs-confirmation.md`);
  the confirm row sits in the sidenav, the Undo toast above the composer.
- B5: viewport >= 720 px shows the sidenav as a persistent left column and hides the toggle; narrower, the sidenav is
  a drawer toggled by panel class `pal-sidenav-open`, and picking a chat closes it.
- Accept: no div.pal-actions; title is h2 text; new chat is an icon button with aria-label; sidenav lists chats as
  rows; delete is an icon on the active row; delete still needs confirm and offers Undo; narrow viewport toggles the
  drawer, wide shows the column. 375 px and desktop screenshots (drawer open and closed).

Tests: static/pal_sidenav.test.mjs

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
the main meta office or something"; "should we have the slogan somewhere - find a home for every memory"; final
slogan (Kev ~14:50 ET 2026-11-03): "Make what's important unforgettable".
- Zero routes: the real-map loader runs `mountAt(#route-map, EMPTY_MAP_CENTER {lat 42.3664, lon -71.0832} Kendall
  Square, zoom 15)`, which fetches the self-hosted extract (no station overlay). A center outside `REAL_MAP_BBOX`
  resolves null with no Map. A later station mount on the same svg removes it.
- A `.empty-map-cta` card in `.map-wrap` carries the slogan "Make what's important unforgettable" and two buttons, Load
  demo (`data-action` `empty-load-demo`) and Map a new route (`empty-new-route`), which click the drawer's `#load-demo` /
  `#routes-new` (one copy of their handlers). Visible without opening the drawer. It stands in for `#map-empty`
  (hidden on show; `#map-empty` stays in the markup as the pre-boot notice).
- `show()` is idempotent. Once any route exists the CTA is removed and no `mountAt` runs.
- A loader without `mountAt`, or a `mountAt` that rejects, still shows the CTA with no unhandled rejection.
- `#empty-slogan` "Make what's important unforgettable" is the next sibling after Pal's `#empty-state`, visible in the
  markup, hidden once a route exists.

Tests: static/routes_empty_map.test.mjs, static/real_map_mount_at.test.mjs, static/app_routes_empty_map.test.mjs,
static/index_markup.test.mjs (MEM-114 describe), static/app_route_new_flow.test.mjs (`#map-empty` gives way to the CTA)
## MEM-132 Pal chat creates a walking route

Kev ask: "is the chat also done and validated so that it can create automated routes, if you have E2E tests saved for
the repo".
Root problem: the Pal chat is local-only (no `reply` dep at selfMount) and the copilot dispatcher (`copilot_dispatch.js`)
is a library wired nowhere, so typing "route from X to Y" does nothing.
Actors: `static/chat_route.js` (new); `static/route_plan.js` (new, pure `planRoute`); `static/route_new.js` (MEM-088,
now calls `planRoute`); `static/copilot_bridge.js` (new); `static/pal_bubble.js`; `static/flow.js`.
NFR: deterministic, client-side, no server or LLM call; textContent only; never throws into the chat; ASCII.
Decided-by: ADR-0079
- `parseRouteIntent(text)` -> `{from, to}` or null. Matches, case-insensitive, optional leading "please"/trailing
  punctuation: "route from X to Y", "walk from X to Y", "directions from X to Y", "take me from X to Y",
  "walking route from X to Y". X and Y trimmed, non-empty; the last " to " splits them. Anything else, non-string or
  blank -> null.
- `planRoute(fromPhrase, toPhrase, {graph, pois})` -> `{ok: true, from, to, stations, name, walk}` or
  `{ok: false, text}`; the MEM-088 Find core (geocode both, `route`, `candidates`, `pickStations`, name
  "`From to To`" cut to 40). Blank phrase or geocode miss -> `ok: false` with `missText` (names suggestions, never a raw
  error). `route_new.js` find() calls it; MEM-088 behavior unchanged.
- `createRouteTool({routes, load, newId})` -> copilot tool `{name: "create_route", run({from, to})}`: loads graph +
  POIs via `load()`, `planRoute`, then `routes.seedRoute({id, name, kind: "daily", stations})`; result
  `{ok, id, name, text}`; inverse removes that route (undo). Plan miss -> `{ok: false, text}`, no route written, no
  inverse.
- `createChatRouteActor({dispatcher, onCreated})`: `act(text)` -> null for non-route text; else dispatches
  `create_route` and resolves a reply string: created -> "Made your route NAME with N stops. It's on the Routes tab."
  then `onCreated(id)`; miss -> the plan text; dispatcher refusal or throw -> "I couldn't make that route. Try again."
- `copilot_bridge.js`: module singleton `setActor(actor)` / `getActor()` (null until set).
- `pal_bubble.js`: `mountPalBubble` gains optional `act(text)`; on send, a non-null `act` reply is appended as the Pal
  message and `reply` is not called; null falls through to `reply` as before. selfMount passes
  `act: (t) => getActor()?.act(t) ?? null`.
- `flow.js` after routeView: dispatcher with policy `{create_route: "allow"}`, the route tool, an undo stack;
  `onCreated(id)` -> `renderHome()` then `openRoute(id)`; `setActor(...)`.
- Accept: typing "route from Kendall T to Meta office" in the Pal composer adds a route card on the Routes tab and the
  Pal reply names it; "hello" is untouched by `act`; an unmapped place gets the demo-area miss text; undo removes the
  created route. Covered by static/chat_route.test.mjs, static/pal_bubble.test.mjs, E2E step `chat_route`.
- Out of scope: LLM tool-calling (ADR 0079); typeahead (MEM-126, unmerged); places outside the mapped Kendall area.

## MEM-133 Curated demo routes from the route pipeline

Kev ask: "rather than throwing out the results from those E2E tests, we can use those as examples to populate the app
with multiple routes - choosing the best routes that peopel would relate to on this map".
Root problem: Load demo seeds one route, so the Routes tab shows little; the planner already makes good relatable
routes that are thrown away.
Actors: `scripts/gen_demo_routes.mjs` (new); `static/data/demo_routes.json` (generated, committed);
`static/demo_route.js` `PRINCIPLES_ROUTE`; `static/flow.js` Load demo.
NFR: generator deterministic (same data -> byte-identical JSON); fixed ids; no network; ASCII.
Decided-by: ADR-0079
- `scripts/gen_demo_routes.mjs` runs `planRoute` over curated pairs on the committed graph + POIs and writes
  `static/data/demo_routes.json`: `[{id, name, kind: "daily", stations}]`, ids `demo-route-commute`,
  `demo-route-coffee`, `demo-route-landmarks`.
- Routes: "Morning commute to the T" (Meta office -> Kendall T); "Coffee run" (Meta office -> a cafe POI); "Landmark
  loop" (landmark POIs as stations sorted counter-clockwise by angle around their centroid: a simple polygon, no two
  segments cross).
- Load demo seeds them alongside DEMO_ROUTE and PRINCIPLES_ROUTE; seeding is idempotent by id (a second Load demo
  adds no duplicate); a 404 or rejected `demo_routes.json` fetch seeds DEMO_ROUTE and PRINCIPLES_ROUTE only. Load
  demo still opens DEMO_ROUTE.
- Default route `PRINCIPLES_ROUTE`, a separate route exported from `static/demo_route.js` beside DEMO_ROUTE (id
  `demo-route-principles`, "Six principles of engaging speaking", kind "daily"): 6 stations, ids distinct from
  DEMO_ROUTE's, whose `profile.conceptual` starts Relevance, Curiosity, Clarity, Concreteness, Progression, Payoff
  in walking order. Defined in code, not only in `demo_routes.json`, so Load demo always seeds it (JSON served,
  404 or rejected). Kev: "in the end the code can
  have the default route with the learning points that we had added - the 6 principles for engagement so that users
  can see that as a solid starting point".
- Accept: after Load demo the Routes tab lists >= 3 routes incl. the fixed ids; no two non-adjacent station segments
  of any route cross; the landmark loop's signed area > 0 (CCW); regenerating yields identical JSON. Covered by
  static/demo_routes_seed.test.mjs, static/demo_principles_route.test.mjs, scripts/gen_demo_routes.test.mjs.
- Out of scope: user-editable curated routes; places outside the mapped Kendall area.
## MEM-138 Pal face centred in the bubble

Source: Kev, 2026-11-04: "also why isnt memri centered on the bubble". A bugfix with no approach choice, so no ADR.
Amends MEM-055 B1.
Decided-by: none
Root problem: `static/style.css` global `img, canvas { max-width: 100%; height: auto }` clamped the absolutely
positioned `.pal-bubble-face` (`static/pal_bubble.css`) to the bubble's 50px padding box, so the head sat about 17px
left of centre.
Actors: the user; `static/pal_bubble.css`; `static/style.css`; `static/assets/pal-still.svg`.
NFR: CSS only; no change to the global img rule for other images; ASCII only.
- `.pal-bubble-face` declares `max-width: none` and renders 84x84.
- Offsets `left: calc(50% - 42px); top: calc(50% - 36.5px)` place the `pal-still.svg` head centre (viewBox 256,222.5
  of 512) at the disc padding-box centre.
- Accept: at 375 and 1280 px viewports the face is 84x84 (+-0.5) and the head centre is within 1px of the disc centre.

Tests: tests/test_pal_bubble_face_centre.py, static/pal_bubble_face_tour.test.mjs
## MEM-137 Demo route text has no facing-dependent directions

Source: Kev, 2026-11-04 (on the next-turn cue): "not sure why the user would need that when they can see it on the
map themselves, and depending on the way they're facing they would have a different direction". MEM-135 removed the
next-turn UI; this drops the same kind of cue from the seeded demo text. A text rewrite with no approach choice, so no
ADR. MEM-136 was taken on another branch.
Decided-by: none
Root problem: "bear left", "turn right", "on your right", "walk east" are relative to the walker's facing, so the
demo text is wrong whenever they face another way, and the route map already draws the route.
Actors: `static/demo_route.js` `DEMO_ROUTE`; `docs/design/map/preview.js` STATIONS titles (station names mirror them).
NFR: ASCII only; station ids, coords, addresses, emoji and taps unchanged.
- No `DEMO_ROUTE` route name, station name, or station cue text (profile visual/spatial/conceptual, tap values)
  matches `/\b(left|right|bear|turn(s|ed)?|east|west|north|south)\b/i`.
- Station names still equal the preview.js titles, stay <= 100 chars, first starts "Kendall/MIT station", last
  starts "Meta office, 100 Binney St".
- Accept: the demo route shows landmarks only; no facing-dependent direction words anywhere in its text.

Tests: static/demo_route_no_directions.test.mjs
## MEM-134 Emoji tags replace the sense quick-taps

ADR [0080](../../../../docs/decisions/0080-emoji-tags-replace-sense-taps.md). Amends MEM-110 and ADR 0063 (card
display of the sound/smell/feel/mood taps); `taps` storage unchanged.
Decided-by: ADR-0080
Root problem: Kev ask 2026-11-04: "can we just have emojis, so that itll be compact and also user gets more choices -
they can search through for the right emoji, though muse can power the initial auto generation based on the context,
and user can change it to however they like afterward". The fixed sense taps (birds, traffic, water, ...) are bulky
and offer few choices.
Actors: `static/emoji_data.js` (new), `static/emoji_tags.js` (new), `static/route_store.js`,
`static/backup_routes.js`, `static/station_card.js`, `static/index.html`; the user editing a station card.
NFR: ASCII-only source (emoji as `\u{...}` escapes); deterministic, no network call; no data loss (`taps` kept);
every delete needs arm + confirm + Undo; fits 375px with no horizontal scroll; chips >= 44px.
- Data: station gains `emojis: string[]` (0..`MAX_EMOJIS`=6, unique, non-empty, <= 16 UTF-16 units) and
  `emojisEdited: boolean` (true once the user adds or removes one). `taps` and `TAP_GROUPS` unchanged; `associate.py`,
  backup and `landmark_facts` keep reading `taps`. The card drops the sound/smell/feel/mood grids; the turn grid stays.
- `emoji_data.js`: frozen `EMOJI` of `{ e, name, keywords }`, >= 120 entries (sounds, smells, food, weather/feel,
  moods, nature, animals, buildings, transport, objects), lower-case words; covers every `TAP_EMOJI` glyph; name
  "bird" -> U+1F426.
- `searchEmoji(query, list = EMOJI, limit = 48)`: trimmed, lower-cased, non-string -> ""; "" -> first `limit`. Match:
  name, a name word or a keyword starts with q. Rank: exact name, name prefix, other; stable within a rank. Never
  throws.
- `TAP_EMOJI`: legacy tap label -> emoji for every sense value except smell "None"; required traffic U+1F697, birds
  U+1F426, water U+1F4A7, voices U+1F5E3 U+FE0F, quiet U+1F92B, music U+1F3B5, coffee U+2615, rain U+1F327 U+FE0F,
  calm U+1F60C. `migrateTaps(taps)`: sound, smell, feel, mood in that order, case-insensitive; unknown, None and turn
  skipped; deduped; null/undefined -> [].
- `museEmojis(station)` (1..6): deterministic keyword match over the Muse-made context (name,
  `profile.visual/spatial/conceptual`, category): the `landmark_emoji.js` `emojiFor` glyph unless `EMOJI_DEFAULT`,
  then `EMOJI` entries whose name or a keyword appears as a whole word (optional s/es plural), in first-appearance
  order; deduped, capped; no match -> `[EMOJI_DEFAULT]`.
- `startingEmojis(station)`: `emojisEdited === true` with an array -> copy of stored `emojis` (a user edit wins over
  any regeneration); else `normalizeEmojis([...migrateTaps(taps), ...museEmojis(station)])`. `normalizeEmojis`:
  trimmed non-empty strings <= 16 units, deduped, capped; non-array -> [].
- `setStationEmojis(routeId, stationId, emojis, { edited = true } = {})`: stores `normalizeEmojis(emojis)`;
  `emojisEdited = edited || prior true` (an auto save never clears a user edit); serial + persist like
  `setStationTaps`. Import/restore paths that copy `taps` also copy both fields.
- Backup: `STATION_KEYS` gains `emojis`, `emojisEdited`; export writes them when present; import validates (strings
  per `normalizeEmojis`; boolean) and refuses other types in the existing error style; round-trip kept.
- Card: `ul#station-emojis.emoji-row` (aria-label "Senses at this spot") of `li > button.emoji-chip` (aria-label =
  entry name or the emoji); `button#emoji-add` "+" (aria-label "Add an emoji", disabled at `MAX_EMOJIS`); hidden
  `button#emoji-remove`, `button#emoji-undo` "Undo", and `div#emoji-picker` holding `input#emoji-search` (type
  search, aria-label "Search emojis") and `div#emoji-results` of `button.emoji-pick`.
- `show()`: when not user-edited and stored `emojis` differ, persists `startingEmojis` once with `{ edited: false }`.
  Add toggles the picker; input re-renders `searchEmoji` results; a pick appends (if absent, < 6) and saves edited.
  Chip click arms it (aria-pressed "true") and shows `#emoji-remove` "Remove <emoji>"; confirm removes, saves
  edited, shows Undo; Undo restores the prior list, saves edited, hides itself.
- `#station-tap-summary`: turn lines only; the sense lines are replaced by the emoji row.
- Accept: `searchEmoji("bird")[0].e` is U+1F426, `searchEmoji("")` has 48, "BIRD" equals "bird"; `museEmojis` for a
  profile with "coffee" and "trees" includes U+2615 and a tree, never []; an edited station keeps its emojis through
  `startingEmojis` and card show; `migrateTaps({sound:"Birds",smell:"Coffee",feel:"Warm",mood:"Calm",turn:"Left"})`
  starts [U+1F426, U+2615], contains U+1F60C, no turn glyph, and stored `taps` are unchanged after show; add
  persists edited; remove needs arm + confirm; Undo restores; backup round-trips, bad types refused; 375px
  screenshot shows chip row and picker with no horizontal scroll.
- Out of scope: a live Spark call per station for auto-fill (ADR 0080 option B, follow-up).

Tests: static/emoji_tags.test.mjs, static/station_card_emoji.test.mjs
## MEM-139 Legacy turn taps dropped when generating landmark connections

Source: follow-up held out of MEM-137, 2026-11-04. A bug fix with no approach choice, so no ADR.
Decided-by: none
Root problem: stations stored before MEM-135 (next-turn UI removed) can still carry `taps.turn`; `defaultGenerate` in
`static/landmark_facts.js` copied taps verbatim, so `createConnectionStore().generate()` threw `Unknown tap "turn"`.
Actors: `static/landmark_facts.js` `defaultGenerate`; `createConnectionStore().generate`.
NFR: never delete stored user data: the input station (and its stored record) keeps its `taps.turn`; only the
generated connections omit it. ASCII only.
- Generated connections carry only the MEM-135 tap keys (sound, smell, feel, mood).
- Unknown/legacy tap keys are dropped at generation; valid taps are kept.
- Generation does not mutate the input station.
- An explicit edit patch with `turn` is still rejected by validation.
- Accept: generating connections for a station with legacy `taps.turn` succeeds and stores no `turn`.

Tests: static/landmark_facts_legacy_turn.test.mjs

## MEM-136 Central Meta spend counter (Firestore)

Amends MEM-094 (its "survives a server restart" NFR: `/tmp` on Cloud Run, ADR 0069, did not) and ADR 0069.
Decided-by: ADR-0081
Root problem: the spend estimate lived in `spent.json` on the instance's in-memory `/tmp`, so a restart or new
instance reset it to 0 and the cap could be crossed again, billing past the $150 Meta credit. Kev, 2026-11-04: "can
the recording of how many credits are used (145$) be in a central database in gcp like redis, so that if the instance
goes down we dont have it reset the limit and then have it go over budget" / "and if it cannot reach the database
it'll count as it reaching the limit".
Actors: the server's Meta call sites (via `MetaSpendGuard`); Firestore; Kev (seed, deploy); BYOK users (MEM-122).
NFR: concurrent instances can never jointly exceed the cap; building the guard never touches the network; fail closed;
cap unchanged (`MEMRIPAL_META_SPEND_CAP_USD`, default 135).
1. Store: `MetaSpendGuard` takes a pluggable store. `FileSpendStore` = the unchanged `spent.json`;
   `FirestoreSpendStore` = one doc, field `spent_usd`.
2. Selection: `MEMRIPAL_META_SPEND_STORE=file|firestore`, default `file`; any other value fails startup. Doc path
   `MEMRIPAL_META_SPEND_FIRESTORE_DOC`, default `memripal/meta-spend`; `GOOGLE_CLOUD_PROJECT` optional.
3. Lazy client: constructing the guard or the Firestore store makes no network call.
4. Charge: one Firestore transaction reads `spent_usd`, checks `spent + cost <= cap`, and writes, atomically;
   contention retries optimistically. A charge past the cap raises `MetaSpendCapReached`.
5. Fail closed: any store error, a 5 s timeout, an auth failure, a missing doc or invalid data raises
   `MetaSpendCapReached`; nothing is sent. Chat then uses the Baseten/Fireworks backup; other calls degrade per
   MEM-121, unchanged.
6. Seed: a missing doc is refused, never read as 0. `scripts/seed_meta_spend.py --usd N [--doc PATH] [--project P]`
   sets `spent_usd = max(existing, N)`: never lowers it, and refuses to overwrite invalid data.
7. BYOK per-key guards and dev/fixture mode stay on `FileSpendStore` (BYOK spends the user's own key, not our credit).
8. Deploy: `scripts/deploy_cloud_run.sh` with `MODE=meta` sets `MEMRIPAL_META_SPEND_STORE=firestore` and grants the
   runtime service account `roles/datastore.user` (project level, idempotent); fixture mode sets neither.
- Accept: a store with spend near the cap refuses the charge that would cross it; two racing charges never jointly
  exceed it; an unreachable, timed-out, unauthorized, missing or invalid store refuses with nothing sent; the seed
  script never lowers the value; an unknown `MEMRIPAL_META_SPEND_STORE` fails startup; the meta deploy sets the env
  var and the grant.

Tests: tests/test_meta_spend_store.py, tests/test_deploy_artifacts.py
## MEM-056 Readable royal shopping list
## MEM-140 Readable royal shopping list

Source: Kev, 2026-11-04, critique of Pal's tour step 3 list: "hard to read, very cluttered ... as well as small".
A readability fix with no approach choice, so no ADR.
Decided-by: none
Root problem: the step 3 "My Royal Shopping List" list is small, cramped and low-contrast on a phone, and the
house-step story card runs off the screen.
Actors: the walker on a 375x812 phone; Pal's tour step 3 list and house-step story card; `static/style.css`.
NFR: keeps the Paper Crown look (numbered badges, emoji composite); ASCII only.
- Item rows: font-size >= 17px, line-height >= 1.5.
- Keyword caption, spot label and sub-list rows: >= 16px in the body face, not mono.
- House-step rows padded >= 0.5rem block; list gap >= 0.5rem.
- `--ink` / `--muted` on `--lamp-soft` / `--surface` contrast >= 4.5:1 in light and dark.
- The house-step story card has a max-height and scrolls (`overflow-y: auto`) instead of leaving the screen.
- Accept: at 375x812 every rule above holds; numbered badges and the emoji composite still render.

Tests: static/tour_list_readable.test.mjs
## MEM-127 Landmarks tab: photo gallery with name typeahead, multi-route and candidate filters

Decided-by: ADR-0083
Root problem: the Landmarks tab was a bare list of the open route's stations; the user needs to browse every
landmark across all routes as photos, find one by name, and narrow to one or more routes or to a route's
auto-loci candidates.
Actors: the user; `static/landmark_gallery.js` (+ `static/landmark_gallery.css`); `static/flow.js` (mount with
`deps.routes`); `static/index.html` `#tab-landmarks`; `static/list_filter.js` (`filterItems`, MEM-124);
`static/auto_loci.js` (`candidates`); `/static/data/kendall_pois.json`.
NFR: ASCII only; CSP unchanged; no new network calls beyond the one POI fetch; `ol#landmarks-list` stays in the DOM
(hidden) for `static/route_view.js`.
- G1 `galleryItems(routes)`: one item per landmark across all routes -> {key, name, emoji, photo_ref|null,
  osm_id|null, candidate:false, routes:[id], routeNames:[name], station}; dedupe by osm_id, else normalized name; a
  nameless station with no osm_id is its own "Untitled landmark"; routes union in first-seen order; photo_ref is the
  first non-empty; emoji = station.emoji || emojiFor({name}).
- G2 `candidateItems(routes, pois)`: for each route with >= 2 coord stations, auto_loci `candidates`; the same key
  across routes merges routes; osm_ids that are stations on ANY route are excluded.
- G3 `filterGallery(items, {query, routeIds})`: name query AND (routeIds empty or item on any selected route).
- G4 `createLandmarkGallery({doc, routes, loadPois, onOpen, getPhotoUrl})` -> {refresh()}; refresh re-reads
  `routes.listRoutes()`. Markup: `input#landmarks-search` (label[for]); `input#landmarks-route-input`
  list=`landmarks-route-options` (label[for], inside a `.field` wrapper) + `datalist#landmarks-route-options` of
  unselected route names; an exact case-insensitive name match adds a chip and clears the input;
  `ul#landmarks-route-chips` li>button.lg-chip aria-label "Remove route <name>" removes it; radios
  name=landmarks-show, ids `landmarks-show-on-routes` (checked) and `landmarks-show-candidates`, applied on change;
  `p#landmarks-count` role=status "<n> landmark(s)" / "<n> candidate(s)"; `ul#landmarks-grid`
  li>button.lg-tile(+.lg-candidate)>span.lg-thumb (img alt="" or emoji) + span.lg-name + span.lg-meta (route names
  joined ", " / "Candidate - <names>"); tile click -> onOpen(item); `p#landmarks-empty.lg-empty` hidden when tiles
  show, else "No landmarks yet. Build a route to add some." | "Pick a route to see its candidates." | "No landmarks
  match."; index.html links `/static/landmark_gallery.css`.
- G5 flow wiring: getPhotoUrl = routes.getPhoto(ref) -> object URL cached per ref; loadPois fetches
  kendall_pois.json once; refresh on tab click and on hashchange to #landmarks.
- Accept: grid shows photo + name per landmark; typing a name narrows the grid; two selected routes show the union;
  Candidates shows the selected routes' candidates; `sh scripts/check.sh` green.

Tests: static/landmark_gallery.test.mjs, static/index_markup_landmarks.test.mjs, static/index_ids_test.mjs,
static/index_markup.test.mjs
## MEM-143 Landmark gallery tile opens a detail dialog

Source: Kev, 2026-11-04: "we should be able to click into the landmark for more details". Fills the MEM-127 G4
`onOpen(item)` hook (a no-op in `mountLandmarkGallery`); delivers MEM-120 phase B "facts bullets in the landmark
tab". Related but separate: the live-map hover/detail dialog (`landmark_detail.js`) on unmerged branch
`mem-landmark-detail`, numbered MEM-112 there; this is the Landmarks-tab dialog.
Decided-by: ADR-0085
Root problem: a gallery tile shows only photo, name and routes; the user cannot see where a landmark is, its
multisensory connections, or its facts without leaving the tab.
Actors: the user; `static/landmark_gallery_detail.js` (new, pure); `static/landmark_gallery.js`
(`mountLandmarkGallery` onOpen, `getPhotoUrl`); `static/landmark_facts.js` (`factsFor`); `routeView.openRoute`.
NFR: ASCII only; CSP unchanged; no new network calls; all user text via `textContent`; only `http:`/`https:` hrefs;
only `blob:`/`data:image` photo srcs.
- D1 open/close: a tile click, or Enter/Space on it, opens a modal native `<dialog id="landmark-detail">` inside
  `#tab-landmarks`; a Close button and Escape close it; focus returns to the opening tile.
- D2 header: the photo (blob URL from the gallery's `getPhotoUrl`), else the emoji; the name is the dialog heading.
- D3 routes line: "On routes: A, B" for a route landmark; "Candidate for: A" for a candidate.
- D4 location: the street address when present; coordinates at 5 dp plus an "Open in Maps" link
  `https://www.google.com/maps/search/?api=1&query=LAT,LON` (`target="_blank"`, `rel="noopener"`) when coords exist
  (route landmark: `station.coords` {lat, lon}; candidate: `poi` {lat, lng}).
- D5 profile: the station's multisensory `station.profile` key/value entries when present.
- D6 facts: up to 3 fun facts from `factsFor(station.id)`, each with its citation link.
- D7 a route landmark gets one "Open route" button per route; it closes the dialog and calls
  `routeView.openRoute(routeId)`.
- D8 a missing field renders nothing (no empty row or label).
- Accept: clicking a tile opens the dialog with its name; Escape closes and refocuses the tile; a candidate shows
  "Candidate for:" and no Open route button; a `javascript:` URL or non-image photo src is never rendered.

Tests: static/landmark_gallery_detail.test.mjs, static/landmark_gallery_tile_button.test.mjs (regression lock: tile is a native button; click opens #landmark-detail, never a file input)
## MEM-136 Muse Spark grades spoken recall; keyword match stays the floor and fallback

ADR [0080](../../../../docs/decisions/0080-spark-recall-grading-keyword-fallback.md). Extends MEM-031 / ADR 0008, 0026
(deterministic keyword matcher); the matcher is unchanged and remains the whole fallback.
Decided-by: ADR-0080
Root problem: a paraphrased recall ("the bang-bang sky lights" for "fireworks") scores a miss under exact keyword match.
Actors: `src/memripal/recall_grade.py::RecallGrader`, `grader_from_env`; `app.py` POST /recall/audio;
`static/mic_wav.js`, `static/recall_match.js`, `static/recall_live.js`, `static/flow.js`.
NFR: grading never blocks or alters the transcript; any grader failure -> response is exactly `{"text"}`; logs carry
provider name, latency and exception class only, never a provider body (MEM-106); ASCII only.
- Grader: strict json_schema `recall_grade` = `items[]` of `{index:int, verdict: correct|partial|miss, reason:string}`;
  prompt quotes the transcript as data and lists numbered expected labels (fixed server-side from request keywords);
  `max_completion_tokens` = 256 + `REASONING_HEADROOM_TOKENS` (ADR 0077); reason truncated to 120 chars.
- Returns `{"provider", "latency_ms", "items"}` or None on: exception, `ok` False, malformed JSON, index out of range,
  unknown verdict, empty transcript or empty keywords (no call made).
- Providers: configured `MEMRIPAL_CHAT_PROVIDER` when not `meta`, then `chat_fallback_from_env()` when different;
  the server's own Meta key is never used for grading (keeps Meta spend for ASR); first success wins; per-call timeout 8 s (connect 3 s).
- POST /recall/audio: `{"text"}` plus `"grade"` only when the grader returns one.
- Client: got = union of matcher keyword hits and grade `correct` indices; `matcher.gradeGot(i)` marks got (not
  override) at the current token count so in-order counting still works; `partial` never counts as got; the board
  shows a `.grade-tag` pill "Spark - <provider> - <ms> ms" beside the LIVE badge; Done-remainder applies the same.
- Accept: valid grade passes through and lights paraphrase hits; malformed or absent grade leaves keyword scoring
  exactly as before.

Tests: tests/test_recall_grade.py, tests/test_recall_grade_byok.py, tests/test_recall_audio.py, static/recall_grade.test.mjs
- Out of scope: partial credit scoring; grading typed recall.
- Setting (Kev 2026-11-04): Settings tab checkbox `#grade-with-spark` "Grade recall with Spark", persisted in
  localStorage `memripal.gradeWithSpark` (default off); off = ASR + keyword only and the request carries no `grade`
  field, so no grading call is made.
- On + grading failure (spend cap, out of tokens, upstream error, timeout): that answer scores by ASR + keyword; the
  response carries `grade_error: "unavailable"` (never a provider body) and the board shows a dismissible inline
  `.grade-downgrade` notice ("Spark is unavailable ... keyword match") with a link to the existing BYOK key prompt.
- BYOK reuses the MEM-122 visitor Meta key (tab memory only, `X-Memripal-Meta-Key`, never logged): when present the
  grader tries that session's client first, then the configured providers.
