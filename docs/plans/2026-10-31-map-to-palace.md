# MemriPal: map-to-palace plan (v2, finished after adversary round 2 + finisher critique)

Date 2026-10-31. Repo memripal main a082c18 (0.20.1). Deadline Wed Nov 4 2026 9 PM ET (online; demo shows only built
features, hackathon.md:92). Supersedes, for memripal product work, the open product items of
done/memripal-2026-10-30-s2s-handoff.md and items 110-113 of memripal-2026-10-31-s2t-handoff.md (ledger in Part C).
Recon facts with path:line: recon.md (same folder). Adversary reports: adv-*.md (round 1) and adv-*-r2.md (round 2),
same folder; arbitration in Part D (round 1), Part E (round 2) and Part F (finisher critique). Supersedes plan-v1.md
and plan-v1-r2.md.

## Must-keep (user's verbatim asks; never deferred, cut or descoped without the user's explicit ask)
Verbatim product framing (Kev, 2026-10-31): "this would make it less much forgetable considering there are many
important routes in people's day to day plus even routes where they dont use day to day can be mapped there considering
that it is important to know the different routes to get to their local grocery store, or to some good tasting
restaurant that they may want to bring friends to. Rather than having to rely on google maps all the time (which I do),
I bet this app will help me and others be more attentive to their surroundings and rely on google maps less at least
when we are going to destinations that we want to be able to confidently be able to walk the route without having to
pull out google maps. And have memory benefit out of it since there are infinite things to remember, and so we need to
have some good way of storing the important ones".
Verbatim pivot asks (Kev, 2026-10-31, prompt.md): "we are pivoting to the map to memory palace and augmented with
pictures at landmarks from user, and have baseline picture from meta's mapillary" + "where we're letting users map out
important routes and use important routes as memory palaces. so they can have a good reason to memorize these routes as
well as have memory palace augmenting their other learnings/systems in parallel" + "superplan be composed of the design
as well as the implementation portion - so we can send the design to design claude and then you can work on the
implementation" + "you may have to consolidate and then deprecate some parts so that we can have just one plan".

| MK | Ask (from the quotes above) | Where it is built and measured |
|---|---|---|
| MK1 | Many important day-to-day routes (commute, local grocery store) | B3 store + S1 list; B6 crit 11 (3 routes listed) |
| MK2 | Routes NOT used day to day can be mapped too (restaurant to bring friends to) | kind Occasional, mapped by walking it once (B3, B6 crit 11); typed/planned stations without walking = B14 (below the cut, planned; see Q2) |
| MK3 | Walk the route confidently without pulling out Google Maps; more attentive to surroundings | S5 route view + in-order eyes-closed practice (B6) + sensory quick-taps (B5) |
| MK4 | Memory benefit: a good way of storing the important things among infinite ones; palace augments other learnings in parallel | list on route from the user's own notes (B7), scenes, spoken recall lighting dots (B7 crit 10) |
| MK5 | Less forgettable routes | "Learned n/N", practice history, per-station hit rates (B6 crit 7, 12) |
| MK6 | Pictures at landmarks from the user | B3 capture + B4 /station + B5 card |
| MK7 | Baseline picture from Meta's Mapillary | B8, ABOVE the cut in v2 (Part F F1), per-station opt-in, recorded for the demo |
| MK8 | One plan with a design part (for Claude Design) and an implementation part | Part A (design prompt) + Part B (slices) |
| MK9 | Consolidate and deprecate so there is just one plan | Part C ledger |

A scope constraint (station cap, one active list per route, cut line, v2-only backups, per-station Mapillary opt-in) is
not a scope cut of any MK item. No round removed an MK item. v2 moves B8 (MK7) above the cut: round 1 had placed a
verbatim ask below the cut, which is a deferral the user never asked for.

## Scope (step 1)

Product: users map the routes that matter to them (daily: commute, grocery store; occasional: the restaurant they take
friends to), learn each route well enough to walk it without pulling out a nav app, and reuse each route as a memory
palace for one study list at a time. A route = 3-8 ordered stations (typically 6); each station = one locus with the
user's own photo (faces/plates pixelated), a short unique name, an observed profile (Spark) plus the user's sensory
quick-taps, and (opt-in, per station) a baseline street-level photo from Mapillary with its credit line.

Two views are first-class and both appear in the demo:
- Route-learning view (S5 + practice in S8): the route itself, station by station, with turn cues; practice = say the
  stations in order eyes closed, map dots light; a hit counts only in route order.
- List-on-route view (S6, S7, S8): one study list placed on the route's stations; scenes per station; spoken recall
  lights the same dots.

Non-goals: replacing navigation, turn-by-turn directions, safety claims, interaction while moving, points for speed/
distance/streaks, AR, generated video, Google Maps/Street View, basemap tiles, on-device models, any model outside the
hackathon list, v1 (pre-pivot) backup import.

Assumptions (state before code):
- A1 Station coordinates come only from client-side EXIF GPS (opt-in, ADR 0022) or browser geolocation at capture
  (opt-in). GPS is read from the raw File, then the photo is re-encoded (reencodeJpeg, app.js:97, strips EXIF) before
  anything is stored or sent. Coordinates leave the device ONLY through B8 /baseline for a station the user ticked
  (A2); no other endpoint receives them; backups never carry them. With neither source, the map is a schematic ordered
  by capture index.
- A2 Coordinate egress to Mapillary (Meta service) exists only in B8 (above the cut in v2), per-station opt-in, 4 dp,
  consent copy names Meta, with its own ADR. A station without coords cannot request a baseline (button disabled).
- A3 Demo route = a public, non-residential place (same neutral place as B2; Kev picks) WITH Mapillary coverage within
  30 m of >= 3 of its stations (checked by the B8 live probe before K1), 6 stations, early morning, no faces/house
  numbers; committed demo data carries no coordinates (schematic index layout); its baselines are the recorded
  /baseline responses (image, author, link), never re-fetched. Never Kev's own block.
- A4 Existing /split, /associate, /scenes, recall matcher, live lighting, fixture replay, signed records are reused; the
  locus label becomes the station name.
- A5 All 44 live ids stay (recon.md), each exactly once; screens S1-S9 are sections in the one index.html toggled via
  [hidden].
- A6 Station order = capture order; the user fixes order with Up/Down at Finish walk. No timestamp ordering.
- A7 No real v1 backup users exist (v1 came only from the pre-pivot single-palace demo, PALACE_ID "demo").

## Decisions fixed (each lands with its ADR inside its slice; ADR numbers assigned in land order)
- D1 Mapillary baseline (MK7): above the cut (B8). Lean option (a) backend proxy over (b) img-src widening; the ADR
  inside B8 records the choice. Baseline images are display-only: never sent to Muse Image, Spark or SAM (keeps the CC
  BY-SA share-alike duty of ADR 0012 out of generated scenes).
- D2 Scenes pass Muse Image bytes through unchanged + "AI-generated" chip; mime follows the reply format; reported
  width/height stay the photo's (zoomFor works in fractions, scenes.js:42-58, so no box scaling). If the rendered
  image's naturalWidth/naturalHeight aspect differs from the photo's by > 2%, the card uses identity zoom. ADR (amends
  0024).
- D3 Station pipeline, fail-closed: SAM "person" and "license plate" in parallel (raw photo; SAM 3.1 is a Meta model and
  this is disclosed) through a STRICT parser -> deterministic Pillow pixelation (<= 8 blocks across each box's long
  side) -> Spark name+profile+landmark phrase on the pixelated JPEG -> ONE SAM box. Strict = "none found" only for an
  empty/whitespace body or the explicit empty shape recorded by the B4 live probe; non-empty text with 0 box tokens, any
  token _parse_token drops, or any sanitize_box reject -> BlurFailed. Any blur-call failure -> 502 blur_failed, 0
  Spark calls. Blur-phase requests never write the raw photo to the live cache (no put_photo); only the pixelated photo
  may land on disk. ADR.
- D4 Route store: IndexedDB via the existing injected KV adapter (ADR 0021), routes keyed by uuid, palace id =
  `<route_id>/<list_id>`; coords client-side only, <= 4 dp; store caps a route at 8 stations. Pending stations persist
  the re-encoded (EXIF-free, NOT yet pixelated) photo bytes locally until named; pending bytes are never exported or
  rendered outside the capture strip. ADR.
- D5 Reuse rule: one active list per route; retiring the active list frees the route immediately. (Cooldown + intrusion
  counting: below-cut B12 with its ADR.) Spec entry only, no ADR (single option).
- D6 Backup v2 only: routes + lists; NEVER carries coordinates; explicit per-field allowlist; named stations of saved
  routes only (pending stations and drafts are skipped); photos re-encoded to 640 px long side, quality 70 at export;
  a separate MAX_BACKUP_BYTES = 8 MiB replaces the reuse of MAX_IMPORT_BYTES (1 MiB, tied to recall_relay
  MAX_CHUNK_BYTES) for backup export/import. v1 files are refused with "Older backup format, not supported". ADR
  (amends 0028).
- D7 app.py line budget: B0 first moves the module-level body parsers (app.py:184-259) into a new module
  src/memripal/bodies.py (app.py <= 515 after B0); new server routes live in new modules; app.py edits land one slice at
  a time in the order B0 -> B1 -> B4 -> B7 -> B8, each rebased on the previous; cap stays 582.
- D8 Station names <= 3 words, no digits; client sends the route's used names as an avoid-list; name clashes are
  resolved by the user renaming (client check), never by failing the capture.
- D9 Route practice scoring: match target = station name only (turn cue shown, never matched); the post-pass walks
  stations in ROUTE order (n ascending) and counts station k only if it has a match whose span start (transcript token
  index) is greater than the last counted station's span start; when a name matches more than once, the earliest such
  span is used (greedy, deterministic; not a longest-subsequence search). Hits keyed by station id; denominator =
  current station count; hits for ids no longer on the route are ignored. Spec entry (single option).
