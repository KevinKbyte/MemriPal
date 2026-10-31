# MemriPal route UX: class contract, state tables, id map

These go with `route.css`. Load it last: `<link rel="stylesheet" href="/static/route.css">` after `theme-painterly.css`.
The CSS has no HTML, no JavaScript and no new ids.

## 0. Before you start

### 0.1 Product changes made after the brief (product owner, 2026-10-31)

1. **Chunking.** S6 no longer uses "up to one key point per station". The user pastes what they want to remember. Muse Spark
   breaks it into key points and packs each station's points into one mnemonic or acronym, so one station can hold more than one
   fact. Each association card shows the mnemonic (`.assoc-chunk`), the points it packs (`.assoc-points`), then the 8 channels.
   - New `#list-notes` label: "Paste what you want to remember. Muse Spark breaks it into key points and packs them into a
     mnemonic or acronym at each station, so one station can hold more than one point."
2. **Place facts as hooks.** If a station is at or near a place with a recorded history or a fun fact, that fact can anchor the
   station's channels when it ties in with what is being remembered. On the card it shows as `.assoc-place-fact` with chip
   "Muse Spark" and a `.credit` line "Place facts: Wikipedia, CC BY-SA".
   - New `#place-settings` legend: "Place facts (optional)". Line under it: "If your route passes a place with a history or a
     fun fact, Muse Spark can tie it into each station's cues."

### 0.2 Privacy copy that does not match the code (fix before shipping)

The brief says location stays on the device except for Mapillary. That is false once place facts are on: `#place-toggle` sends
a position to the MemriPal server, which looks it up on Wikipedia GeoSearch (`docs/decisions/0022-opt-in-place-context-server-lookup.md`;
source named in `scripts/make_synthetic_fixtures.py:38`). Product owner decision (2026-10-31): place facts are a user setting,
off by default, and what is sent is the station's landmark position from the chosen map source, never the user's exact
coordinates.
- `#place-toggle` lives in S1 `#routes-settings` next to `#passcode` and `#auto`, unchecked by default. `#place-typed` and
  `#places` stay in S5 `#place-settings`.
- `#place-toggle` label: "Look up place facts for my stations (off by default): sends each station's landmark position, not
  your exact location, to Wikipedia through MemriPal's server."
- `#meta-notice`: end with "...unless you ask for a street photo or turn on place facts, which send a landmark position."
- `#capture-locate` label: "Use my location for this walk (stays on this device; place facts and street photos send only a
  landmark position)."
- Dependency: this copy is not true yet. The map/landmark source is not chosen (ADR pending), and the 0022 server lookup takes
  photo EXIF/device coordinates today. The code must switch to landmark positions before this copy ships.

### 0.3 Elements with no id in the brief

No new ids were added. Script can find these by class inside their screen (or add ids, which changes the brief):
`p.empty-text` (S1), `p.baseline-nolocation` (S3), `ul.form-error` (S4), `p.lede` empty line (S5), `p.form-error` (S8).

### 0.4 `#place-settings` is a fieldset

A fieldset cannot collapse without script or `<details>`. The CSS styles it open (`.place-facts`). To collapse it, make it
`<details id="place-settings" class="settings">` with the legend text in `<summary>`; `.settings` already styles that.

## 1. Shared contract

