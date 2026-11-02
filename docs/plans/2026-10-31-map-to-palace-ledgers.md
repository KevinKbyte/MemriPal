# MemriPal map-to-palace plan: ledgers (Parts C-G)

Records split from [2026-10-31-map-to-palace.md](2026-10-31-map-to-palace.md) (ADR-0009 D3 line cap). Live plan text
(Must-keep, Scope, Decisions, Part A, Part B, schedule, risks, open questions) stays there.

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
  in v2; B4 crit 10 keeps raw photos off the instance disk; v3: max instances = 1, because the B14a OSM limiter and
  memo are in-process).
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

## s2y (memripal-2026-10-31-s2y-handoff.md)
- 136 Amend the plan for Kev's Q1/Q2/Q4 answers: DONE in v3 (Part G).
- 137 Recreate the lost demo-place denylist probe as a scripts/ tool + test + README entry: -> B10.
- 138 Boston demo place: -> A3, B10 (Part G).

---

# PART D: adversary round 1 arbitration Ledger

Unchanged record; round-2 overrides in Part E, v2 overrides in Part F: SC-F1 "B8 below the cut" reversed by F1.

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
| SC-F3 | major | Claude Design fragment merge on Mon breaks pinned markup/tests | ACCEPT; Overridden by Kev Q4 2026-10-31 (Allow HTML); see Part G | Part A asks for route.css + class contract + state table + id map, no HTML; B11 crit 2, 8. v3: fragments allowed as reference markup only (Part A deliverable 5, B11 crit 9-10) |
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
| F17 | deviation | Part A drops the Synthesis's "static HTML fragment per screen" (binding unless Kev overrides) | Kept (SC-F3 rationale) and surfaced as Q4. Overridden by Kev Q4 2026-10-31 (Allow HTML); see Part G |

Must-keep check after v2: MK1-MK9 all above the cut, each with a slice and at least one numbered criterion. Below the
cut (B12-B15) holds no verbatim ask; B14 is an extension of MK2 beyond the walk-once reading (Q2). v3: Kev answered
Q2 "#2"; B14 is superseded by B14a-c above the cut (Part G).

---

# PART G: item 136 amendment (v2 -> v3) and its adversary round

Base amendment: plan-notes memripal-2026-10-31-b14-boston-q4-amendment.md (also holds the denylist-probe
coordinates; this repo commits none outside the B10 probe tool). Adversaries: b14-adv-correctness (lenses correctness
+ failure-modes; 0 veto, 11 major, 13 minor) and b14-adv-simplicity (simplicity-cost + schedule; 0 veto, 5 major, 8
minor). Kev's product decisions were fixed, not attacked: Boston demo place; B14 above the cut (auto-selected
landmarks for an unwalked route, user can choose candidates not preselected); Q4 HTML fragments allowed. Where the two
reports conflict, the simpler option that still satisfies correctness wins.

IDs: MEM-064 = B14a, MEM-065 = B14b, MEM-066 = B14c (highest existing was MEM-063). MEM-059 is NOT reused: a
superseded id reused for a new scope would make its Superseded marker ambiguous. ADRs stay placeholders
(ADR-next-routing, ADR-next-d1); the landing slice takes the next free number at rebase and replaces the placeholder
in plan + spec in the same commit.

MEM-059 criteria moved, none dropped: (1) coords validation (5 cases) -> B8 crit 9's 5 cases on the shared bad_coords
validator, which MEM-064 crit 3 (geocoder output) and MEM-065 crit 2 call; "stored at <= 4 dp" -> MEM-064 crit 3 +
MEM-066 crit 11; (2) badge-not-walked -> MEM-066 crit 13; (3) D9 practice over
2 planned + 4 walked -> MEM-066 crit 14; (4) 3-8 rule with planned stations -> MEM-066 crit 15; (5) suite green ->
every slice's last criterion. "Tap the schematic to add a station" -> B15 (needs a basemap).

