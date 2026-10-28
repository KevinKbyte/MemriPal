# MemriPal submission and compliance checklist

Deadline: official hard deadline **Wed Nov 4, 9:00 PM ET** (`hackathon.md:191`, `rules.md:21`); internal target
**Tue Nov 3, 8:00 PM ET**, Nov 4 is buffer (plan S8). Submit at https://cerebralvalley.ai/e/meta-ai-developer-hackathon/hackathon/submit
(one submission, by the Representative). "Kev" = only Kev can do it; checked = verified in this repo.

## Rules compliance

- [x] Official Rules re-read 2026-10-28: `hackathon.md` sections 4, 7, 8 and Discord `rules.md`.
- [ ] Kev: re-check Discord #announcements for rule changes right before recording (plan R4).
- [x] Theme fit: "Build for Your World" (`rules.md:18`); framing avoids the "AI for Education" chatbot and "Simple
  Image Analyzers" anti-projects (`hackathon.md:100`).
- [x] Meta models used through the Meta Model API: Muse Spark, SAM 3.1, Muse Image, Muse Voice Transcribe
  (`src/memripal/meta_client.py`; README "Meta models").
- [x] New work only: first commit `f59adc0` at 2026-10-26 12:57 ET, after hacking started 12:24 PM ET; README
  "Built during the hackathon" says so.
- [ ] Kev: keep the Discord "hacking has officially started" screenshot (12:24 PM ET) as evidence.
- [x] Rights: demo fixtures are synthetic (`fixtures/MANIFEST.md`); Wikipedia text credited CC BY-SA 4.0; KAVE COGS
  paraphrased and credited; the AI-generated reference image is disclosed in the README.
- [ ] Kev: one track only, Indie Developer (`rules.md:11`).
- [ ] Kev: live real-scene fixtures: record a live run on the real demo photo (saved to `refs/private/live-cache`,
  gitignored; ADR 0017). Committed demo fixtures stay synthetic until a promote step exists.

## Video

- [x] Script written, each beat mapped to the rubric: [demo-script.md](demo-script.md).
- [x] Framing beat: "place-based recall coach for speeches, not a study chatbot" (script 0:00, README intro).
- [x] Hero beat matches the build: end-of-run got/missed after Done, no live lighting (plan cut ladder item 4;
  [demo-script.md](demo-script.md#hero-beat-notes)). Re-shoot if live loci lighting lands.
- [ ] Kev: record in LIVE `meta` mode; >= 10/12 points recalled, 0 false positives on unrelated speech.
- [ ] Kev: hero take <= 60 s; total video <= 3:00.
- [ ] Kev: every fixture/replay segment captioned "recorded replay"; 5 s fixture-mode-offline cut included.
- [ ] Kev: backup clip of the full live loop (separate from the 3:00 video).
- [ ] Kev: upload the video; open the link in a logged-out/private window and confirm it plays.

## Repo and live product

- [x] README final pass: framing, built-during-event note, Meta API call map, model disclosure, AI image disclosure.
- [ ] Kev: make the GitHub repo public; open it logged-out and confirm README, code and LICENSE load.
- [ ] Kev: deploy to Cloud Run (`sh scripts/deploy_cloud_run.sh`, `docs/runbooks/deploy-gcp.md`); open the URL
  logged-out: banner "live needs passcode / try Load demo" shows and Load demo runs the loop.
- [ ] Kev: replace the README `TODO(Kev)` video and deployed-URL placeholders.

## Submission form

- [ ] Required per rules: 3-min demo video link, public repo link, every contributor's name (`rules.md:22`,
  `rules.md:101`). TODO(Kev): confirm the live form's actual fields (may differ from or exceed these three).
- [ ] Kev: contributor list complete (solo: Kev).
- [ ] Kev: deployed GCP URL in the submission (judges assess the live product, `hackathon.md:199`).
- [ ] Kev: live-mode passcode shared only in the submission notes (plan D1), never in the repo.
- [ ] Kev: submitted before Nov 3 8:00 PM ET (hard stop Nov 4 9:00 PM ET); confirmation email received.

## Credits

- [ ] Kev: Meta Model API $150 credits claimed individually by Nov 4, 9:00 PM ET (`hackathon.md:117`); card on file.
- [ ] Kev: Modal credit form TODOs (gates only the off-by-default `MEMRIPAL_SEG_PROVIDER=modal` adapter).
- [x] Baseten: $100 granted; model id `meta-models/muse-spark-open-1026` (README "Modes").
- [ ] Kev: Fireworks serverless preview ends Oct 29; do not rely on `MEMRIPAL_CHAT_PROVIDER=fireworks` after it.

## Optional

- [ ] Kev: Most Viral bonus: post the demo on X and submit the post link; engagement counts through Nov 8
  (`rules.md:118`).