| Where | Classes | Notes |
|---|---|---|
| `<main>` | `app` | One column on a phone; 2-column grid at >= 900px. Nothing above `#scene-overlay` gets transform/filter/contain. |
| every screen root (S1-S9 sections, `#walk`) | `panel screen` | `.panel` from style.css. `#scenes` is a plain div (`scene-cards`), not a panel. |
| screen heading `h2` | `screen-title` | --display. |
| sub-heading `h3` | `sub-title` | |
| intro line `p` | `lede` | |
| `p[role=status]` | `status-line` | Keeps one line of height. |
| buttons | `btn`, primary `btn btn-primary` | 44x44 min. Disabled: dashed edge, full-contrast text. |
| delete or drop | `btn arm` / `btn confirm` / `btn cancel` / `btn undo` | See 1.1. |
| model chip `span` | `model-chip` | "Muse Spark", "SAM 3.1", "Muse Image", "Muse Voice Transcribe", "Mapillary" (baseline only). |
| badges/chips `span` | `badge-live`, `badge-replay`, `chip-ai`, `chip-imagined`, `badge-pending`, `badge-not-walked` | Text per brief. Ink on soft fill: >= 7:1 both modes. |
| tags `span` | `tag`, `tag-kind`, `tag-draft`, `learned` | |
| per-item retry | `btn capture-retry` | |
| thumbnail `img` | `thumb` | 56x56 cover. |
| visually hidden | `vh` | Focusable, read aloud (`#photo`, `#loci`). |
| inline error | `field-error` (one message), `form-error` (`ul` or `p`) | |
| route map `svg` | `route-map` | `polyline.route-line`, then `g.station-node` (`circle r=10` + `text`); node states `current`, `lit`, `missed`. |
| legend `p` under a map | `map-legend` | `span.legend-key` + `current`/`lit`/`missed` (CSS dot + text: "You are here", "Said", "Missed"). |

### 1.1 Delete pattern (station, route, list, rehearsal, strip item, finish row)

| Phase | `.arm` | `.confirm` | `.cancel` | `.undo` |
|---|---|---|---|---|
| at rest | shown | hidden | hidden | hidden |
| armed | hidden | shown, gets focus | shown | hidden |
| deleted | hidden (item gone, or `li.dropped`) | hidden | hidden | shown |
| Cancel / Undo / next action | back to at rest | | | |

## 2. Class contract per screen

Columns: id; element it already is; classes on it; classes on direct children (DOM order). "(item)" = parts of a script-rendered list item.

### S1 Routes home

| id | element | classes | direct children |
|---|---|---|---|
| `#routes-home` | section | `panel screen` | `h2.screen-title` "Your routes", `p.lede`, `#routes-list`, `#empty-state`, `p.empty-text` "No routes yet", `#routes-new`, `#load-demo`, `#routes-settings` |
| `#routes-list` | ol | `route-cards` | `li.route-card` |
| (item) `li.route-card` | li | `route-card` | `h3.route-card-name`, `p.route-card-meta` (`span.tag-kind` + "6 stations"), `p.route-card-learned` "Learned 4/6 stations", `p.route-card-list`, `span.tag-draft` (unfinished walk only), `button.btn.route-card-open` "Open" |
| `#empty-state` | img | none | none |
| `#routes-new` | button | `btn btn-primary` | none |
| `#load-demo` | button | `btn` | none |
| `#routes-settings` | details | `settings` | `summary` "Live settings", `div.field` (label + `#passcode`), `label.check` (`#auto` + text), `label.check` (`#place-toggle` + text, unchecked by default; see 0.2) |
| `#passcode` | input[type=password] | none | none |
| `#auto` / `#place-toggle` | input[type=checkbox] | none | none |

### S2 Walking: capture (text >= 7:1)

| id | element | classes | direct children |
|---|---|---|---|
| `#capture-session` | section | `panel screen` | in order: `h2.screen-title` (optional), `#capture-safety`, `#meta-notice`, `#capture-strip`, `#upload-status`, `label.check.locate` (holds `#capture-locate`), `#capture-count`, `#capture-finish`, `label.btn.btn-primary.capture-btn`. `#photo` inside the Capture label or just before it. Each child has a named grid area; any other direct child breaks the thumb-zone layout. |
| `#capture-safety` | div | `notice` | `p`, `#capture-safety-ok` |
| `#capture-safety-ok` | button | `btn btn-primary` | none |
| `#meta-notice` | p | `notice` | none |
| `#capture-strip` | ol | `strip` | `li.strip-item` (`.dropped` after a drop: shows only Undo) |
| (item) `li.strip-item` | li | `strip-item` | `img.strip-thumb`, `span.strip-name`, `span.badge-pending`, `button.btn.capture-retry`, `button.btn.arm` "Drop", `button.btn.confirm`, `button.btn.cancel`, `button.btn.undo`. Number = CSS counter. |
| `#upload-status` | p[role=status] | `status-line` | text, `span.model-chip` "SAM 3.1", `span.model-chip` "Muse Spark" |
| `#photo` | input[type=file] | `vh` | none |
| `#capture-locate` | input[type=checkbox] | none (parent label `check locate`) | none |
| `#capture-count` | p | none | none |
| `#capture-finish` | button | `btn` | none |