| Src | Sev | Finding | Verdict | Where it landed |
|---|---|---|---|---|
| COR | major | Fixed 150 m spacing cannot meet the 16-sample cap on a 5 km route; > 16 maneuvers undefined | ACCEPT | Spacing max(150 m, distance/16); fill points dropped first; > 16 maneuvers -> 16 evenly by index (B14a crit 12) |
| COR | major | Two samples can resolve to the same Mapillary image; preselect can pick clashing names | ACCEPT | Client dedupes by image_url; preselect skips a name that clashes per the B5 rule (B14c crit 7, 9) |
| COR | major | Limiter wait unbounded; several Cloud Run instances break "1 req/s per application" | ACCEPT | Max-wait 5 s -> 503 planning_busy (B14a crit 6); max instances = 1 (Part C item 54) |
| COR | major | Part A / #meta-notice copy says location goes only to Mapillary | ACCEPT | Safety copy, #meta-notice and #plan-consent name every recipient (Part A); B11 crit 7 pins them |
| COR | major | OSRM NoRoute/NoSegment arrive as HTTP 400, not 404 | ACCEPT | 400 + NoRoute/NoSegment -> 404 no_route; other 400 -> 502 (B14a crit 9-10) |
| COR | major | Spark-generated names rendered into candidate rows: markup injection | ACCEPT | textContent only; payload test + innerHTML scan (B14c crit 12) |
| COR | major | Fragment "0 http(s) URLs" test fails the required OSM/Mapillary attribution links | ACCEPT | Exact exemption list (B11 crit 9) |
| COR | major | Plan beat records live on Tue with no fallback take | ACCEPT | Fallback take Mon night (schedule) |
| COR | major | Copley fallback points BPL and Tortoise and Hare sit near the Marathon finish | ACCEPT | Both marked avoid; Trinity Church only, re-probed before use (A3, B10) |
| COR | major | B14c case sum wrong (33 listed as 32) | ACCEPT | Recounted per criterion |
| COR | major | D12 omits the existing "error" status (D10) | ACCEPT | pending\|named\|error\|planned (D12) |
| COR | minor | 13 minors | ACCEPT, all 13 applied, 0 deferred | m1 recount + B14a crit 4 cases named; m2 D12 enum; m3 MEM-059 4 dp mapping (above); m4 B14b crit 7 budget + B14c crit 5 429; m5 B8's "upstream" code reused; m6 /plan-route address-only (A2); m7 no polyline stored, planned coords = sample point (A1, D12, B14c crit 11); m8 B7 crit 14 empty taps; m9 B14c crit 13 photo slot; m10 placeholders kept + landing SIGNAL `git grep 'ADR-next-'` == 0, ADR-next-d1 after the B8 ADR; m11 B14b SIGNALS Mapillary terms fetch; m12 B14a crit 4 UA contact; m13 probe coords as CLI args + filming per posted rules (B10) |
| SC | M1 | Swap/add/remove = three state machines over two lists + undo | ACCEPT | One checkbox list in route order, top 6 pre-checked; no #plan-candidates, no #plan-undo (B14c) |
| SC | M2 | Monday carries B14c behind three dependencies | ACCEPT | Response fixtures frozen in B14a/B14b RED; B14c starts Sun on them; S10 ships on shared route.css classes |
| SC | M3 | B14a re-specifies infra B8 already has | ACCEPT (modified) | Shared lock for both hosts, dict memo (64 cap, no TTL/LRU), B8 fetch helper/validator/property helper reused; 150 m fill kept (COR spacing rule) |
| SC | M4 | 16 sequential-ish Spark calls is slow on camera | ACCEPT (modified) | 3 in flight, rows render as they arrive, "n of m checked" status, fallback take; cap stays 16 (cut order lowers it to 10) |
| SC | M5 | Token, coverage and K1 trip unsequenced | ACCEPT | Sat token + remote coverage probe; Sun noon place decision for the plan beat; Risks upside; Q5 |
| SC | m1 | Re-plan discard logic | ACCEPT | #plan-go disabled while loading (B14c crit 4) |
| SC | m2 | One ADR instead of two | REJECT | ADR-next-d1 amends the B8 ADR, which lands with B8 wiring; a single ADR landing in B14a on Sat would amend an ADR not yet written |
| SC | m3 | B9 +3 for planned stations | ACCEPT | Export skips planned stations (consistent with D6); B9 +2 |
| SC | m4 | B14 wiring as its own Monday slice | ACCEPT | Last commit of the B8 wiring branch |
| SC | m5 | Second concurrency cap | ACCEPT | B14b shares B8's budget + cap object (crit 7) |
| SC | m6 | Five new B11 criteria | ACCEPT | Static scans merged (crit 9) + parent-child test (crit 10); copy/id guards = "0 edits" in crit 8 |
| SC | m7 | Log-capture/fixture-replay repeated per slice | ACCEPT | B8 tests parametrized over the new routes |
| SC | m8 | No cut order for a Monday slip | ACCEPT | "If late: cut order" under Risks |

Case totals (new): B14a 30, B14b 14, B14c 34, B7 +3, B9 +2, B10 +1, B11 +2 = 86 (amendment v0: 93).