- D10 Retry: per-station manual Retry only (no online-event auto-retry). Status classes: network error, 5xx incl. 502
  blur_failed, 429 -> pending (retryable); other 4xx -> error with Drop. One request per station in flight (a second
  send is refused). A walk that cannot reach 3 named stations stays a resumable draft.
- D11 Backup import id collisions: a route or list whose id already exists in the store is skipped (never overwritten,
  never duplicated); #backup-status reports "n added, m already present". Spec entry (single option).

---

# PART A: Claude Design prompt (paste as-is)

```
You are designing the new UX for MemriPal, a web app (one HTML page, FastAPI backend) for a hackathon whose demo is a
3-minute video. Your output is handed to an engineer who has ALREADY written the page markup with the ids below and
will only add your CSS and classes. Follow every constraint exactly; a previous design round failed because it shipped
JavaScript, mock data, its own ids and its own markup.

PRODUCT
People rely on a nav app for every walk, so the routes they take never stick. MemriPal lets a person map the routes that
matter to them (daily: commute, grocery store; occasional: the restaurant they bring friends to), learn each route well
enough to walk it confidently without pulling out a map app, and reuse each learned route as a memory palace: one study
list at a time is placed on the route's stations, one item per station. Value 1: the route itself sticks, and the person
pays more attention to their surroundings. Value 2: the same route becomes storage for the important things among the
infinite things to remember. Do not claim the app replaces navigation or makes walking safer. Never use the words
"Pokemon", "game", "points", "streak". No study-chatbot framing.

A route = 3-8 ordered stations (typically 6). A station = one landmark the user chose, with:
- the user's own photo (faces and plates pixelated); optionally, per station and only after the user opts in, a
  baseline street-level photo from Mapillary (credit line + Mapillary logo + link required) shown next to it;
- one landmark box drawn on the photo (from SAM 3.1);
- a short unique name (<= 3 words, from Muse Spark, editable);
- an observed profile from Muse Spark: visual, spatial, conceptual (one short line each);
- the user's quick-taps: sound, smell, feel, mood, and a turn cue (straight / left / right / arrive);
- the 8 association channels for each list item at that station: kinesthetic, auditory, visual, emotional, conceptual,
  olfactory, gustatory, spatial. Olfactory and gustatory are always labelled "imagined cue".
Models shown in the UI (a small model chip at every AI step): "Muse Spark", "SAM 3.1", "Muse Image",
"Muse Voice Transcribe" (and "Mapillary", imagery source, not a model, only in the baseline slot). Scenes made by
Muse Image carry a visible "AI-generated" chip.
Safety copy: the user captures and reviews only while standing still; one-time notice before the first walk: "Capture
only when you have stopped. Stay on public ground; never enter private property or roadways. Frame the landmark, not
people." Location is opt-in and stays on the device, except one station's location is sent to Mapillary when the user ticks
that station's baseline box; say so where location is used.

DELIVERABLES (exactly these four, nothing else)
1. ONE CSS file named route.css containing only ADDITIONS. Use only these existing custom properties (do not define new
   ones, do not hard-code colours): --bg --surface --surface-2 --ink --muted --line --primary --on-primary --lamp
   --lamp-ink --lamp-soft --ok --ok-soft --bad --bad-soft --on-bad --focus --shadow --display --body --mono.
   Light and dark both come from these tokens (the page already switches them under prefers-color-scheme).
2. A class contract per screen S1-S9 (Markdown table, NOT HTML): for each id listed under that screen, the element type
   it already is, the classes your CSS expects on it, and the classes expected on its direct children. Selectors in
   route.css may use only ids from this prompt, your contract's classes, and the shared classes listed under HARD
   CONSTRAINTS. Do not require extra wrapper elements; if a layout truly needs one, name it as a class on an element
   that already exists.
3. A state table: for each screen, which elements are visible/hidden (by the hidden attribute) in ONLY the states listed
   under that screen. Write it as a Markdown table per screen.
4. An id map table: old id -> new location/role (screen) for every existing id listed under EXISTING IDS, plus every new
   id with its screen and one-line role.

HARD CONSTRAINTS
- NO HTML fragments, NO JavaScript, no mock data, no localStorage, no navigation framework, no step rail (#s1-#s9 or
  similar ids).
- The page CSP is: default-src 'self'; img-src 'self' data: blob:. Therefore: no external fonts, CDNs or images, no
  remote map tiles, no @font-face, no url() to remote hosts. Only two self-hosted images may be referenced:
  /static/assets/empty-state.webp (exists) and /static/assets/mapillary-logo.svg (engineer supplies it).
- Visibility is ONLY the hidden attribute. Never write a CSS rule whose display value could beat [hidden]
  (if you set display on a component, scope it as :not([hidden])).
- No transform, filter, contain, perspective, will-change or backdrop-filter on any ancestor of #scene-overlay
  (it is position: fixed and must stay viewport-fixed). #scene-overlay is a direct child of <main>.
- 360px wide first; no horizontal scroll at 360px; every tap target >= 44x44px; the Capture button sits in the bottom
  thumb zone on S2; outdoor glare: text contrast >= 7:1 on S2/S3 (>= 4.5:1 elsewhere), in light AND dark.
- At >= 900px, CSS grid only (same markup): S5 route map left, S6/S7 right. No duplicated markup for desktop.
- Every delete or drop (station, route, list, rehearsal) is arm -> confirm -> Undo: a Delete button, then a separate
  Confirm button revealed in place (hidden until armed) plus Cancel, then an Undo button shown after the delete. Style
  classes .arm / .confirm / .cancel / .undo.
- Shared classes (use these names exactly): model chip "model-chip"; LIVE badge "badge-live"; recorded replay badge
  "badge-replay" (text "recorded replay"); AI chip "chip-ai" (text "AI-generated"); imagined-cue chip "chip-imagined"
  (text "imagined cue"); pending badge "badge-pending" (text "Name pending"); not-walked badge "badge-not-walked"
  (baseline slot only); per-item retry "capture-retry"; buttons "btn", "btn-primary"; capture control "capture-btn".
- No emoji, no decorative SVG art, no icon fonts. Text labels only.

ROUTE MAP (inline SVG written by the engineer, used in S5 #route-map and S8 #recall-map, viewBox 0 0 320 200)
- Structure: one <polyline class="route-line">, then one <g class="station-node"> per station containing a
  <circle r="10"> and a <text> number. States are classes on the <g>: .current, .lit, .missed. Style these in route.css
  (fill/stroke from tokens). No basemap, no tiles. Legend text sits under the map; the accessible list equivalent is the
  station <ol> on the same screen.

EXISTING IDS (must all remain, once each): public-banner status meta-notice photo passcode auto load-demo place-settings
place-toggle place-typed places upload-status empty-state scene-wrap scene loci assoc-status associations route-review
route route-undo generate scenes walk walk-step walk-prev walk-next recall recall-start recall-replay recall-typed
recall-submit recall-live recall-results history rehearsals rehearsal-undo history-view hit-rates backup backup-export
backup-import backup-status scene-overlay.
Header: <header class="topbar"><h1 class="brand">MemriPal</h1></header>. #public-banner and #status stay at the top of
<main>.

SCREENS (phone order; one visible at a time except S5 + S6/S7 side by side at >= 900px)

S1 Routes home  (ids prefix routes-)
- #routes-home (section): heading "Your routes"; line "Walk a route once, learn it for good, then use it to remember
  what matters." #routes-list (ol) of route cards: name, kind (Daily / Occasional), station count, "Learned n/N
  stations", active list name or "No list yet", "Draft" tag for an unfinished walk; each card has Open. #routes-new
  (primary button "New walk"); #load-demo ("Load demo route"); #empty-state image + "No routes yet" when empty.
  #routes-settings (collapsed details, "Live settings") holds #passcode and #auto ("Skip the Finish walk review: save in
  capture order with a default name"). #auto appears only here.
- States: empty (empty-state + New walk + Load demo), ready (list), offline (Load demo still enabled).

S2 Walking: capture  (prefix capture-)
- #capture-session (section): #capture-safety notice (first walk only) with #capture-safety-ok button; #meta-notice
  copy "Photos are sent to Meta's AI models: SAM 3.1 finds faces and plates, which are pixelated before Muse Spark names
  the landmark and before anything is stored. Location stays on your device unless you ask for a street photo of a
  station."; #capture-strip (ol, captured station
  thumbnails, wraps at 360px, numbered; a pending station shows badge-pending and a per-item retry button
  .capture-retry); #upload-status (role=status) for "Naming the landmark..."; capture control in the bottom thumb zone:
  a label.btn.btn-primary.capture-btn "Capture station" for the existing #photo file input (visually hidden but
  focusable); #capture-locate checkbox "Use my location for this walk (stays on this device)"; #capture-finish button
  ("Finish walk", enabled at >= 3 named stations); #capture-count text ("4 of 6 stations").
- States: capturing (Capture enabled), uploading (Capture disabled, status text, model chips "SAM 3.1" + "Muse Spark",
  not animation-heavy), error (Retry or Drop on the item), offline ("Saved on this phone. Tap Retry when you are back
  online.").

S3 Station card  (prefix station-)
- #station-card (section): photo area = existing #scene-wrap > #scene canvas (photo + landmark box) with chip
  "SAM 3.1". Baseline: #station-baseline-optin (checkbox, "Get a street-level baseline photo for this station: sends
  this station's location to Mapillary, a Meta service"; disabled with the line "No location for this station" when
  the station has no coordinates); #station-baseline-status (role=status, "Looking for a nearby street photo...",
  "No street photo near this station."); #station-baseline (figure, hidden until a baseline loads) with
  #station-baseline-img, chip "Mapillary" and #station-baseline-credit (Mapillary logo + "Photo: <author> / Mapillary,
  CC BY-SA" + link "View on Mapillary").
  #station-name (text input, maxlength 40) + #station-name-error (hidden; e.g. "Another station is already called
  'wall'. Pick a different name.") + chip "Muse Spark". #station-profile (dl: Visual / Spatial / Conceptual, chip "Muse
  Spark"). #station-taps fieldset with four groups of toggle buttons (aria-pressed) and one turn group: #tap-sound
  (Traffic, Birds, Water, Voices, Quiet, Music), #tap-smell (Food, Coffee, Flowers, Fumes, Rain, None), #tap-feel (Warm,
  Cold, Windy, Uphill, Stairs, Shade), #tap-mood (Calm, Busy, Bright, Cosy, Grand, Odd), #tap-turn (Straight, Left,
  Right, Arrive). Footer: #station-save (primary), #station-drop (arm) -> #station-drop-confirm + #station-drop-cancel
  (hidden until armed) -> #station-undo (hidden until dropped). #loci (existing ol) stays here as the visually-hidden
  accessible list of the detected landmark box (one item).
- States: uploading (photo + "Naming..."), ready, error (name clash), offline, baseline-loading, baseline-shown,
  baseline-none, recorded-replay (badge-replay on the baseline in the demo).

S4 Finish walk  (existing #route-review; new ids prefix finish-)
- #route-review heading "Finish walk". #finish-name (route name input), #finish-kind (two radios Daily / Occasional,
  name="finish-kind"), existing #route (ol) of stations in walk order: each row = thumbnail, number, name, turn cue,
  Up/Down buttons (44px), Drop (.arm -> .confirm per row), and existing #route-undo. Order note: "In the order you
  captured them. Use Up and Down to fix it." #finish-save (primary, "Save route"). #generate is NOT here (S6).
- States: ready, error (fewer than 3 or more than 8 stations; a name pending; duplicate names listed), uploading
  (saving).

S5 Route view: learn the route  (prefix route-view-, plus #route-map)
- #route-view (section): heading = route name + kind; #route-map SVG; #route-view-stations (ol): number, thumbnail,
  name, turn cue ("then left"), sound/smell chips, "Learned" check from practice, and a small baseline thumbnail with
  chip "Mapillary" for stations that have one; #route-view-practice (primary "Practice this route": say the stations in
  order with eyes closed); #route-view-baseline (toggle button "Show street photos" / "Show my photos", visible only
  when >= 1 station has a baseline) + chip "Mapillary"; #place-settings (existing fieldset, collapsed "Place facts (optional)") with #place-toggle
  #place-typed #places; #route-view-lists summary: active list name or "No list yet" + button #route-view-add-list;
  #route-view-in-use notice (hidden): "This route holds 'Biology ch. 3'. Retire it first, or use another route.";
  delete route: #route-view-delete -> #route-view-delete-confirm / #route-view-delete-cancel -> #route-view-undo.
- States: empty (no stations), ready, offline (map + stations still shown).

S6 List on route  (prefix list-)
- #list-panel (section): heading "Place a list on this route"; #list-name input; #list-notes textarea (paste notes or a
  list; up to one key point per station is used); #list-split button ("Find key points", chip "Muse Spark"); existing
  #assoc-status (role=status) and #associations (one card per station: station name, item text, the 8 channels as chips
  with olfactory/gustatory carrying chip-imagined, chip "Muse Spark"); existing #generate ("Make scenes", chip "Muse
  Image"); #list-retire (arm) -> #list-retire-confirm / #list-retire-cancel -> #list-retire-undo ("Retire this list"
  frees the route for a new list).
- States: empty, uploading (per-card progress), ready, error (per card retry), recorded-replay (badge-replay).

S7 Scene walk  (existing #scenes and #walk)
- #scenes: one card per station: scene img (chip-ai always), station name, item. #walk with #walk-step ("Station 3 of
  6", scene, walk cue, item) and #walk-prev / #walk-next (44px, bottom). #scene-overlay stays a direct child of <main>.
- States: uploading (per-card "Painting..." + chip "Muse Image"), ready, error (text-only scene card),
  recorded-replay.

S8 Recall  (existing #recall; new #recall-map, prefix recall-)
- #recall: #recall-mode text ("Route practice: say them in order" or "List: <name>"); #recall-map SVG (dots light as
  the user speaks); #recall-start (primary, "Start, then close your eyes"), #recall-replay ("Play the replay of a
  recorded session"), #recall-typed (typed fallback, hidden by default), #recall-submit ("Done"), #recall-live (live
  board with badge-live or badge-replay), #recall-results; chip "Muse Voice Transcribe" next to the live board; line
  "Matching is plain code, no AI."
- States: ready, LIVE (badge-live, mic on), recorded-replay (badge-replay), error ("Speech relay failed" + typed
  fallback visible), offline (typed fallback + replay only).

S9 Results and history  (existing #history, #backup)
- #history: #rehearsals (ol: date, mode, got/missed), #rehearsal-undo, #history-view, #hit-rates ("Hit rate per
  station"); new #history-intrusions (ul, hidden; reserved for a later build).
- #backup: #backup-export, line "Backups never include map coordinates or street photos. Station names and photos can
  still show where you walk.", #backup-import, #backup-status.
- States: empty, ready, error.

GLOBAL
- Typography: --display for headings, --body for text, --mono for counts. Painterly theme tokens are already on the
  page; stay within them.
```

