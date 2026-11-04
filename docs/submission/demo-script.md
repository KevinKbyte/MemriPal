# MemriPal demo video script (3:00 max)

Rubric (Discord rules, `rules.md:64-69`, equal weight): **Impact**, **Use of Meta AI tooling**, **Technical depth and
execution**, **Demo quality**. Stage 1 (pass/fail) also checks theme fit and real Meta model use. The guide's own
rubric table (`hackathon.md:211`) is an empty placeholder; the Discord list is the latest text.

Path: the map-first demo flow in [docs/plans/2026-11-03-demo-flow.md](../plans/2026-11-03-demo-flow.md) (S1-S7,
MEM-083..MEM-089): empty map, search Kendall T to the Meta office (100 Binney St), auto loci + swap, a photo on a
station, Memorize Deconstruct, spoken recall. Content: the 6 study techniques (retrieval practice, spaced practice,
interleaving, elaboration, concrete examples, dual coding), one per station on the 6-stop route. Record after S7
(MEM-089) lands.

Recording rules:

- Record in LIVE `meta` mode (`scripts/run_live.ps1`), except the 5 s offline cut.
- Kev's face stays out (dog-mascot ADR 0001, record wide, face out): Pal, the dog mascot, is on camera in Kev's place,
  driven live by Kev's face through MediaPipe; the webcam proof panel stays out of frame. Kev's voice stays.
- Every fixture or replay segment carries the on-screen caption **"recorded replay"** (`hackathon.md:92`).
- Show only work built during the event; the opening line says so (`rules.md:7`, `rules.md:125-127`).
- Total runtime <= 3:00; the hero beat <= 60 s. Budget below: 1:55 outside the hero + 60 s hero = 2:55.

| Time | Beat | On screen | Voice-over (draft) | Rubric |
| --- | --- | --- | --- | --- |
| 0:00-0:08 | Framing + built-here line | Title card: "MemriPal: place-based recall coach for speeches, not a study chatbot" | "MemriPal is a place-based recall coach, not a study chatbot. Everything you see was built during this hackathon, starting Oct 26." | Demo quality; compliance |
| 0:08-0:15 | Problem | Pal on camera, head down, mirroring Kev reading his notes | "Reading off notes loses the room. The method of loci works, but building a memory palace by hand takes hours." | Impact |
| 0:15-0:27 | Search the route | Empty map; Kev searches "Kendall T" to "Meta office"; the walking route to 100 Binney St draws | "I start from a walk I know: Kendall T to the Meta office. Routing runs offline on an OpenStreetMap walking graph." | Technical depth; Impact |
| 0:27-0:40 | Auto loci + swap | Landmarks appear in walking order along the route, each with a street address; Kev swaps one for an alternate | "MemriPal picks landmarks along the route as loci. I don't like this one, so I swap it; nothing else changes." | Technical depth; Demo quality |
| 0:40-0:52 | Photo on a station | From the routes list, Kev adds his own walk photo to one station; the station shows its name and box | "I add my own photo. SAM 3.1 blurs people and license plates before Muse Spark sees it; Spark names the spot and SAM boxes it." | Use of Meta AI tooling |
| 0:52-1:10 | Memorize: Deconstruct | Kev pastes the 6-technique text; Deconstruct with the keywords, mnemonics and recommended associations checkboxes; 6 keywords, one per station; the route recommendation with its reason | "Muse Spark breaks the text into six keywords and ties each to a station. MemriPal recommends this route because it has room for all six." | Use of Meta AI tooling; Impact |
| 1:10-1:20 | SAM + Muse Image beat | Open choice, see below | Open choice, see below | Use of Meta AI tooling |
| 1:20-2:20 | **Hero: spoken recall** (<= 60 s) | Sub-beat timings TBD (S7). Pal's eyes close while Kev recites the 6 techniques, walking the route in his head and deliberately skipping one; the board (badge "LIVE") lights each station as he says it, the skipped one stays unlit; Kev presses Done. End screen: got/missed per station, the skipped one missed; Kev clicks "Mark got it" (or re-recites it in a second run) and the count updates. Close on the rehearsal history and per-station hit rates. | (Kev's own spoken recall; no voice-over) | Demo quality; Impact; Technical depth |
| 2:20-2:25 | Offline cut (5 s) | Network off, Load demo runs; caption **"recorded replay: fixture mode, offline"** | (none) | Technical depth |
| 2:25-2:45 | Model disclosure | Model names with their jobs; 8-10 s on the README `## Pipeline` mermaid diagram; 3-5 s on `static/recall_match.js` captioned "no LLM"; caption `Muse Spark Open on Baseten (open weights)` | "Four Meta models: Muse Spark, running as the open-weight Muse Spark Open on Baseten, for the station names, keywords and associations, SAM 3.1 for the loci and the privacy blur, Muse Image for the scenes, Muse Voice Transcribe for spoken recall. The matching is deterministic code, no LLM, so a speech can't prompt-inject the grader." | Use of Meta AI tooling; Technical depth |
| 2:45-2:55 | Close | Deployed URL + repo URL; VR clip only if the WebXR stretch shipped | "Try it at the link: Load demo runs with no key. Walk your palace, say it eyes closed, re-recite only what you missed." | Demo quality; Impact |

## SAM + Muse Image beat (open choice)

The map path shows SAM 3.1 only as the station photo's privacy blur and box, and Muse Image not at all. Where the
segmentation and scene rendering show is undecided (audit item 3); Kev picks one:

- **Load demo photo cut:** Load demo on the demo photo; SAM 3.1 boxes the loci in walking order and Muse Image
  paints the scenes onto the photo (the shipped photo flow).
- **S10 MEM-092:** static-part sub-loci, numbered SAM parts overlaid on the Kendall T station photo (ADR 0051).
  The plan names no Muse Image step for it.

The disclosure voice-over's Muse Image clause must match the option chosen.

## Hero beat notes

Timings inside the hero depend on S7 (MEM-089): TBD (S7).

- Kev skips exactly one technique on purpose. Recall target for the 6 stations: TBD (S7); 0 false positives on
  unrelated speech.
- Keep D16 (the "why/apply" question) out of this beat.
- Shows live lighting (MEM-037): the clip is sliced every 5 s (1 s overlap) through the recall relay, so a point
  lights a few seconds after Kev says it; Done posts the remainder, which can light the last points before the end
  screen (`static/flow.js` `recall-submit` handler). Pause briefly after the last point so it lights on camera.
- If the relay fails mid-run, the page drops to typed answers with "Speech relay failed (<code>)" and lit points
  stay lit: re-shoot rather than type.
- The replay board badge reads "recorded replay"; the replay button and results label read "replay of a recorded
  session" (`static/recall.js` `REPLAY_LABEL`); the video caption still says "recorded replay".

## Backup clip

Record a separate full live-loop clip (not part of the 3:00) as the fallback for the finals and the live-product
check (plan, day schedule Nov 2; S7 signal: live backup clip recorded).
