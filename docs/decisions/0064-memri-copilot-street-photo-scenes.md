# 0064: Memri copilot turns Mapillary street photos into AI memory scenes, behind a Pal chat bubble

Status: Accepted (Kev, 2026-11-03)
Amends: D1 of `docs/plans/2026-10-31-map-to-palace.md` (Mapillary images may now go to SAM and Muse Image).
Relates: [0012](0012-vr-imagery-mapillary.md) (Mapillary terms), [0005](0005-api-key-custody.md) (token
custody), 0060 (MEM-094 spend guard, branch `mem094-metaguard`, not landed), 0064 (MEM-093 Memri assistant, slice
S11), MEM-053 (`/baseline` server core), MEM-097 / MEM-098 / MEM-099.
Date: 2026-11-03
Source: Kev, 2026-11-03, item 21 "Memri copilot", after a 3-lens review of options A-C.

## Context

D1 keeps Mapillary baselines display-only: never sent to Muse Image or SAM, so ADR 0012's CC BY-SA share-alike duty
stays out of generated scenes. Item 21 wants a copilot that can fill a station from a real Kendall street photo.
Constraints:

- Item-22 slice S11 (MEM-093, ADR 0064: `static/assistant_plan.js`, `static/assistant_run.js`, POST
  `/assistant/plan`) already plans and runs assistant actions; it keeps photos manual and pauses at photo-less
  stations. <!-- claim-exempt: planned -->
- S6 owns the hot shell files (`static/index.html`, `static/app.js`, `static/style.css`).
- Spend per run is about 30 calls: 6 stations x (3 SAM + 1 Spark + 1 Muse Image). Muse Image $0.01/image, Spark
  $1.25/1M input tokens, SAM price undocumented; estimate $0.10-0.30/run against $150 Meta credits. Quota is not the
  constraint.
- At decision time the MEM-094 spend guard did not price Muse Image `/images/edits`
  (`src/memripal/meta_client.py::MetaClient.image_edit`); MEM-121 later charged it
  (`src/memripal/meta_spend_guard.py::IMAGE_CALL_COST_USD`).
- Deadline: Wednesday noon.

## Options considered

- (A) Lean: a separate copilot; street photos display-only (D1 kept).
  Pros: zero spend; zero licence risk.
  Cons: duplicates the S11 assistant (MEM-093, ADR 0064); touches the S6 hot files.
- (B) Full AI scenes: amend D1 so street photos go through SAM + Muse Image into memory scenes (chosen).
  Pros: the demo turns real Kendall streets into memory scenes.
  Cons: the licence conditions under Consequences; the spend guard must learn to count Muse Image edits; Wed-noon
  schedule risk.
- (C) S11 add-ons: pure modules S11 imports (`static/tool_policy.js`, `static/undo_stack.js`,
  `static/street_photo.js`), a `/baseline` mount, recorded fixtures; D1 kept; placed in S11's Memorize-tab chat box.
  <!-- claim-exempt: planned -->
  Pros: no duplicate assistant; small, testable modules; fixture-first.
  Cons: D1 kept, so no street-photo scenes; the Memorize-tab box is reachable from one tab only.

## Decision

(B), built C-style: pure modules where possible (MEM-097 dispatcher with per-tool allow/ask/off and undo, MEM-098
street-photo scene tool via POST `/baseline`), placed behind a floating Pal button on every screen (MEM-099; Kev chose
it over the Memorize-tab box). The demo runs in fixture mode from recorded responses; one live token run records
them. Kev is registering a Mapillary client token.

## Why this over the others

Only (B) shows real Kendall streets as memory scenes, the point of the demo. Spend is cents per run, so (A)'s
zero-spend edge buys little, and its separate copilot duplicates S11. C-style modules keep (B) testable and
fixture-driven, and the floating button reaches the copilot from every screen, not one tab.

## Consequences

Licence (Mapillary Terms of Use eff. 2024-02-15, mapillary.com/terms; CC BY-SA 4.0 legal code):

- Official Graph API with a registered `client_id` only; no scraping (s5(a), s11).
- Only CC BY-SA images (s3(b) allows other licences, such as CC BY-NC-SA, on some data); verify per image.
- Never unblur or re-identify (s5(a)). Muse Image prompts say not to alter or restore faces or plates. Every recorded
  scene is reviewed by hand; any photo or scene with a visible or reconstructable face or plate is dropped. This is
  the main risk.
- Every scene derived from a street photo shows: the Mapillary logo linked to the image page (s11), the contributor
  username (API `creator` field), a link to the original image, an "AI-modified" note (CC s3(a)(1)(B)), and "CC BY-SA
  4.0" with a licence link (s3(a)(1)(C)). Derived scenes are CC BY-SA 4.0 with no extra restrictions (s3(b)) and no
  implied endorsement (s2(a)(6)). The demo video ends with a credit slate.
- Fixtures committed to the public repo carry a per-image credits/licence file.
- The terms are silent on third-party generative AI; optional certainty via support@mapillary.com.

Token and spend:

- Token custody follows ADR 0005: DPAPI file `~/.secrets/mapillary-token.dpapi`, decrypted by `scripts/run_live.ps1`
  into `MEMRIPAL_MAPILLARY_TOKEN` (`src/memripal/baseline.py` `TOKEN_ENV`) for the child process only. Never `.env`,
  the repo, or chat. Cloud Run custody belongs to a separate deploy-hardening session.
- The MEM-094 spend guard (ADR 0060) must count Muse Image `/images/edits` before any live run.

Coordination:

- Overlaps S11 (MEM-093, ADR 0064): item 21 adds a street-photo op, or treats a street photo as filling S11's
  photo-less pause, subject to the S11 owner agreeing.
- The Pal button edits the S6 hot files, so MEM-099 lands after S6. Superseded by the amendment below: the only S6
  hot-file edit is one mount line in `static/index.html`, after MEM-088.

## Amendment 2026-11-03: chat bubble

Source: Kev, 2026-11-03: a Messenger-style bubble, draggable, multiple user-managed chats in the on-device SQLite db,
carried by export/import. The floating Pal button becomes a self-mounting Pal chat bubble (MEM-099,
`static/pal_bubble.js` + `.css`); chats live in new `chats` + `chat_messages` tables (migration V2, soft delete,
`static/chat_store.js`); never stored on the server. <!-- claim-exempt: planned -->

Options for carrying chats in export/import:

- (i) `chats[]` inside the palace backup, bumped to `v: 3` (chosen).
  Pros: one file holds all user data; reuses `static/palace_export.js` allow-list rebuild, caps and import path; v2
  files still import (no chats).
  Cons: old clients reject a v3 file (`exactKeys`); acceptable, there are no deployed users.
- (ii) A separate chats export file.
  Pros: no backup version bump.
  Cons: two files to manage and pair up; a second validator duplicating the allow-list and caps.

(i) wins: one backup file keeps export/import a single action, and the existing validator already enforces caps and
0 partial writes, so hostile `chats[]` input gets the same treatment as hostile routes.