### S3 Station card (text >= 7:1)

| id | element | classes | direct children |
|---|---|---|---|
| `#station-card` | section | `panel screen` | `h2.screen-title`, `#scene-wrap`, `label.check.baseline-optin` (holds `#station-baseline-optin`), `p.baseline-nolocation`, `#station-baseline-status`, `#station-baseline`, `div.field` (label with `span.model-chip`, `#station-name`, `#station-name-error`), `h3.sub-title` (with `span.model-chip`), `#station-profile`, `#station-taps`, `#station-save`, `#station-drop`, `#station-drop-confirm`, `#station-drop-cancel`, `#station-undo`, `#loci` |
| `#scene-wrap` | div | `photo-frame` | `#scene`, `span.model-chip` "SAM 3.1" |
| `#scene` | canvas | none | none |
| `#station-baseline-optin` | input[type=checkbox] | none | none |
| `#station-baseline-status` | p[role=status] | `status-line` | none |
| `#station-baseline` | figure | `baseline` | `#station-baseline-img`, `figcaption.baseline-caption` (`span.model-chip` "Mapillary", `span.badge-not-walked`, `span.badge-replay`, `#station-baseline-credit`) |
| `#station-baseline-img` | img | none | none |
| `#station-baseline-credit` | p | `credit` | `img.credit-logo` (`/static/assets/mapillary-logo.svg`, alt "Mapillary"), `span` "Photo: author / Mapillary, CC BY-SA", `a.credit-link` "View on Mapillary" |
| `#station-name` | input[type=text] maxlength=40 | `name-input` | none |
| `#station-name-error` | p | `field-error` | none |
| `#station-profile` | dl | `profile` | `dt` + `dd` x3 |
| `#station-taps` | fieldset | `taps` | `legend`, `#tap-sound`, `#tap-smell`, `#tap-feel`, `#tap-mood`, `#tap-turn` |
| `#tap-sound` `#tap-smell` `#tap-feel` `#tap-mood` `#tap-turn` | div[role=group] | `tap-group` | `span.tap-label` (aria-labelledby target), `button.tap[aria-pressed]` |
| `#station-save` | button | `btn btn-primary` | none |
| `#station-drop` / `-confirm` / `-cancel` | button | `btn arm` / `btn confirm` / `btn cancel` | none |
| `#station-undo` | button | `btn undo` | none |
| `#loci` | ol | `vh` | `li` |

Below 480px the two photos stack; from 480px they sit side by side while `#station-baseline` is shown (`:has()`).

### S4 Finish walk

| id | element | classes | direct children |
|---|---|---|---|
| `#route-review` | section | `panel screen` | `h2.screen-title` "Finish walk", `div.field` (label + `#finish-name`), `#finish-kind`, `p.order-note`, `#route`, `#route-undo`, `ul.form-error`, `#finish-save` |
| `#finish-name` | input[type=text] | none | none |
| `#finish-kind` | fieldset | `kind-pick` | `legend`, `label.kind-option` x2 (radio name=finish-kind + text) |
| `#route` | ol | none | `li.station-row` |
| (item) `li.station-row` | li | `station-row` | `img.thumb`, `span.row-name` (holds `span.badge-pending` if unnamed), `span.row-turn`, `button.btn.move-up`, `button.btn.move-down`, `button.btn.arm`, `button.btn.confirm`, `button.btn.cancel`. Number = style.css counter. |
| `#route-undo` | button | `btn undo` | none |
| `#finish-save` | button | `btn btn-primary` | none |

### S5 Route view

