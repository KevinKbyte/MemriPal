# MemriPal spec (continuation)

Continuation of [spec-2.md](spec-2.md), which is at its 500-line cap.

## MEM-041 v6 Review prototype kept as a design reference

Source of the claude.ai "MemriPal Prototype" artifact (Version 7, https://claude.ai/artifact/RBvuQkU4vM3u7f5AhhdbKN)
committed under `docs/design/v6/`: `memripal-prototype.html`, `app.js`, `review.js`, `sched.js`, `tags.js`,
`styles.css`. Standalone design reference (v6: palace tags Talk/Exam/user tags, optional dates, Review sort/filter),
not served by the app; nothing under `static/` changes.
- Regression rule: `photo()` in `docs/design/v6/app.js` renders cropped place photos with
  `<use href="#room" width="800" height="560"></use>`. Without explicit width/height the room symbol sizes to the crop
  viewBox, so Review cards and Scenes tier-2 cards for off-origin places (e.g. Wedding toast clock, window, armchair,
  rug) render blank.
- The node test runs in `scripts/check.sh` alongside `static/*.test.mjs`.

Tests: docs/design/v6/tests/crop_use_size.test.mjs
