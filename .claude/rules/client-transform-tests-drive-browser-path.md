---
paths:
  - "static/**"
---

# Client-side transform tests drive the browser path

- A test for a client-side transform (re-encode, EXIF strip, any byte change before upload) drives the page's own
  handler (`static/app.js` exports such as `onPhotoChange`/`onLoadDemo` with injected deps), never POSTs the raw asset
  to the endpoint: a raw POST skips the transform, so it passes while the browser path fails. Reference: S2.6 raw-POST
  tests passed while the browser's re-encoded demo missed the replay (`fixture_missing`, ADR 0016); closed by
  `static/app_upload_flow.test.mjs` (52bf8b8, pre-rebase cf90d5b).