---

# PART B: implementation slices (TDD, vertical)

Rules for every slice: RED test first with `// Covers: MEM-0xx` (node) or `# Covers: MEM-0xx` docstring tag (pytest);
spec entry added to .claude/spec-cache/memripal/references/spec-3.md (spec-4.md once spec-3 passes 500 lines); ADR in the
same change for any 2+-option choice (docs/decisions/, README index); new server routes in new modules; app.py edits in
the D7 order only, each slice's criterion `app.py <= 582`; markup uses Part A ids and is the final markup (Claude
Design adds CSS + classes only, B11); static/ diffs carry a screenshot + visual-verify record; one commit per fix; bump
+ CHANGELOG at land.
Every adversary finding was read-only; each slice's first RED test exercises the cited code path, so a premise that
turns out false surfaces at RED (record it in the slice's commit, do not silently drop the criterion).
Lanes: SERVER (B0 -> B1 -> B4 app.py wiring -> B7 server -> B8 router wiring), CLIENT (B3, B5, B6, B9, B8 client),
JOIN (B7 after B4+B5; B10 after B2+B6+B7+B8, soft-after B11; B11 whenever Claude Design returns, after B3). B0, B2, B3,
the station.py core of B4 and the baseline.py core of B8 (no app.py edit; needs only the live API doc fetch) dispatch
first, in parallel; B1 dispatches when B0 lands; B4's router wiring rebases on B1; B8's wiring rebases on B7.

MEM ids: MEM-046.. assigned below (MEM-045 = brand-art, unmerged). ADRs 0031.. assigned in land order.

## B0 Free app.py budget: body parsers to bodies.py (enables D7). MEM-060 (refactor; no behaviour change)
- Move module-level parsers app.py:184-259 (_split_body .. content-length check) to src/memripal/bodies.py; app.py
  imports them. No logic change.
- CRITERIA: (1) app.py <= 515 lines; (2) full existing pytest suite green with 0 test edits other than import paths;
  (3) ruff green; (4) `git grep` finds each moved function defined exactly once.
- SIGNALS: none.

## B1 Scene provenance pass-through + AI-generated chip (item 111). MEM-046, ADR (amends 0024)
- scenes.py `_fit` -> validate header + caps only (`_open_header`, `_check_bytes`), return the Muse Image bytes unchanged
  with their format (webp/png/jpeg); app.py:571 emits the matching mime via a lookup; width/height stay the photo's
  (no change at :572-573). Client: on img load, if naturalWidth/naturalHeight aspect differs from photo width/height
  aspect by > 2%, zoomFor gets identity. Every scene card + overlay + export shows chip-ai.
- CRITERIA: (1) test: fake image_edit returns WEBP with XMP/EXIF -> /scenes image bytes == input bytes (sha equal);
  (2) test: response data URL mime == reply format for webp, png, jpeg (3 cases); (3) node test: a 1024x768 reply for an
  800x600 photo gives the same zoomFor output as today; (4) node test: a 1024x1024 reply for an 800x600 photo -> identity
  zoom; (5) test: undecodable / over-cap reply -> tier 3 (existing reasons kept); (6) node test: every rendered scene
  card and the overlay contain exactly one .chip-ai; (7) ruff + pytest + node green; (8) app.py <= 582 lines.
- SIGNALS: none (existing scenes fixture tests replay unchanged).

## B2 Neutral demo place text scrub (item 112). MEM-047
- Scrub war-site text from README.md:194, ADR 0022 :13 :41 example text (append-only amendment note, decision
  unchanged), UI copy and the MANIFEST row; the room-demo place sidecar, /place replay and the 12 room-demo spark_json
  fixtures are NOT regenerated here: B10 retires them (archived under fixtures/archive/room-demo/, not served, not
  deleted) and records the demo route's replays once at the chosen place.
- Also scrub scripts/make_synthetic_fixtures.py:41-56 (PLACE_HITS + extracts) and the MEM-025 example text in
  .claude/spec-cache/memripal/references/spec-2.md (append-only amendment note; the MEM-025 id stays).
- CRITERIA: (1) `git grep -i -E "round top|gettysburg|battle"` over README.md docs/ static/ src/ scripts/
  .claude/spec-cache/ (excluding CHANGELOG history and fixtures/) == 0 hits; (2) test pins the demo place title against
  a deterministic war-term denylist; (3) MEM-025 id still present in spec-2.md (grep == 1); (4) suite green.
- SIGNALS: Kev confirms the neutral public place (Q1). It gates B10 K1 and the B8 coverage probe, not B2: B2 scrubs
  text to a placeholder title "Demo route" that B10 replaces.

## B3 Route + station store, capture order, pending stations, S1/S2/S4 markup. MEM-048, ADR (route store)
- static/route_store.js: routes [{id, name, kind daily|occasional, status draft|saved, created_at, stations[{id, n,
  name, photo_ref, status pending|named, box?, profile?, taps?, coords?}], lists[{id, name, status active|retired}]}],
  through the injected KV adapter (idb_adapter.js), coords rounded to 4 dp at write. No captured_at field.
- Station count: store accepts 0-8; walks in progress and drops are never refused below 8; #finish-save enforces 3-8
  named stations.
- Order = capture order (n); Up/Down at S4 reorders. GPS read from the raw File only when the opt-in is on, then the
  photo is re-encoded (reencodeJpeg) before it is stored or sent.
- Pending stations (D10): on capture the re-encoded photo is written as a pending station BEFORE upload; success ->
  named (the stored photo is replaced by the server's pixelated JPEG); network error / 5xx incl. 502 blur_failed / 429
  -> stays pending with badge-pending + .capture-retry; other 4xx -> error with Drop; one in-flight request per station;
  no online-event auto-retry. The walk persists as a draft route across reloads.
- Markup (final, Part A ids): S1 #routes-home #routes-list #routes-new #routes-settings (holds #passcode and #auto, the
  only home of #auto); S2 #capture-session #capture-safety #capture-safety-ok #capture-strip #capture-locate
  #capture-finish #capture-count; S4 #finish-name #finish-kind #finish-save inside existing #route-review.
- CRITERIA: (1) store tests: create/list/get/update/delete-with-undo route; 1- and 2-station drafts storable; dropping
  a station from a 3-station draft allowed; 9th station refused; (2) #finish-save: 2 and 9 named stations refused, 3
  and 8 accepted, 1 pending refused (5 cases); (3) coords stored with <= 4 decimals (property test over 20 inputs);
  (4) ordering test: stations listed by capture index; Up/Down swaps persist; (5) pending: fake fetch rejects -> station
  stored pending with photo bytes that carry no EXIF (byte scan); manual retry -> named (fetch spy == 1); reload (fresh
  store over the same fake KV) keeps the pending station; (6) status classes: 502 blur_failed and 429 -> pending; 400 ->
  error with Drop (3 cases); (7) double tap on Retry while in flight -> fetch spy == 1 call; (8) markup test: all 44
  live ids present exactly once (incl. #auto) + the new ids present; (9) capture disabled while an upload is in flight;
  (10) S4 row drop: first click arms (confirm visible), Cancel restores, Confirm removes, #route-undo restores the same
  station (deep-equal, same id, same position); (11) KV write rejects (fake adapter throws, e.g. quota) -> #upload-status
  shows an error, the in-memory station is kept, no unhandled rejection; (12) suite green.
- SIGNALS: none.

## B4 POST /station: strict fail-closed pixelation, name + profile, one SAM box. MEM-049, ADR (station pipeline)
- New module src/memripal/station.py (+ router factory routes_station.py taking (backend, passcode_error) because
  _passcode_error is a create_app closure, app.py:291; wired in create_app with <= 2 lines, after B1 lands):
  process_upload -> two SAM segment calls in parallel ["person", "license plate"] through a NEW strict helper (D3):
  raises BlurFailed on BackendCallFailed / over-cap / non-empty text with 0 tokens / any dropped token / any
  sanitize_box reject; "none found" only for an empty/whitespace body or the probe-recorded empty shape (the
  loci.py:195-200 helper that returns [] on failure is NOT reused) -> pixelate those boxes (<= 8 blocks across each
  box's long side, NEAREST resample, deterministic bytes) -> Spark chat_json {station_name (<= 3 words, no digits),
  landmark_phrase, visual, spatial, conceptual} ("fixed structures only: arch, door, statue, tree, sign, bench, bridge,
  mural"; never describe people; never copy text from signs, house numbers or street names; do not reuse any name in
  used_names or its last word) -> one SAM segment on landmark_phrase -> largest valid box (select_loci with max_loci=1,
  no MIN_LOCI reask). Response: pixelated JPEG data URL, width, height, photo_sha (of the pixelated JPEG), name,
  profile, box (or null -> station still usable).
- Raw-photo cache rule (D3): the two blur-phase ModelRequests carry a no-photo-cache flag; MetaBackend._store skips
  put_photo for them (backend.py:430); the response entry may be cached (it holds boxes only). Spark and landmark calls
  run on the pixelated photo and may cache it.
- Request carries used_names (list, <= 7 strings, each <= 3 words, <= 40 chars; exact validation -> 400
  bad_used_names). Passcode gate before body read + budget like /loci; per-call concurrency cap (item 6); upload type
  and byte limits identical to /loci (UPLOAD_TYPES, app.py:62, and its size check).
- Pillow pinned to an exact version in pyproject.toml (currently unpinned "pillow", pyproject.toml:11).
- Station-name rule (shared deterministic function, server checks shape only): <= 3 words, no digits, non-empty.
  Uniqueness and head-noun clashes are a CLIENT check at save (B5), resolved by the user renaming.
- CRITERIA: (1) test: fake SAM returns a 600x600 person box -> the box region downsampled has <= 8x8 distinct blocks;
  pixels outside the box identical; (2) test: pixelation runs before Spark (call-order recorder: 2 blur segments, then
  chat_json, then 1 segment) and Spark receives the pixelated bytes; (3) test: blur-segment BackendCallFailed (each of
  the 2 phrases) -> 502 blur_failed and 0 chat_json calls (2 cases); (4) test: blur segment returns an empty body ->
  proceeds, Spark called once; (5) strict parser RED cases -> 502 blur_failed, 0 chat_json: "No objects detected."
  text, a token missing h, a token sanitize_box rejects (3 cases); (6) test: reply with 4-word name, a digit, or extra
  fields -> one regenerate then 502 bad_reply (never > 2 Spark calls); (7) test: no SAM box for the landmark -> 200
  with box null; (8) test: used_names validation 4 cases (8 names, 4-word name, non-string, ok) and used_names appear in
  the Spark prompt; (9) golden test: pixelation output sha on a committed fixture photo + fixed boxes == pinned value;
  (10) cache test: MetaBackend(cache_root=tmp) with a fake client -> photos/ holds only the pixelated sha after a 200,
  and holds 0 photos after a blur_failed where "person" succeeded and "license plate" failed; (11) passcode 401 before
  body read; (12) over-size upload -> same status as /loci; a GIF/unknown type -> same status as /loci (2 cases, 0
  backend calls); (13) concurrency cap (new; item 6 never landed for /loci): with cap N, N+1 simultaneous fake-slow
  requests -> exactly 1 refused with 429 busy (client treats it as pending, D10); (14) app.py <= 582 lines; (15) suite green.
- SIGNALS: one live probe via scripts/run_live.ps1 (re-homes item 12) BEFORE criterion (4)/(5) are frozen: record the
  exact SAM reply body for a photo with no person and no plate (fixes the "explicit empty shape"); if the probe has not
  run when B4 reaches GREEN, only an empty/whitespace body means "none" (stricter; fails closed) and the probe shape is
  added later as a one-line, test-first amendment; one real station
  photo: name <= 3 words, box present, no face recognisable in returned JPEG (Kev eyeballs); token/latency logged
  (re-homes item 45).

## B5 Station card S3: quick-taps, turn cue, name edit, drop arm/confirm/Undo. MEM-050
- Client: render /station result into #station-card (sends the route's current names as used_names); #scene canvas
  draws photo + box; taps stored on the station; name edit validated by the B4 shape rule plus the client uniqueness
  rule (normalized exact name or shared last word with another station in the route -> #station-name-error, user
  renames; never a failed capture); drop = arm -> confirm -> Undo (store-level undo).
- CRITERIA: (1) node test: each tap group toggles aria-pressed and persists to the store (5 groups); (2) clash cases:
  same name, "brick wall"/"stone wall", 4 words, empty -> #station-name-error shown and #station-save blocked; 2 ok
  cases save (6 cases); (3) a Spark name that clashes on arrival renders in the input with the error shown (no network
  retry); (4) drop: first click arms (confirm visible), cancel restores, confirm removes, Undo restores identical
  station (deep-equal, same id); (5) olfactory/gustatory tap values never appear in copy as "captured" (string test on
  rendered labels); (6) suite green + screenshot/visual-verify at 360px.
- SIGNALS: none.

## B6 Route view S5 + in-order route practice + recall map dots S8. MEM-051
- static/route_map.js: project station coords (or index layout when none) into the 320x200 viewBox, write polyline +
  station nodes into #route-map / #recall-map with classes .current/.lit/.missed; coords are never rendered as text.
- Practice (D9): #route-view-practice starts the existing recall flow with points = station names only (turn cue shown,
  never matched); a pure post-pass over the matcher's hits (span start token index per hit; createMatcher keeps the
  window start w.i alongside span) counts a hit only when its start comes after the previous counted hit's start; live
  lighting (recall_live.js) sets .lit only on counted hits; Done marks the rest .missed and records a rehearsal (mode
  "route", hits keyed by station id); "Learned n/N" on S1/S5 = latest route rehearsal's hits whose ids are still on the
  route, N = current station count.
- CRITERIA: (1) projection test: 6 coords -> 6 nodes inside the viewBox, order preserved; no coords -> evenly spaced
  index layout; (2) live match of station 3 after stations 1-2 -> node 3 .lit within the same tick (fake relay);
  (3) Done with 5/6 matched in order -> exactly 1 .missed; (4) order test: the 6 names said in reverse -> 1 counted hit;
  shuffled "1 3 2 4 5 6" -> 5; (5) false-hit test: stations "red bench" and "red door", transcript "red bench left" ->
  exactly 1 node lit; (6) a 2-of-3-word utterance of a 3-word name lights it (coverage 0.67 >= 0.6); (7) rehearsal
  stored with mode "route" and hits keyed by station id; "Learned 5/6" rendered; after Up/Down swap of stations 2 and 3
  the same stations stay Learned; after dropping one station on a 5/6 route -> "Learned 4/5" or "5/5" per the dropped
  id, never n > N; a 4-station route shows "/4"; (8) no inline style attribute set by JS except the existing zoom
  transform (DOM scan); (9) no coordinate digits in rendered text (DOM text scan); (10) route delete: #route-view-delete
  arms, #route-view-delete-cancel restores, #route-view-delete-confirm removes the route from S1, #route-view-undo
  restores it deep-equal (stations, lists, rehearsals); (11) many routes (MK1/MK2): 3 saved routes (2 Daily, 1
  Occasional) + 1 draft render as 4 cards on S1, each with its kind, station count and "Learned n/N", the draft tagged
  "Draft"; (12) per-station hit rates (MK5): after 2 route rehearsals (6/6, then 3/6), #hit-rates shows one row per
  station name with 100% or 50% as recorded, keyed by station id (survives an Up/Down swap); (13) suite green +
  screenshot.
- SIGNALS: none.

## B7 List on route S6/S7: notes input, profile-grounded KAVE COGS, scenes per station, reuse rule. MEM-052
- #list-notes + #list-split -> existing /split notes mode with loci_count = station count and the photo = station 1's
  pixelated photo (fixture key = that photo_sha + notes + count); reply over the count is rejected by split.py:80 ->
  one regenerate -> 422 split_invalid shown in #assoc-status with retry (no partial placement); typed-list mode
  unchanged.
- associate.py: optional `station` arg {name, visual, spatial, conceptual, taps{sound,smell,feel,mood}} appended as
  ASSOCIATION_STATION after the prompt OUTSIDE the templates digest (same pattern as ASSOCIATION_PLACE :55-62) AND
  carried in PROMPT_ARGS like `place` (associate.py:168-180) so two stations with the same name/item/photo get distinct
  replay keys; check_station exact-keys validator + caps lives in bodies.py (no app.py growth beyond the one call in
  _associate_body's caller). Prompt says "use only these station facts; olfactory and gustatory are imagined cues for
  the item, never claims about the place". Locus = station name. Per-list visual theme word added to
  scene_prompt_details so lists stay visually distinct.
- Scenes: /scenes on the station's pixelated user photo; a station with box null sends the full-frame box
  {0,0,width,height} (passes _box_ok, app.py:229); scenes.js:203 no longer skips box-less cards.
- Reuse rule: one active list per route; #route-view-add-list refused with #route-view-in-use while one is active;
  allowed immediately after the active list is retired.
- CRITERIA: (1) test: /associate with station -> prompt contains the station block and no coords; key unchanged for
  requests without station (existing fixtures replay, 0 fixture_missing); (2) test: two requests differing only in
  station facts -> different cache keys; (3) check_station rejects extra keys, over-cap fields, non-string taps (3 cases
  -> 400 bad_station) and accepts a valid block; (4) node test: 6-station route sends /split with loci_count 6 and
  station 1's photo; fake 6-point reply -> 6 items placed in order; fake 422 split_invalid -> error + retry shown, 0
  items placed; (5) reuse: active list -> add refused; retired -> allowed; no list -> allowed (3 cases); (6) node test:
  station with box null -> /scenes request body has the full-frame box and the card renders; (7) signed record flow
  unchanged (sig tests green); (8) app.py <= 582; (9) list retire: #list-retire arms, #list-retire-cancel restores,
  #list-retire-confirm sets status retired, #list-retire-undo restores active (and re-blocks add-list); (10) list-mode
  recall (MK4): #recall-mode reads "List: <name>"; saying item 3's text lights the node of the station holding item 3
  in #recall-map (fake relay), Done marks unsaid items' stations .missed, rehearsal stored with mode "list" and hits
  keyed by station id (2 cases: 6/6 and 4/6); (11) second list on the same route: retire list A, add list B -> B's
  associations use palace id `<route_id>/<list_B_id>`, A's rehearsals unchanged (deep-equal); (12) /associate requests
  never carry baseline bytes or Mapillary links (body scan); (13) suite green + screenshot.
- SIGNALS: live: one 6-item list on the demo route, 6/6 associations valid within <= 2 regenerations each.

## B9 Backup v2: no coordinates, field allowlist, thumbnails, own byte cap. MEM-054, ADR (amends 0028)
- palace_export.js v2 {v:2, routes[], lists[], associations, rehearsals}. Exports saved routes only; within them named
  stations only (pending stations and drafts skipped). Exported station fields are exactly {id, n, name, status, box,
  profile, taps, photo}; photo = the stored pixelated JPEG re-encoded to 640 px long side, quality 70, EXIF-free; box
  scaled to the thumbnail. Route fields {id, name, kind, created_at, stations, lists}. Never exported: coords, any
  timestamp per station, EXIF, baseline images/ids/links/credits, pending photo bytes. Import collisions per D11.
  Imported photos must be data:image/jpeg URLs that pass isSafeImageSrc and decode (img onload) before the route is
  written; boxes must lie inside the thumbnail.
- New MAX_BACKUP_BYTES = 8 MiB for export and import (MAX_IMPORT_BYTES stays 1 MiB for its recall-relay meaning).
- Import: v2 only, additive, exact-keys validation kept (refuses coords keys); a v1 file -> #backup-status "Older backup
  format, not supported", nothing written.
- CRITERIA: (1) export JSON walk: every station object's key set == the allowlist; 0 keys matching
  /lat|lon|coord|captured|image_id|link/ anywhere; (2) exported photos carry no EXIF (byte scan) and long side <= 640;
  (3) a route with 1 pending station + 1 draft route -> 0 pending stations and 0 drafts in the export; (4) size test: 3
  routes x 8 stations built from 2048 px quality-90 JPEGs export and re-import without error and under
  MAX_BACKUP_BYTES; (5) v2 round trip deep-equal minus coords, baselines and photo resolution; (6) malformed /
  extra-key / coords-bearing v2 refused (3 cases); (7) v1 fixture -> "not supported", store unchanged; (8) a station
  with a loaded baseline exports with 0 keys matching /baseline|mapillary|credit/ and 0 occurrences of its image bytes'
  base64 prefix; (9) importing the same file twice -> second import "0 added, n already present", store deep-equal
  after the first; (10) photo that is data:image/png, javascript:, or undecodable JPEG -> import refused, store
  unchanged (3 cases); (11) file over MAX_BACKUP_BYTES refused before parse; (12) suite green.
- SIGNALS: none.

## B10 Demo route + submission docs. MEM-055
- Load demo route: 6 committed station records = the recorded /station RESPONSES (pixelated JPEG, name, profile, box)
  as demo data; Load demo builds the route from them and never POSTs /station (no raw photo is committed or replayed).
  Recorded /split, /associate, /scenes replays are keyed on the pixelated photos and promoted with a new
  scripts/promote_live_cache.py `--photo-sha` mode (pick entries whose sidecar names that sha; test + README entry).
  Demo data carries NO coordinates (schematic index layout). Room-demo fixtures + sidecar + /place replay archived to
  fixtures/archive/room-demo/ (not served); #load-demo lands on S5.
- Demo baselines (MK7): for each demo station with Mapillary coverage, the recorded /baseline RESPONSE (re-encoded
  JPEG, author, image link, licence) is committed as demo data and rendered with badge-replay; Load demo never calls
  /baseline. The coordinates used at K1 to fetch them are not committed.
- Demo lists: two recorded lists for the storyboard's "second list same route" beat (list A active, list B recorded
  for after the on-camera retire); both lists' /split, /associate, /scenes replays promoted.
- Kev-run K1: walk + capture 6 stations at the public place, `scripts/run_live.ps1` one live record per station, save
  the /station responses, promote (re-homes items 94, 59). README: "Built during the hackathon" section with commit
  ranges; new pipeline diagram; planning-docs-only note for docs dated before Oct 27; model list (Spark, SAM 3.1, Muse
  Image, Voice Transcribe); no Gemini-suggested models. demo-script.md rewritten to the 3:00 storyboard (both views:
  route learning + list on route + baseline next to the user's photo + second list after retire); checklist. Model
  list adds "Mapillary (imagery source, CC BY-SA, not a model)".
- If B11 has not landed by Mon Nov 2 EOD, the video is recorded on the existing style.css (all ids and behaviour are
  final; B11 is CSS + classes only). This is a sequencing fallback, not a cut: B11 still lands before submission.
- CRITERIA: (1) offline Load demo -> S5 with 6 stations, 0 fixture_missing, 0 /station and 0 /baseline requests (E2E
  drive + fetch log); (2) tier-1 scene on station 1 replays (re-homes 108a); (3) precommit EXIF scan passes on the 6
  station JPEGs and every demo baseline JPEG; (4) every committed station JPEG sha == its recorded response's
  photo_sha; (5) `git grep -w -E "Llama|YOLO|SAM 2|Movie Gen|Emu|Pokemon"` in README/docs/submission == 0;
  (6) demo data + fixture files contain 0 lat/lon/coords keys (JSON walk); (7) `git grep -i -E
  "round top|gettysburg|battle"` outside CHANGELOG and fixtures/archive/ == 0; (8) promote `--photo-sha` test green;
  (9) >= 3 demo stations render a baseline with credit text, Mapillary logo and a https://www.mapillary.com link (DOM
  check); (10) offline E2E: retire list A, add list B -> B's 6 associations and scenes replay with 0 fixture_missing;
  (11) suite + E2E green.
- SIGNALS: Kev K1 capture done (incl. /baseline records); Kev records video (item 68).

## B11 Adopt Claude Design CSS + class contract. MEM-056 (follows ADR 0030 pattern)
- static/route.css imported at the top of style.css (no new <link>); classes from the contract added to the existing
  markup (no fragment merge, no wrapper elements unless the contract names an existing element); state table encoded
  as node tests over [hidden].
- CRITERIA: (1) route.css uses only the listed tokens (regex test: every var(--x) in allowed set; 0 hex colours);
  (2) every route.css selector uses only Part A ids, contract classes or shared classes (selector scan); (3) every
  display rule on a component is scoped :not([hidden]) (CSS scan); (4) no transform/filter/contain/perspective on
  #scene-overlay ancestors (existing test extended); (5) 360px screenshot: no horizontal scroll, targets >= 44px (E2E
  measurement); (6) computed text/background contrast (E2E, both prefers-color-scheme values) >= 7:1 for every text
  node in S2/S3 and >= 4.5:1 elsewhere; (7) #meta-notice, #station-baseline-optin and backup copy == the Part A text
  (string tests); (8) B3/B5/B6/B7/B8 tests green with 0 selector edits.