## Part G slices (live slice text; the plan's Part B points here; above the cut)
Adversary-premise rule (moved from Part B rules): every adversary finding was read-only; each slice's first RED test exercises the cited code
path, so a premise that turns out false surfaces at RED (record it in the slice's commit, do not silently drop the criterion).

### B14a Geocode + walking-route proxy (server). MEM-064, ADR-next-routing
- Providers (no key, no CSP change, backend-only): OSM Nominatim (address -> lat/lon) and FOSSGIS OSRM foot (routing.openstreetmap.de).
  ADR alternatives: OpenRouteService / GraphHopper (API keys), client-side calls (connect-src widening; rejected), Mapillary-only sampling.
- src/memripal/routing.py + router factory routes_plan.py (shared with B14b; wired as the last commit of the B8 wiring branch, D7).
  POST /plan-route {from, to}, each exactly {address} (string, 3-200 chars; no lat/lon form). Response {points[] (4 dp, <= 200), samples[],
  distance_m, attribution "(c) OpenStreetMap contributors, ODbL", fix_url "https://www.openstreetmap.org/fixthemap"}.
- Samples: OSRM step maneuver locations + fill points every max(150 m, distance_m/16), dedup within 30 m, cap 16; over the cap, fill points
  drop first, then > 16 maneuvers -> 16 evenly by index, endpoints kept.
- Outbound: https only, host allowlist {nominatim.openstreetmap.org, routing.openstreetmap.de}, no cross-host redirect, byte cap, timeout,
  B8 fetch helper reused; User-Agent "MemriPal/<version>" + a contact Kev configures (never a library default); Nominatim limit=1; one
  shared lock for both hosts, >= 1 s between requests per host (injected clock), max wait 5 s -> 503 planning_busy; dict memo (64 entries,
  no TTL/LRU, never on disk); Cloud Run max instances = 1 (Part C item 54); kill switch MEMRIPAL_OSM_DISABLED=1 -> 503 planning_off; route
  > 5 km -> 422 too_far; error codes reuse B8's ("upstream").
- CRITERIA (30 cases): (1) passcode 401 before body read; (2) bad body -> 400 bad_plan, 0 outbound: extra key (incl. lat/lon), empty
  address, 201-char address, non-string address (4 cases); (3) geocoder output passes the shared bad_coords validator and reaches OSRM at
  <= 4 dp (20-input property test); (4) Nominatim spy (2 cases): https host + limit=1 + format jsonv2; User-Agent starts "MemriPal/" and
  carries the configured contact; (5) OSRM spy: foot profile path, steps on, simplified overview; (6) limiter (2 cases): 4 concurrent
  requests, fake clock -> outbound spacing >= 1 s per host; the one past max wait -> 503 planning_busy, 0 outbound; (7) identical geocode
  and identical route twice -> 1 outbound each; (8) empty geocode -> 404 place_not_found; (9) upstream 5xx, timeout -> 502 upstream,
  exactly 1 outbound (2 cases); (10) 422 too_far for > 5 km; OSRM HTTP 400 NoRoute and NoSegment -> 404 no_route; other 400 -> 502 (4
  cases); (11) response carries attribution and fix_url; (12) samples (3 cases): 1 km route -> every maneuver present, spacing <= 150 m;
  5 km route -> 16 samples, spacing <= distance/16 + 30 m; 20 maneuvers -> 16 kept, endpoints kept; (13) MEMRIPAL_OSM_DISABLED=1 -> 503
  planning_off, 0 outbound; (14) non-allowlisted host or http; cross-host redirect -> 502, no second fetch (2 cases); (15) B8 log-capture
  test parametrized: no address text, no lat/lon digits; (16) memo never touches disk (tmp cache_root unchanged after 3 requests);
  (17) B8 fixture-replay test parametrized, offline; (18) suite green. app.py cap: checked by the B14 wiring commit (D7).
- SIGNALS: Nominatim policy + FOSSGIS terms re-fetched and recorded in ADR-next-routing before RED; OSRM foot path, response fields and
  NoRoute/NoSegment codes confirmed by one live doc/API fetch before RED; fixtures synthetic near 0,0 only (B10 crit 6); Sat: token +
  remote coverage probe; landing commit replaces the placeholder (`git grep 'ADR-next-'` == 0).

### B14b POST /candidate: nearest Mapillary image + one Spark call (server). MEM-065, ADR-next-d1
- routes_plan.py. Body exactly {lat, lon, used_names} (B8 bad_coords + B4 bad_used_names validators). Reuses baseline.py (nearest CC BY-SA
  image within 30 m, allowlisted CDN, re-encode strips EXIF) -> one Spark chat_json on the re-encoded image {score 1-5 integer (memorability
  of a fixed landmark), station_name (<= 3 words, no digits), landmark_phrase, visual, spatial, conceptual}; prompt reuses B4 rules (fixed
  structures only, never describe people, never copy sign text/house numbers/street names, avoid used_names). Response {score, name,
  profile, image (JPEG data URL), author, image_url, licence}. Mapillary blurs faces/plates; no SAM (D1). Shares B8's budget + cap object.
- CRITERIA (14 cases): (1) passcode 401 before body read; (2) bad body -> 400, 0 outbound: extra key, bad coords (validator wired; its 5
  cases are B8 crit 9), bad used_names (3 cases); (3) no image within 30 m -> 404 no_baseline, 0 Spark calls; (4) Spark receives the
  re-encoded Mapillary bytes (1 chat_json, image sha == re-encoded sha); (5) score 0 or 6 / 4-word name -> one regenerate then 502
  bad_reply, never > 2 Spark calls (2 cases); (6) 0 SAM and 0 Muse Image calls on any path (recorder over 3-5); (7) shared cap: N+1
  concurrent -> 429 busy; budget N -> call N+1 = 429 budget_exhausted, 0 Spark (2 cases); (8) B8 log-capture test parametrized: no lat/lon
  digits, no token substring; (9) B8 fixture-replay test parametrized, offline; (10) suite green.
- SIGNALS: Mapillary terms on automated/AI processing fetched and recorded in ADR-next-d1 before RED (lands after the B8 ADR); one live
  /candidate at Christian Science Plaza after the Q3 token: score 1-5, name <= 3 words (Kev eyeballs); Spark latency logged.

### B14c S10 Plan screen: one checkbox list, Use these stations (client). MEM-066
- Part A S10 (ids prefix plan-): S1 gains #routes-plan ("Plan a route without walking"). #plan (section): #plan-from, #plan-to (text: "A
  landmark or street corner, not your home address"), #plan-go, #plan-status, #plan-consent, #plan-map (schematic SVG polyline, viewBox
  "0 0 320 200", no tiles), #plan-stations (ol, sample-index order; row = checkbox, Mapillary thumbnail + credit, name, score), #plan-use
  ("Use these stations"), #plan-attribution (ODbL text + "Fix the map" link). States: empty, loading, ready, error. Ships on shared
  route.css classes if the design addendum is late.