| id | element | classes | direct children |
|---|---|---|---|
| `#route-view` | section | `panel screen` | `h2.screen-title` (+ `span.route-kind`), `p.lede` (empty only), `#route-map`, `p.map-legend`, `#route-view-stations`, `#route-view-practice`, `#route-view-baseline`, `span.model-chip` "Mapillary", `#place-settings`, `#route-view-lists`, `#route-view-in-use`, `#route-view-delete`, `#route-view-delete-confirm`, `#route-view-delete-cancel`, `#route-view-undo` |
| `#route-map` | svg viewBox="0 0 320 200" | `route-map` | `polyline.route-line`, `g.station-node` |
| `#route-view-stations` | ol | `station-list` | `li.station-item` |
| (item) `li.station-item` | li | `station-item` | in order: `img.thumb`, `img.item-baseline` (if baseline), `span.item-num`, `span.item-name`, `span.item-turn`, `span.tag` (sound), `span.tag` (smell), `span.learned`, `span.model-chip` "Mapillary" (with baseline) |
| `#route-view-practice` | button | `btn btn-primary` | none |
| `#route-view-baseline` | button[aria-pressed] | `btn toggle` | none |
| `#place-settings` | fieldset | `place-facts` | `legend`, `div.field` (label + `#place-typed`), `#places` (the on/off switch is in S1 `#routes-settings`) |
| `#place-typed` / `#places` | input text / div | none | none |
| `#route-view-lists` | div | `list-summary` | `span.summary-name`, `#route-view-add-list` |
| `#route-view-add-list` | button | `btn` | none |
| `#route-view-in-use` | p | `notice` | none |
| `#route-view-delete` / `-confirm` / `-cancel` / `#route-view-undo` | button | `btn arm` / `btn confirm` / `btn cancel` / `btn undo` | none |

### S6 List on route

| id | element | classes | direct children |
|---|---|---|---|
| `#list-panel` | section | `panel screen` | `h2.screen-title`, `div.field` (label + `#list-name`), `div.field` (label + `#list-notes`), `#list-split`, `span.model-chip` "Muse Spark", `#assoc-status`, `#associations`, `#generate`, `span.model-chip` "Muse Image", `#list-retire`, `#list-retire-confirm`, `#list-retire-cancel`, `#list-retire-undo` |
| `#list-name` | input[type=text] | none | none |
| `#list-notes` | textarea | `list-notes` | none |
| `#list-split` | button | `btn` | none |
| `#assoc-status` | p[role=status] | `status-line` | none |
| `#associations` | div | `assoc-cards` | `article.assoc-card` (aria-busy while working) |
| (item) `article.assoc-card` | article | `assoc-card` | `h3.assoc-station`, `p.assoc-chunk` (mnemonic/acronym), `ul.assoc-points`, `p.assoc-item` (single point instead of chunk+points), `div.assoc-place-fact` (fact text + `p.credit`), `ul.channels`, `span.model-chip` "Muse Spark", `span.badge-replay`, `p.card-progress`, `button.btn.capture-retry` |
| (part) `ul.channels` | ul | `channels` | `li.channel` x8: `b.channel-name` + cue; olfactory and gustatory add `span.chip-imagined` |
| `#generate` | button | `btn btn-primary` | none |
| `#list-retire` / `-confirm` / `-cancel` / `-undo` | button | `btn arm` / `btn confirm` / `btn cancel` / `btn undo` | none |

### S7 Scene walk

| id | element | classes | direct children |
|---|---|---|---|
| `#scenes` | div[aria-live=polite] | `scene-cards` | `article.scene-card` (aria-busy while painting) |
| (item) `article.scene-card` | article | `scene-card` | `img.scene-img` (or existing `div.scene-frame > img.scene-img`; none on a text-only card), `span.chip-ai`, `h3.scene-station`, `p` (item), `p.card-progress` (+ `span.model-chip` "Muse Image"), `span.badge-replay` |
| `#walk` | section | `panel screen` | `h2.screen-title`, `#walk-step`, `#walk-prev`, `#walk-next` |
| `#walk-step` | div | `walk-step` | `p.walk-count`, `img.scene-img`, `p.walk-cue`, `p.walk-item` |
| `#walk-prev` / `#walk-next` | button | `btn` | none |
| `#scene-overlay` | div | none | direct child of `<main>` |