- SIGNALS: Claude Design delivery received; light + dark screenshots visual-verified (repo screenshot_ui.py record).

## B8 Mapillary baseline per station via backend proxy (MK7, ABOVE the cut in v2). MEM-053, ADR (amends 0012, 0022)
- Options: (a) backend proxy POST /baseline {lat, lon} (4 dp) -> Mapillary Graph API with MEMRIPAL_MAPILLARY_TOKEN
  (sent in a header, never a query string, if the API allows; else redacted from every log), nearest CC BY-SA image
  within ~30 m, 1024 thumb (https only, CDN host allowlist, no cross-host redirects, byte cap, Pillow re-encode strips
  EXIF); (b) widen img-src to the CDN. Lean (a) (no CSP wildcard, token server-side, fixture replay, SSRF contained).
- Server: new module src/memripal/baseline.py + router factory routes_baseline.py (same shape as B4), wired in
  create_app with <= 2 lines after B7 (D7). Response: {image (JPEG data URL), author, image_url (https link to the image
  page on mapillary.com), licence}; never the raw CDN URL. Input validation: exact keys {lat, lon}, finite numbers, lat
  in [-90, 90], lon in [-180, 180], rounded to 4 dp server-side before any outbound call.
- Client: #station-baseline-optin (S3) is the only trigger; ticking it sends that one station's coords; the result is
  stored on the station in IndexedDB (never exported, B9) and shown in #station-baseline with chip "Mapillary", the
  credit text, the self-hosted /static/assets/mapillary-logo.svg and a link to image_url; S5 shows thumbnails and the
  #route-view-baseline toggle. Baseline bytes are display-only (D1).