- Flow: #plan-go (disabled while loading) -> /plan-route -> /candidate per sample (3 in flight, <= 16; used_names = up to 7 returned names,
  highest score first) -> rows render as they arrive; dedupe by image_url; top 6 by score pre-checked (ties by route order), skipping a
  name that clashes with a checked one per the B5 rule; "n of m checked" status; #plan-use writes a draft route of planned stations (D12)
  and opens S4. Response fixtures frozen in B14a/B14b RED; starts Sun on them.
- CRITERIA (34 cases): (1) S10 ids + #routes-plan once each, 44 live ids unchanged; (2) #routes-plan shows #plan, hides S1;
  (3) #plan-consent == Part A string; (4) #plan-go -> exactly 1 /plan-route with the typed body; a second press while loading sends 0 (2
  cases); (5) #plan-status text for 404 place_not_found, 404 no_route, 422 too_far, 502, 503, 429 (6 cases); (6) /candidate spy: max 3 in
  flight and stops at 16; used_names = top-scored returned names, <= 7 (2 cases); (7) 404 no_baseline not listed; two samples with the
  same image_url -> 1 row (2 cases); (8) rows render on arrival in sample-index order with "n of m checked"; (9) preselect: 9 scored -> top
  6 checked; 4 -> all 4; < 3 checked -> #plan-use disabled + status; 9 scored with 3 clashing pairs -> 0 clashes among checked (4 cases);
  (10) checking a 9th row refused; (11) #plan-use: draft route, status planned, sample-index order, coords = sample point <= 4 dp, the final
  checked set (not the preselection), no polyline stored; S4 visible (2 cases); (12) name "<img src=x onerror=1>" and author "<b>x</b>"
  render as literal text (textContent); diff scan 0 innerHTML/outerHTML/insertAdjacentHTML under static/ (2 cases); (13) planned station
  on S3 and S5: badge-not-walked, baseline in the photo slot, no canvas error (2 cases; old MEM-059 crit 2); (14) practice over 2 planned +
  4 walked scores per D9, N = 6 (old crit 3); (15) 3 planned stations save, 2 refused (2 cases; old crit 4); (16) #plan-attribution ODbL
  text + https://www.openstreetmap.org/fixthemap link; every row shows Mapillary credit + link (2 cases); (17) every thumbnail src is a
  data: URL; (18) suite green + 360px screenshot.