### S8 Recall

| id | element | classes | direct children |
|---|---|---|---|
| `#recall` | section | `panel screen` | `h2.screen-title`, `#recall-mode`, `#recall-map`, `p.map-legend`, `#recall-start`, `#recall-replay`, `#recall-typed`, `#recall-submit`, `p.form-error` "Speech relay failed", `#recall-live`, `#recall-results`, `p.plain-code` "Matching is plain code, no AI." |
| `#recall-mode` | p | `recall-mode` | none |
| `#recall-map` | svg viewBox="0 0 320 200" | `route-map` | as `#route-map` |
| `#recall-start` | button | `btn btn-primary` | none |
| `#recall-replay` / `#recall-submit` | button | `btn` | none |
| `#recall-typed` | textarea | none | none |
| `#recall-live` | div | `live-board` | `span.badge-live` or `span.badge-replay`, `span.model-chip` "Muse Voice Transcribe", `ol` (style.css `li.lit`) |
| `#recall-results` | div | none | style.css `li.said-got` / `li.said-missed` |

### S9 Results, history, backup

| id | element | classes | direct children |
|---|---|---|---|
| `#history` | section | `panel screen` | `h2.screen-title`, `p[role=status]` (error), `#rehearsals`, `#rehearsal-undo`, `#history-view`, `h3.sub-title`, `#hit-rates`, `#history-intrusions` |
| `#rehearsals` | ol | `rehearsal-list` | `li.rehearsal`: `time.reh-date`, `span.reh-mode`, `span.reh-score`, `button.btn.arm` (keeps `data-action="delete-rehearsal"`), `button.btn.confirm`, `button.btn.cancel` |
| `#rehearsal-undo` | button | `btn undo` | none |
| `#history-view` | div | none | none |
| `#hit-rates` | ul | `hit-rates` | `li.hit-rate`: `span` + `span.hit-value` |
| `#history-intrusions` | ul | none | none |
| `#backup` | section | `panel screen` | `h2.screen-title`, `#backup-export`, `p.privacy-note`, `div.field` (label + `#backup-import`), `#backup-status` |
| `#backup-export` | button | `btn` | none |
| `#backup-import` | input[type=file] | none | none |
| `#backup-status` | p[role=status] | `status-line` | none |
| `#public-banner` (top of main) | p | `notice` | none |
| `#status` (top of main) | p | `status-line` | none |

## 3. State tables

S = shown, H = hidden attribute. Arm/confirm/undo follow 1.1 in every state.

### S1
| element | empty | ready | offline |
|---|---|---|---|
| `#routes-list` | H | S | S if routes saved, else H |
| `#empty-state`, `p.empty-text` | S | H | S if no routes |
| `#routes-new` | S | S | S |
| `#load-demo` | S | S | S (enabled) |
| `#routes-settings` | S | S | S |
| `span.tag-draft` | n/a | S on unfinished walk | as ready |

### S2
| element | capturing | uploading | error | offline |
|---|---|---|---|---|
| `#capture-safety` | S on first walk until OK (Capture disabled until then), else H | H | H | H |
| `#meta-notice` | S | S | S | S |
| `#capture-strip` | S (H at 0 stations) | S | S | S |
| `#upload-status` | S (empty) | S "Naming the landmark..." + SAM 3.1, Muse Spark chips | S error text | S "Saved on this phone. Tap Retry when you are back online." |
| `.capture-btn` | S | S (`#photo` disabled) | S | S |
| `label.locate`, `#capture-count` | S | S | S | S |
| `#capture-finish` | S (disabled under 3 named) | S (disabled) | S | S |
| `.badge-pending` (item) | H | S on item being named | S on failed item | S on unnamed items |
| `.capture-retry` (item) | H | H | S on failed item | S on unnamed items |