- Coordinates leave the device ONLY for stations the user ticks one by one (no automatic zone, no route-end heuristic);
  consent copy names Meta. Baseline image/id/link are never exported (B9 allowlist holds).
- CRITERIA: (1) passcode 401 before body read; per-call budget + concurrency cap (item 6); (2) outbound coords <= 4 dp
  (outbound request spy, 20-input property test); (3) non-allowlisted host / http / cross-host redirect -> 502, no
  second fetch (3 cases); (4) non CC BY-SA skipped, none -> 404 no_baseline; (5) response JPEG has no EXIF (byte scan);
  (6) log capture: no lat/lon digits and no token substring in any record; (7) only ticked stations call /baseline
  (fetch spy: 6 stations, 2 ticked -> 2 calls); a station without coords -> optin disabled, 0 calls; (8) fixture replay
  offline; (9) body validation: extra key, NaN, lat 91, lon -181, string -> 400 bad_coords (5 cases, 0 outbound calls);
  (10) DOM: a loaded baseline renders credit text containing the author, the logo img and an anchor whose href starts
  https://www.mapillary.com/ (rel="noopener noreferrer"); 404 no_baseline -> #station-baseline-status "No street photo
  near this station." and the figure stays hidden; (11) /scenes, /split, /associate and /station request bodies never
  carry baseline bytes (body scan); (12) app.py <= 582; (13) suite green + screenshot.