- SIGNALS: Claude Design S10 addendum received (or shared route.css classes); 360px visual-verify record; live end-to-end plan at the
  plaza after the Q3 token (>= 3 candidates with an image).

### Deltas to existing slices (counted in the totals)
- B7 +3: (14) planned station: /associate body carries the station block from its profile with empty taps (check_station passes), 0
  baseline bytes or Mapillary links; (15) planned station -> 0 /scenes calls, card "Walk this station to add a scene"; (16) /split photo =
  the first walked station's pixelated photo; all-planned route sends static/assets/split-key.jpg (cache key only, split.py:101-113
  SEND_IMAGE False), never baseline bytes.
- B9 +2: (13) export of 2 planned + 4 walked carries the 4 walked only, 0 planned stations (D6); (14) import of a station with status
  planned or photo null -> refused, store unchanged.
- B10 +1: (12) demo-script.md has the plan beat at Christian Science Plaza (filming per posted plaza rules); the probe tool takes coords as
  CLI args; `git grep` of the five probe coordinates in memripal == 0. Crit 6 amended: 0 lat/lon/coords keys in demo data + fixtures
  except tests/fixtures/plan/, where every coordinate lies within 1 degree of 0,0. Probe tool recreated under scripts/ with test + README.
- B11 +2 (Q4): crit 2 = route.css selectors use only Part A ids, contract-table classes UNION fragment classes, or shared classes; crit 7
  gains these Part A strings, exact: safety location line "Location stays on this device, except: a station's location goes to Mapillary if
  you tick its street-photo box, and a route you plan goes to OpenStreetMap routing and geocoding services and to Mapillary, via our
  backend."; #meta-notice "Photos are sent to Meta's AI models: SAM 3.1 finds faces and plates, which are pixelated before Muse Spark names
  the landmark and before anything is stored. Location stays on your device unless you ask for a street photo of a station or plan a route;
  then it goes to Mapillary and to OpenStreetMap routing and geocoding services via our backend."; #plan-consent "Planning sends the places
  you type and points along the route to OpenStreetMap, FOSSGIS and Meta (Mapillary, Muse Spark) via our backend."; crit 8 =
  B3/B5/B6/B7/B8/B14c tests green with 0 id-list, copy or
  id-selector edits (className -> classList.contains edits listed in the commit); (9) static scans: every docs/design/*.html id is a Part A
  id; 0 script/style/link/iframe/object/form elements, 0 on*/style attributes; URLs only in a[href] with prefix
  https://www.openstreetmap.org/fixthemap or https://www.mapillary.com/; 0 innerHTML/outerHTML/insertAdjacentHTML added under static/;
  0 docs/design references in static/ or the E2E fetch log; (10) DOM test: direct parenthood for #route > li, #route-view-stations > li,
  #plan-stations > li, #capture-strip > children, #scene-overlay and its ancestors.

### B10 delta: retire /loci (ADR 0040 step 2; step 1 = MEM-073; 2026-11-02, not in the Part G totals)
- Once Load demo builds the demo route: delete the `/loci` route, tests/test_loci_api.py and the `/loci` POST in
  tests/test_demo_assoc_fixtures.py (~line 185; call `find_loci` directly). Drop "/loci" from src/memripal/ratelimit.py
  `LIMITED_ROUTES` + `CAPPED_ROUTES` and static/flow.js `PASSCODE_ROUTES`. No 410 stub: the page is the only client
  (A7). Port the ~16 load-demo test files once, onto the demo route. Drop the room shot (`load_demo.png`) from
  scripts/screenshot_ui.py; MEM-073's `route_view.png` stays.
- CRITERIA: (13) POST /loci -> 404 and `git grep -F '"/loci"' -- src static tests scripts` == 0.

## Below-cut slices B12, B13 (moved from the plan's Part B; only if time remains)

### B12 Intrusion counting + optional list cooldown. MEM-057, ADR (reuse/intrusions)
- Recall matcher also matches retired lists' items on the same route; such matches render in #history-intrusions and
  never count as hits. Optional cooldown before a route takes a new list (injected clock) decided in this ADR.
- CRITERIA: (1) transcript naming a retired item -> 1 intrusion, 0 hits for it; (2) current item -> hit; (3) no retired
  lists -> #history-intrusions hidden; (4) suite green.
- SIGNALS: none.

### B13 Optional video at a station: client keyframes. MEM-058
- <video> file -> 1-3 canvas keyframes -> /station as images; audio track never read or sent.
- CRITERIA: (1) 3 frames max; (2) no audio API used (static scan); (3) raw video bytes never uploaded (fetch spy).
- SIGNALS: 1-hour Spark video-input probe (not a dependency).

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