### S3
| element | uploading | ready | error | offline | baseline-loading | baseline-shown | baseline-none | recorded-replay |
|---|---|---|---|---|---|---|---|---|
| `#scene-wrap`, `#station-taps` | S | S | S | S | S | S | S | S |
| `#station-name` | S (disabled, "Naming...") | S | S | S | S | S | S | S |
| `#station-name-error` | H | H | S | H | H | H | H | H |
| `#station-profile` | H | S | S | S if named | S | S | S | S |
| `label.baseline-optin` | S (disabled) | S | S | S (disabled) | S | S | S | S |
| `p.baseline-nolocation` | S if no coordinates | same | same | same | H | H | H | H |
| `#station-baseline-status` | H | H | H | H | S "Looking for a nearby street photo..." | H | S "No street photo near this station." | H |
| `#station-baseline`, `.badge-not-walked` | H | H | H | H | H | S | H | S |
| `.badge-replay` (figure) | H | H | H | H | H | H | H | S |
| `#station-save` | S (disabled) | S | S (disabled until unique) | S | S | S | S | S |

### S4
| element | ready | error | uploading |
|---|---|---|---|
| `#finish-name`, `#finish-kind` | S | S | S (disabled) |
| `p.order-note`, `#route` | S | S | S |
| `.badge-pending` (row) | H | S on unnamed rows | H |
| `ul.form-error` | H | S (3-8 stations; names pending; duplicate names) | H |
| `#finish-save` | S | S (disabled) | S (disabled, "Saving...") |

### S5
| element | empty | ready | offline |
|---|---|---|---|
| `p.lede` "No stations yet. Start a new walk to add some." | S | H | H |
| `#route-map`, `p.map-legend`, `#route-view-stations`, `#route-view-practice`, `#route-view-lists` | H | S | S |
| `#route-view-baseline` + chip | H | S if >= 1 baseline | S if >= 1 baseline |
| `#place-settings` | S | S | S (lookup disabled) |
| `#places` lookups | n/a | only if S1 place-facts setting is on (off by default) | none |
| `#route-view-in-use` | H | H (S after Add list while a list is active) | as ready |

### S6
| element | empty | uploading | ready | error | recorded-replay |
|---|---|---|---|---|---|
| `#list-name`, `#list-notes` | S | S (disabled) | S | S | S |
| `#list-split` | S (disabled while notes empty) | S (disabled) | S | S | S |
| `#assoc-status` | S (empty) | S "Finding key points..." | S "6 stations, 14 key points" | S error summary | S |
| `#associations` | H | S | S | S | S |
| `.card-progress` | n/a | S on working cards | H | H | H |
| `.assoc-chunk` + `.assoc-points` | n/a | H until ready | S when station holds >= 2 points | S on ready cards | S |
| `.assoc-item` | n/a | H until ready | S when station holds 1 point | S on ready cards | S |
| `.assoc-place-fact` | n/a | H | S if station has a place fact | as ready | as ready |
| `.capture-retry` (card) | n/a | H | H | S on failed cards | H |
| `.badge-replay` (card) | n/a | H | H | H | S |
| `#generate` | H | H | S | S (disabled while a card failed) | S |
| `#list-retire` | H | S | S | S | S |

### S7
| element | uploading | ready | error | recorded-replay |
|---|---|---|---|---|
| `#scenes`, `.chip-ai` | S | S | S | S |
| `.scene-img` | H while painting | S | H (text-only card) | S |
| `.card-progress` + Muse Image chip | S | H | H | H |
| `.badge-replay` | H | H | H | S |
| `#walk` | H | S | S | S |
| `#walk-prev` / `#walk-next` | n/a | S (Prev disabled at 1) | S | S |

### S8
| element | ready | LIVE | recorded-replay | error | offline |
|---|---|---|---|---|---|
| `#recall-mode`, `#recall-map`, `p.map-legend`, `#recall-submit`, `p.plain-code` | S | S | S | S | S |
| `#recall-start` | S | S (disabled) | S (disabled) | S | H |
| `#recall-replay` | S | S (disabled) | S (disabled) | S | S |
| `#recall-typed` | H | H | H | S | S |
| `p.form-error` | H | H | H | S | H |
| `#recall-live` | H | S + `.badge-live` | S + `.badge-replay` | H | H (S during replay) |
| `#recall-results` | S after Done | H | H | S after Done | S after Done |