- SIGNALS: Mapillary client token (Kev, Q3; gates the live probe and K1 baselines, not RED/GREEN, which run on
  fixtures); live API doc fetch confirms field names, licence field and the header-vs-query token rule before RED; live
  coverage probe at the chosen demo place (>= 3 stations with an image within 30 m) before K1; Mapillary logo taken from
  Mapillary's official attribution assets (rights per hackathon.md:96).

---- CUT LINE (everything above ships by Mon Nov 2 EOD for Tue Nov 3 recording; below only if time remains) ----

## B12 Intrusion counting + optional list cooldown. MEM-057, ADR (reuse/intrusions)
- Recall matcher also matches retired lists' items on the same route; such matches render in #history-intrusions and
  never count as hits. Optional cooldown before a route takes a new list (injected clock) decided in this ADR.
- CRITERIA: (1) transcript naming a retired item -> 1 intrusion, 0 hits for it; (2) current item -> hit; (3) no retired
  lists -> #history-intrusions hidden; (4) suite green.
- SIGNALS: none.

## B13 Optional video at a station: client keyframes. MEM-058
- <video> file -> 1-3 canvas keyframes -> /station as images; audio track never read or sent.
- CRITERIA: (1) 3 frames max; (2) no audio API used (static scan); (3) raw video bytes never uploaded (fetch spy).
- SIGNALS: 1-hour Spark video-input probe (not a dependency).

## B14 Planned (not walked) stations (serves MK2 for routes not yet walked; needs B8). MEM-059
- Add a station by typed coordinates or by tapping the schematic between stations; baseline-only, badge-not-walked.
- CRITERIA: (1) coords validation: out-of-range lat/lon and non-numbers refused, stored at <= 4 dp (5 cases);
  (2) a planned station renders badge-not-walked on S3/S5; (3) route practice over a route with 2 planned + 4 walked
  stations scores per D9 (in-order, N = 6); (4) planned stations count toward #finish-save's 3-8 rule (a route of 3
  planned stations saves; 2 is refused); (5) suite green. SIGNALS: none.

## B15 Basemap through the same proxy (stretch). Only if B8 proves the proxy pattern cheap. ADR amendment.
- CRITERIA: (1) tiles fetched only through the backend proxy (0 direct third-party requests in the fetch log); (2) CSP
  unchanged (header test); (3) attribution text rendered on the map; (4) suite green.
- SIGNALS: tile-source terms of use fetched and recorded in the ADR before RED.

## Order by demo value and schedule
(Day check: 2026-10-31 is a Saturday, so Mon = Nov 2, Tue = Nov 3, Wed = Nov 4. v1-r2's cut line said "Mon Nov 3";
fixed.)
- Sat Oct 31: dispatch B0, B2, B3, B4's station.py core and B8's baseline.py core (after the live Mapillary doc fetch)
  in parallel; B1 when B0 lands; send Part A to Claude Design; Kev picks the public demo place (Q1), supplies the
  Mapillary token (Q3), runs the B4 empty-reply probe and the B8 coverage probe at the candidate place.
- Sun Nov 1: B4 router wiring (rebased on B1), B5, B6 (hero), B9, B8 client (S3 opt-in + figure, S5 thumbnails).
- Mon Nov 2: B7 (rebased on B4), then B8 router wiring (rebased on B7), B11 (when design lands); Kev K1 capture walk
  at the public place (daylight, early morning), recording /station and /baseline per station.
