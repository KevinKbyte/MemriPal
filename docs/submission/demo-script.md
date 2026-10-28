# MemriPal demo video script (3:00 max)

Rubric (Discord rules, `rules.md:64-69`, equal weight): **Impact**, **Use of Meta AI tooling**, **Technical depth and
execution**, **Demo quality**. Stage 1 (pass/fail) also checks theme fit and real Meta model use. The guide's own
rubric table (`hackathon.md:211`) is an empty placeholder; the Discord list is the latest text.

Recording rules:

- Record in LIVE `meta` mode (`scripts/run_live.ps1`), except the 5 s offline cut.
- Every fixture or replay segment carries the on-screen caption **"recorded replay"** (`hackathon.md:92`).
- Show only work built during the event; the opening line says so (`rules.md:7`, `rules.md:125-127`).
- Total runtime <= 3:00; the hero beat <= 60 s.

| Time | Beat | On screen | Voice-over (draft) | Rubric |
| --- | --- | --- | --- | --- |
| 0:00-0:10 | Framing + built-here line | Title card: "MemriPal: place-based recall coach for speeches, not a study chatbot" | "MemriPal is a place-based recall coach for speeches, not a study chatbot. Everything you see was built during this hackathon, starting Oct 26." | Demo quality; compliance |
| 0:10-0:25 | Problem | Kev at a lectern, notes in hand | "Reading a speech off notes loses the room. The method of loci works, but building a memory palace by hand takes hours." | Impact |
| 0:25-0:50 | Upload -> route | Photo upload; loci boxes appear in walking order | "I photograph a room I know. Muse Spark names the objects, SAM 3.1 boxes each one, and plain code orders them into a walking route." | Use of Meta AI tooling; Technical depth |
| 0:50-1:15 | Associations -> scenes -> walk | Paste speech notes; points split; KAVE COGS associations; Muse Image scenes on the photo; walk view | "Muse Spark splits my notes into key points and ties each to a spot, checked by a validator. Muse Image paints each scene onto my own photo." | Use of Meta AI tooling; Impact |
| 1:15-2:15 | **Hero: spoken recall** (60 s) | Split screen. Left: Kev eyes closed, delivering the pitch. Right: the palace; each point lights up as recall matches it; caption "LIVE". Kev deliberately skips one point -> misses list -> he re-recites it -> it lights up. Close on the rehearsal history and per-point hit rates. | (Kev's own spoken pitch; no voice-over) | Demo quality; Impact; Technical depth |
| 2:15-2:20 | Offline cut (5 s) | Network off, Load demo runs; caption **"recorded replay: fixture mode, offline"** | (none) | Technical depth |
| 2:20-2:45 | Model disclosure | Model names with their jobs; 8-10 s on the README `## Pipeline` mermaid diagram; 3-5 s on `static/recall_match.js` captioned "no LLM" | "Four Meta models: Muse Spark for the object names and associations, SAM 3.1 for the loci, Muse Image for the scenes, Muse Voice Transcribe for spoken recall. The matching is deterministic code, no LLM, so a speech can't prompt-inject the grader." | Use of Meta AI tooling; Technical depth |
| 2:45-3:00 | Close | Deployed URL + repo URL; VR clip only if S9 (WebXR stretch) shipped | "Try it at the link: Load demo runs with no key. Walk your palace, say it eyes closed, re-recite only what you missed." | Demo quality; Impact |

## Hero beat notes

- Kev skips exactly one point on purpose. Recall targets: >= 10/12 points, 0 false positives on unrelated speech.
- Keep D16 (the "why/apply" question) out of this beat.
- **Build gap (as of 642e102):** spoken recall records one clip and matches it only after Done
  (`static/flow.js`, `recall-submit` handler), and the app has no LIVE badge. "Lights up as spoken recall matches it"
  needs incremental matching during speech, or the beat shows the end screen's got/missed list right after Done.
  Add the "LIVE" caption in the video edit unless the app gains a badge.
- The in-app replay label reads "replay of a recorded session" (`static/recall.js` `REPLAY_LABEL`); the video caption
  still says "recorded replay".

## Backup clip

Record a separate full live-loop clip (not part of the 3:00) as the fallback for the finals and the live-product
check (plan, day schedule Nov 2).
