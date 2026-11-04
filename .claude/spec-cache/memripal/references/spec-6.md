# MemriPal spec (continuation)

Continuation of [spec-4.md](spec-4.md), which is at its 500-line cap. spec-5.md is held by in-flight branches
(mem088-wire, gcp-deploy-harden); this file takes the next free name so the two never collide.

## MEM-097 Copilot tool dispatcher: per-tool allow/ask/off, every action undoable (PLANNED)

PLANNED, not built. Item 21 "Memri copilot".
ADR [0058](../../../../docs/decisions/0058-memri-copilot-street-photo-scenes.md).
Decided-by: ADR-0058
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

PLANNED, not built. Item 21. ADR [0058](../../../../docs/decisions/0058-memri-copilot-street-photo-scenes.md)
(amends map-to-palace D1); server core MEM-053 (spec-3.md).
Decided-by: ADR-0058
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

## MEM-099 Copilot placement: Messenger-style Pal chat bubble with on-device chats (PLANNED)

PLANNED, not built. Item 21. ADR [0058](../../../../docs/decisions/0058-memri-copilot-street-photo-scenes.md)
(amendment 2026-11-03: chat bubble). Kev asked for a Messenger-style bubble, draggable, with multiple user-managed
chats kept in the on-device SQLite db and carried by export/import.
Decided-by: ADR-0058
Root problem: the copilot must be reachable from every screen, not one tab, and its chats are user data that must
stay on the device and travel with the palace backup.
Actors: the user; new `static/pal_bubble.js` + `static/pal_bubble.css` (self-mounting DOM); new
`static/chat_store.js`; `static/db/schema.js` (migration V2); `static/db/worker.js` (opfs-sahpool);
`static/palace_export.js`; one `<script type="module">` line in `static/index.html`. <!-- claim-exempt: planned -->
NFR: no server storage of chats; CSP unchanged; ASCII only; touch, mouse and keyboard all work; the only S6 hot-file
edit is the mount line, landed after MEM-088.
- B1: the bubble shows on every screen; tap, click or Enter opens the panel; an outside click or Esc collapses it;
  reopening resumes the same chat.
- B2: pointer-event drag (touch and mouse); the bubble stays where dropped, clamped to the viewport and re-clamped on
  resize; arrow keys move it; its position persists across reloads; a drag never opens it.
- B3: `chats` and `chat_messages` tables arrive in migration V2; soft delete via `deleted_at`; rows are never
  hard-deleted.
- B4: list, switch, new, rename and delete chats; delete is a click plus a confirm, always followed by an Undo that
  revives the row.
- B5: `buildBackup` writes `chats[]` as backup `v: 3`; `importBackup` accepts v2 (no chats) and v3; chats are rebuilt
  through an allow-list with caps (chat count, messages per chat, text length, role enum, ids); an invalid chat is
  skipped with 0 partial writes; a stored id counts as present.
- Accept: the bubble is on every tab; outside click and Esc collapse it and reopening resumes the chat; drag clamps
  at all 4 edges, survives a reload and is keyboard-movable; V2 migrates a V1 db with routes intact; delete confirm
  plus Undo restores the chat; export then import round-trips chats; a v2 file still imports; a hostile `chats[]` is
  rejected or skipped with 0 partial writes.