- Tue Nov 3: B10, deploy (item 54, with MEMRIPAL_MAPILLARY_TOKEN), live mic run (item 70), record video (item 68).
- Wed Nov 4: buffer, B11 if it slipped past recording, submission checklist, push public (item 13). Below-cut slices
  only if Tue finished (B12 first: it completes the prompt's "intrusion counting").
- Slip rule: if a slice above the cut slips, the schedule moves (Wed buffer absorbs it) and Kev is told which beat of
  the storyboard is at risk; no MK item is removed without Kev's explicit ask.

## Risks
- Station name vs validator: names must appear word for word in an association channel; <= 3 words + avoid-list keep
  the regenerate loop (ADR 0020) from firing often.
- Muse Image on outdoor photos: clutter; pre-render the demo route and caption recorded replay.
- SAM outage at capture time blocks naming (fail-closed by design); pending stations keep the photo locally for a
  manual retry; the walk stays a resumable draft.
- Strict blur parser may refuse a valid empty SAM reply format not seen in the probe: fails closed (user retries),
  never open; the probe in B4 SIGNALS pins the empty shape first.
- Station photos and names themselves can show where a person walks; disclosed in backup copy, not technically
  prevented.
- B8 above the cut adds ~1 slice to a 4-day schedule and depends on Kev's Mapillary token and on coverage at the demo
  place. Mitigation: core + client run on fixtures in parallel from Sat; only the live probe and K1 need the token;
  place choice (Q1) requires coverage. If coverage or token never arrives, escalate to Kev (do not cut MK7 silently).
- Mapillary API shape and thumbnail hosts (expiring fbcdn URLs, recon.md) are unverified until the B8 doc fetch; the
  host allowlist is written from that fetch, not from memory.
- IndexedDB quota on phones with many routes: photos are pixelated JPEGs (<= 2048 px); B3 crit 11 handles a failed
  write without losing the in-memory station.
- Design deviation from the s2t Synthesis (binding unless Kev overrides): the Synthesis asked Claude Design for static
  HTML fragments; Part A asks for none (round 2 SC-F3: merging fragments breaks pinned markup). Flagged as Q4 for Kev;
  Part A ships as written unless Kev says otherwise.

---

# PART C: consolidation ledger

Status keys: KEEP (unchanged, own dispatch), KEEP-RESCOPED (kept, retargeted to the route design), DEPRECATED-by-pivot
(reason; re-home noted, never silently dropped), DONE.

## s2t (memripal-2026-10-31-s2t-handoff.md) new items
- 110 Map-to-palace super-plan: this document (DONE when emitted to docs/plans/2026-10-31-map-to-palace.md).
- 111 scenes.py provenance strip: -> B1.
- 112 War-site demo place: -> B2 (text) + B10 (fixture retirement and new demo replays).
- 113 Consolidation decisions: this Part C (DONE when emitted).

## s2s (done/memripal-2026-10-30-s2s-handoff.md) open items
- 109 MEM-045 brand-art review round: KEEP (brand art; independent of the pivot).
- 97 README hero art + logo after 109: KEEP.
- 108 ux-fixes-4 follow-ups: (a) tier-1 demo scene fixture replay test: DEPRECATED-by-pivot (pins the old room demo
  photo) -> re-homed to B10 CRITERIA (2). (b) clamp badge x/y in drawResult: KEEP (canvas still draws the station box).
  (c) 3-digit locus numbers overflow the badge: DEPRECATED-by-pivot (routes cap at 8 stations; v1 import dropped; no
  100+ loci). (d) badge numbers hard to read at 360px: KEEP-RESCOPED (station badge; check in B11 visual-verify).
  (e) only card 1 of the room demo has a demo scene: DEPRECATED-by-pivot (room demo archived; B10 records all 6).
- 104 Kev prunes merged worktrees: KEEP (Kev-run).
- 106 MEM-043 follow-ups: undecodable room file -> 500: KEEP (bug still in shipped /demo/photo.jpg?room=; HELD
  post-hackathon); app.py near cap: KEEP-RESCOPED as B0 + D7 ordering + the per-slice app.py <= 582 criterion.
- 94 Kev: gen_room_fixtures + live record per room: DEPRECATED-by-pivot (multi-loci room segmentation no longer used)
  -> re-homed to B10 K1 (live record per station).
- 100 Retro tasks R64..R92 (+ R93..R95 from s2t): KEEP (HELD post-hackathon).
- 95 Item 89 candidates: KEEP (HELD; loci prompt-caching sub-point applies to the station prompt too).
- 77 Kev: remove stale int-011 dir: KEEP (Kev-run).
- 68 Kev: record video per demo-script + TODO(Kev): KEEP-RESCOPED (script rewritten in B10).
- 70 Kev: live mic run in meta mode: KEEP.
- 59 Kev: record real demo scene fixtures: KEEP-RESCOPED (demo route stations, B10 K1).
- 54 Kev: docker build + Cloud Run deploy + MEMRIPAL_RECORD_KEY: KEEP (+ MEMRIPAL_MAPILLARY_TOKEN, B8 is above the cut
  in v2; B4 crit 10 keeps raw photos off the instance disk).
- 11 Kev: voice probe WAV: KEEP.
- 12 Kev: live probe on one real room photo, loci >= 10: DEPRECATED-by-pivot -> re-homed to B4 SIGNALS.
- 13 Kev: push main + make repo public: KEEP (gates: B10 CRITERIA (4), (6), (7)).
- 83 app.js source-regex test for MEM-039 await: KEEP (HELD).
- 66 MEMRIPAL_STT_PROVIDER unwired: KEEP (HELD).
- 64 Shared signing test helper: KEEP (HELD).
- 5 Promote script superseded by 93 (landed 0.19.0): DONE (close; B10 adds a --photo-sha mode to the same script).
- 6 Concurrency cap for POST /loci: KEEP-RESCOPED (cap POST /station in B4; /baseline in B8).
- 8 QUAL-014 remainder: KEEP (ASK-GATED Q18).
- 9 ask-recommendation-check gloss hook: KEEP (agent-workflow, ASK-GATED).
- 10 Global secret deny hook: KEEP (HELD).
- 19 solo_ff_merge own-pid refusal capture: KEEP (HELD until it reproduces).
- 45 Meta token budget on a 12-loci live run: DEPRECATED-by-pivot -> re-homed to B4 SIGNALS and B7 SIGNALS.
- 47 agent-workflow master red golden test: KEEP (peer-owned).
- 53 Retro tasks R1..R63: KEEP (HELD).

## train-r63i (meta-global-2026-2026-10-30-train-r63i-handoff.md)
- 6 R6 docgate output, 8 eb-w1-r3 conflict, 9 tell productivity owner, 11 F28 detach subcommand, 12 F29 claim probe,
  F30: all KEEP in their own chain (agent-workflow tooling; not merged into this plan).

---

# PART D: adversary round 1 arbitration Ledger (unchanged record; round-2 overrides in Part E, v2 overrides in Part F: SC-F1 "B8 below the cut" reversed by F1)

| ID | Sev | Finding | Verdict | Reason / where it landed |
|---|---|---|---|---|
| COR-F1 | critical | Zone-centre fuzz exports the first/last station (home) at 4 dp | ACCEPT | Keep-locations option removed; backups never carry coords (D6, B9) |
| COR-F2 | major | Null-box and baseline-only stations get 400 bad_box from /scenes | ACCEPT | Full-frame box fallback, scenes.js skip removed (B7) |
| COR-F3 | major | "9 points -> 6 items" impossible; /split photo unnamed | ACCEPT | loci_count = station count, station 1 photo named, 422 shown with retry (B7) |
| COR-F4 | major | Hard 3-8 rule blocks drafts, drops, v1 import (10-12) | ACCEPT, partly superseded | Drafts/drops kept; v1 import dropped in round 2 (R2 SC-F4), store now 0-8 |
| COR-F5 | major | Server cannot check route uniqueness; head-noun clashes | ACCEPT | used_names avoid-list, <= 3 words, client rename (D8, B4, B5) |
| COR-c1 | correctness | Pass-through still reports processed dims | ACCEPT, overruled in round 2 | Premise false: zoomFor uses fractions (R2 SC-F1) |
| COR-s1 | simplicity | Define privacy zone once; drop 24 h wait | ACCEPT | Zone removed entirely; cooldown to B12 |
| FM-F1 | critical | Blur step fails open (SAM [] reads as "no faces") | ACCEPT, hardened in round 2 | Strict parser (R2 FM-F1) |
| FM-F2 | critical | Box-less stations never get a scene | ACCEPT | Full-frame box (B7) |
| FM-F3 | major | Pass-through breaks overlay zoom | ACCEPT, overruled in round 2 | Overlay shows full image (R2 SC-F1) |
| FM-F4 | major | 200 m zone covers whole demo/loop routes | ACCEPT | Auto zone removed |
| FM-F5 | major | Offline "naming waits" promised but no queue | ACCEPT, rescoped in round 2 | Pending stations + manual retry; auto-retry dropped (R2 SC-F5) |
| FM-c1 | correctness | Pillow drift breaks fixture keys | ACCEPT | Pillow pinned + golden sha (B4) |
| FM-s1 | simplicity | Keep server resize, carry only provenance metadata | REJECT | item 111 purpose is unaltered bytes |
| FM-s2 | simplicity | 24 h clock and B14/B15 too much | ACCEPT (24 h) | 24 h to B12 |
| SEC-F1 | critical | Stripped backup leaks image_id/link, sign-text names, timestamps | ACCEPT | Field allowlist (B9, B4) |
| SEC-F2 | major | Zone centre undefined; tap sends coords | ACCEPT | Zone removed; B8 per-station opt-in |
| SEC-F3 | major | Demo route = Kev's block in a soon-public repo | ACCEPT | Public place, no coords (A3, B10) |
| SEC-F4 | major | "Blurred first" copy false; no fail-closed | ACCEPT | Copy rewritten; fail-closed |
| SEC-F5 | major | /baseline unauthenticated; token in URL | ACCEPT (in B8) | B8 crit 1 and 6 |
| SEC-s1 | simplicity | Drop keep-locations backup option | ACCEPT | D6 |
| SC-F1 | critical | B8 Mapillary costliest and unused by demo | ACCEPT | Below the cut, planned not dropped |
| SC-F2 | major | 24 h reuse wait cannot be shown | ACCEPT | Retire frees immediately (D5) |
| SC-F3 | major | 5 serial model calls; SAM sees unblurred photo | ACCEPT (modified) | 2 parallel blur phrases; copy reworded |
| SC-F4 | major | Backup fuzz = second privacy system | ACCEPT | Zone code removed |
| SC-F5 | minor | Timestamp ordering unneeded | ACCEPT | Capture order only (A6) |
| SC-c1 | correctness | Copy contradicts D3; name rule kills capture | ACCEPT | Copy fixed; user rename (B5) |
| SC-s1 | simplicity | Shrink Part A state table | ACCEPT (partial) | Own states per screen |

---

# PART E: adversary round 2 arbitration Ledger

Spot-verified by reading the primary checkout (meta-global-2026/memripal at a082c18, no execution): app.py is 581
lines and `_passcode_error` is a closure at :291; parsers span :184-259; backend.py:430 calls put_photo(req.image_jpeg)
in _store and cache_key hashes image_jpeg (:158); palace_export.js:10 MAX_IMPORT_BYTES = 1048576 and buildBackup /
parseBackup enforce it (:165, :174); imaging.py LONG_SIDE 2048, JPEG_QUALITY 90; probe_metrics.parse_boxes returns
only parsed tokens and _parse_token drops malformed ones silently; scenes.js zoomFor (:42-58) works in fractions and
the overlay (:121-130) shows the full image; recall_match.js createMatcher has no order check; index.html:34 holds
#auto. All cited premises held.

| ID | Sev | Finding | Verdict | Reason / where it landed |
|---|---|---|---|---|
| COR-F1 | critical | 582-line app.py cap unreachable for B1+B4+B7; B4 fails its own criterion | ACCEPT | New B0 moves parsers to bodies.py (app.py <= 515); D7 serial app.py order B0 -> B1 -> B4 -> B7; router factory takes the closure |
| COR-F2 | critical | v2 backup with 2048 px photos exceeds the 1 MiB cap; no backup at all | ACCEPT | D6/B9: 640 px q70 thumbnails + own MAX_BACKUP_BYTES 8 MiB (ADR); B9 crit 4 uses real-size photos (3x8) |
| COR-F3 | major | Practice ignores order; turn word lowers coverage; "/6" hard-coded | ACCEPT | D9: name-only targets, in-order post-pass, N = station count (B6 crit 4, 6, 7) |
| COR-F4 | major | Pending stations hold unblurred photo and get exported | ACCEPT (merged with FM-F2, SEC-F3) | D4/D6: pending and drafts skipped at export; B9 crit 3; 502 blur_failed = pending (D10, B3 crit 6) |
| COR-F5 | major | v1 import yields photo-less routes unusable downstream | ACCEPT via SC-F4 | v1 import dropped: "not supported" status (B9 crit 7); no MK item depends on it (A7) |
| COR-c | correctness | #auto placed in S1 and S4 | ACCEPT | #auto only in S1 #routes-settings; B3 crit 8 pins once |
| COR-c | correctness | Station block not in PROMPT_ARGS -> replay key collisions | ACCEPT | B7 carries station in PROMPT_ARGS; B7 crit 2 |
| COR-c | correctness | Per-axis box scaling wrong if Muse Image crops/pads | ACCEPT (via SC-F1) | Scaling removed; aspect mismatch > 2% -> identity zoom (D2, B1 crit 4) |
| COR-s | simplicity | Drop B1 dims plumbing; use naturalWidth/naturalHeight | ACCEPT | B1 uses naturalWidth/Height only for the aspect check |
| FM-F1 | critical | Strict helper still fail-open: parse_boxes returns [] for any token-free text | ACCEPT | D3 strict parser: empty body (or probe-recorded shape) only; dropped/rejected tokens -> BlurFailed; B4 crit 4-5 + probe signal |
| FM-F2 | major | Pending raw photo with EXIF GPS reaches backup | ACCEPT | Pending bytes stored only after reencodeJpeg (GPS read first); B3 crit 5 EXIF scan; B9 crit 3 |
| FM-F3 | major | Retry undefined for 502/429/404 online; no in-flight guard | ACCEPT | D10 status classes + one in-flight request; draft resumable; B3 crit 6-7 |
| FM-F4 | major | Turn words cause false hits ("red bench left" lights "red door") | ACCEPT | Turn words never matched (D9); B6 crit 5 |
| FM-F5 | minor | Learned n/6 per position goes stale after reorder/drop | ACCEPT | Hits keyed by station id, N = current count (B6 crit 7) |
| FM-s | simplicity | Drop online auto-retry-all | ACCEPT | Same as SC-F5 |
| SEC-F1 | critical | MetaBackend caches the raw photo on every live blur call, even on blur_failed | ACCEPT | D3 no-photo-cache flag on blur-phase requests; B4 crit 10 (photos/ holds only pixelated sha; 0 on blur_failed) |
| SEC-F2 | major | Demo replay of /station needs raw photos committed; promote script room-only | ACCEPT | Demo uses committed /station responses, never POSTs /station; promote --photo-sha mode for downstream replays (B10 crit 1, 4, 8) |
| SEC-F3 | major | Pending unblurred bytes exported | ACCEPT (merged with FM-F2) | As FM-F2 |
| SEC-F4 | minor | "Backups never include locations" false: names can name places | ACCEPT | Copy: "never include map coordinates; names and photos can show where you walk" (Part A S9, B11 crit 7) |
| SEC-F5 | minor | Fixed Gaussian radius may leave large faces recognisable | ACCEPT | Pixelation <= 8 blocks across box long side (D3); B4 crit 1 checks block count |
| SEC-s | simplicity | Drop live record-and-replay of /station for the demo | ACCEPT | Same as SEC-F2 |
| SC-F1 | major | B1 dims + client scaling changes nothing (zoomFor in fractions) | ACCEPT | Overrules round-1 COR-c1/FM-F3; B1 crit 3-4 replaced by same-output + aspect-mismatch tests |
| SC-F2 | major | B2 regenerates room-demo fixtures that B10 discards | ACCEPT | B2 = text scrub + denylist; room-demo fixtures archived (not deleted) in B10, demo replays recorded once |
| SC-F3 | major | Claude Design fragment merge on Mon breaks pinned markup/tests | ACCEPT | Part A asks for route.css + class contract + state table + id map, no HTML; B11 crit 2, 8 |
| SC-F4 | minor | v1 import forces 0-12 cap for no real users | ACCEPT | v2 only; store caps at 8; Part C 108(c) updated |
| SC-F5 | minor | Online auto-retry duplicates manual retry, double budget | ACCEPT | Manual Retry + in-flight flag only (D10) |
| SC-c | correctness | B1 crit 4 tests an overlay zoom that does not exist; real gap is aspect mismatch | ACCEPT | Aspect-mismatch identity zoom (B1 crit 4) |

No finding rejected or deferred. Overruled round-1 items: COR-c1 and FM-F3 (premise disproved by SC-F1). Must-keep
check: MK1-MK5 all remain above the cut; MK3 and MK5 are now measured more strictly (in-order, id-keyed, N = count);
the dropped v1 import and auto-retry serve no MK item.

---

# PART F: finisher critique (v1-r2 -> v2)

Read-only critique of plan-v1-r2 against prompt.md, recon.md and the s2t Synthesis (primary checkout memripal main
a082c18, unchanged). Every finding was applied; none rejected.

| ID | Kind | Finding in v1-r2 | Applied in v2 |
|---|---|---|---|
| F1 | gap (must-keep) | Kev's verbatim "have baseline picture from meta's mapillary" sat below the cut (round 1 SC-F1): a deferral the user never asked for; MK list omitted the pivot asks entirely | MK6-MK9 added with verbatim quotes; B8 moved above the cut with client UI, CRITERIA 9-11, D1/A1-A3 rewritten, D7 order extended, schedule + lanes updated |
| F2 | contradiction | Cut line "Mon Nov 3 EOD"; 2026-11-02 is the Monday | Cut line and schedule say Mon Nov 2 / Tue Nov 3 |
| F3 | contradiction | Part A said "Location stays on your device" and "hidden in this build" for the baseline while B8 egress is planned | #meta-notice, safety copy, S3 opt-in + status ids, S5 toggle, S9 backup copy rewritten; B11 crit 7 pins the opt-in text |
| F4 | ambiguity | D9 "span start after previous counted hit" did not say whether hits are walked in transcript or route order (reverse order scores 6 or 1) | D9 walks route order, earliest qualifying span; B6 crit 4 values now follow uniquely |
| F5 | gap | List-mode spoken recall lighting map dots (MK4, storyboard hero) had no criterion | B7 crit 10 |
| F6 | gap | Storyboard beat "second list same route" (Synthesis) not in B7/B10 | B7 crit 11, B10 demo lists + crit 10 |
| F7 | gap | Route delete and list retire arm -> confirm -> Undo (Part A + global UI rule) untested; S4 row drop untested | B6 crit 10, B7 crit 9, B3 crit 10 |
| F8 | gap | MK1 "many routes" and MK5 "hit rates" had no countable check | B6 crit 11, 12 |
| F9 | gap | B2 grep scope missed scripts/make_synthetic_fixtures.py and spec-2.md MEM-025 (recon.md lists both) | B2 scope + crit 1, 3 |
| F10 | gap (security) | Backup import: no id-collision rule, no photo data-URL validation, no pre-parse size refusal | D11; B9 crit 9-11 |
| F11 | gap (security) | /station had no upload type/size criterion; "concurrency cap (item 6)" assumed a /loci cap that never landed | B4 crit 12, 13 |
| F12 | unverifiable | B11 crit 6 "visual-verified" is a judgment, not a count | Computed contrast check as crit 6; visual-verify moved to SIGNALS |
| F13 | unverifiable | B14 criteria not countable; B15 had no CRITERIA/SIGNALS (FLOW-016) | Both now carry numbered CRITERIA + SIGNALS |
| F14 | missing signal | B4 probe had no fallback if Kev's probe is late | Stricter empty-only rule until the probe lands |
| F15 | risk | B10 recording depends on Claude Design delivery (B11) with no fallback | Record on existing CSS if B11 is late (sequencing, not a cut) |
| F16 | precision | B10 crit 5 `git grep` "Emu" would hit "Emulator" | `-w` word match |
| F17 | deviation | Part A drops the Synthesis's "static HTML fragment per screen" (binding unless Kev overrides) | Kept (SC-F3 rationale) and surfaced as Q4 |

Must-keep check after v2: MK1-MK9 all above the cut, each with a slice and at least one numbered criterion. Below the
cut (B12-B15) holds no verbatim ask; B14 is an extension of MK2 beyond the walk-once reading (Q2).

## Open questions for Kev (none blocks Saturday's dispatch)
- Q1 Which public, non-residential demo place (needs Mapillary coverage near >= 3 stations)? Gates the B8 probe and K1.
- Q2 Does "routes where they dont use day to day can be mapped" mean walked once (built above the cut) or also mapped
  without walking (B14, below the cut)? If the latter, B14 moves above the cut on your word.
- Q3 Mapillary client token for MEMRIPAL_MAPILLARY_TOKEN (gates B8 live probe, K1 baselines, deploy).
- Q4 OK to ask Claude Design for CSS + class contract + state table + id map but NO HTML fragments (deviates from the
  s2t Synthesis wording)?

## Adversarial cheat sheet
1. Primary technical risk: the privacy pipeline was still fail-open in three places: the SAM box parser read any
   refusal or reformatted reply as "no people", MetaBackend cached every raw unblurred photo to disk (even on
   blur_failed), and pending stations' unblurred photos (possibly with EXIF GPS) flowed into backups.
2. Fix: a strict parser (only an empty or probe-recorded empty reply means "none"; anything else -> 502 blur_failed,
   0 Spark calls); blur-phase requests skip put_photo, tested against a real MetaBackend cache dir; pending photos are
   EXIF-stripped, kept local and excluded from v2 backups (which also gain thumbnails and their own 8 MiB cap); the
   demo ships recorded /station responses instead of raw photos; pixelation replaces a fixed-radius blur.
3. Lingering doubt: SAM 3.1's recall on faces and plates is not deterministic; a person SAM fails to box at all
   (returning a valid empty reply) stays unpixelated, so "faces hidden" rests on model quality plus Kev's eyeball
   probe, not on a guarantee.