### S9
| element | empty | ready | error |
|---|---|---|---|
| `p[role=status]` | H | H | S |
| `#rehearsals`, `h3.sub-title`, `#hit-rates` | H | S | H |
| `#history-view` | S "No rehearsals yet." | S | H |
| `#history-intrusions` | H | H | H |
| `#backup` | S | S | S |

## 4. Id map

### Existing ids
| old id | screen | role |
|---|---|---|
| `public-banner`, `status` | top of main | Passcode/demo banner; backend and offline status. |
| `meta-notice`, `photo`, `upload-status` | S2 | Privacy notice; hidden input behind Capture; naming live region. |
| `passcode`, `auto`, `place-toggle`, `load-demo`, `empty-state` | S1 | Live passcode, skip-review and place-facts opt-in (off by default; all in `#routes-settings`); demo route; empty picture. |
| `place-settings`, `place-typed`, `places` | S5 | Place facts (history or fun facts) that feed hooks; see 0.2. |
| `scene-wrap`, `scene`, `loci` | S3 | Photo frame; canvas photo + box; hidden landmark list. |
| `assoc-status`, `associations` | S6 | Progress; cards: mnemonic, points, place fact, 8 channels. |
| `generate` | S6 (moved from S4) | "Make scenes". |
| `route-review`, `route`, `route-undo` | S4 | Finish walk; stations in order; undo a dropped row. |
| `scenes`, `walk`, `walk-step`, `walk-prev`, `walk-next` | S7 | Scene cards and step walk. |
| `recall`, `recall-start`, `recall-replay`, `recall-typed`, `recall-submit`, `recall-live`, `recall-results` | S8 | Recall. |
| `history`, `rehearsals`, `rehearsal-undo`, `history-view`, `hit-rates` | S9 | History and hit rate per station. |
| `backup`, `backup-export`, `backup-import`, `backup-status` | S9 | Backup. |
| `scene-overlay` | direct child of main | Zoomed scene over any screen. |

### New ids
| new id | screen | role |
|---|---|---|
| `routes-home`, `routes-list`, `routes-new`, `routes-settings` | S1 | Section; route cards; "New walk"; Live settings. |
| `capture-session`, `capture-safety`, `capture-safety-ok`, `capture-strip`, `capture-locate`, `capture-finish`, `capture-count` | S2 | Section; safety notice + OK; thumbnails; location opt-in; Finish walk; count. |
| `station-card`, `station-baseline-optin`, `station-baseline-status`, `station-baseline`, `station-baseline-img`, `station-baseline-credit` | S3 | Section; Mapillary opt-in, status, figure, photo, credit. |
| `station-name`, `station-name-error`, `station-profile`, `station-taps`, `tap-sound`, `tap-smell`, `tap-feel`, `tap-mood`, `tap-turn` | S3 | Name, clash error, profile, quick-tap groups. |
| `station-save`, `station-drop`, `station-drop-confirm`, `station-drop-cancel`, `station-undo` | S3 | Save; drop pattern. |
| `finish-name`, `finish-kind`, `finish-save` | S4 | Route name; Daily/Occasional; Save route. |
| `route-view`, `route-map`, `route-view-stations`, `route-view-practice`, `route-view-baseline` | S5 | Section; map; station list (map's text equivalent); practice; photo toggle. |
| `route-view-lists`, `route-view-add-list`, `route-view-in-use` | S5 | Active list; add list; route-in-use notice. |
| `route-view-delete`, `route-view-delete-confirm`, `route-view-delete-cancel`, `route-view-undo` | S5 | Delete route pattern. |
| `list-panel`, `list-name`, `list-notes`, `list-split` | S6 | Section; list name; pasted material; Find key points (points, mnemonics, acronyms). |
| `list-retire`, `list-retire-confirm`, `list-retire-cancel`, `list-retire-undo` | S6 | Retire list pattern. |
| `recall-mode`, `recall-map` | S8 | Mode line; map that lights as the user speaks. |
| `history-intrusions` | S9 | Reserved, hidden. |
