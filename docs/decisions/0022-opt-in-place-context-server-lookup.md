# 0022: Opt-in place context via server lookup

Status: Accepted (amends [0009](0009-image-intake-and-photo-privacy.md): GPS is read client-side from the original
file when opted in)
Date: 2026-10-27
Source: plan S3e (MEM-025); RED tests `static/place.test.mjs`, `tests/test_place_api.py`,
`tests/test_associate_place.py`. Kev 2026-10-27: "add a setting feature where user can enable location access to
check for any historical significance of picture being taken to use that as part of context for memory hook" /
"opt-in for privacy". Chosen by Kev after 3 adversaries.

## Context

A photo taken at a historic site (e.g. Little Round Top, Gettysburg) can ground the association in real place facts.
[0009](0009-image-intake-and-photo-privacy.md) strips EXIF/GPS in the client re-encode before anything is sent, and
location is sensitive, so any lookup must be opt-in, easy to turn off, and keep coords away from Meta and storage.

## Options considered

- (a) Server lookup: settings toggle "Use my location for place history", OFF by default (localStorage), one tap off.
  When on, coords from the ORIGINAL file's EXIF GPS (read before `reencodeJpeg`; server `has_exif` rejection
  untouched), else `navigator.geolocation`, else a typed place. Client sends 4 dp coords to stateless POST /place;
  `PlaceProvider` queries Wikipedia GeoSearch (500 m) + REST summary (custom User-Agent, 2 s timeout, in-process LRU),
  returns the top 3; the user confirms one chip; /associate carries only {title, extract <= 400}.
  Pros: one server-controlled egress (User-Agent, timeout, cache, 429 -> empty list); recorded replay keeps the demo
  offline and testable under the injected httpx transport; coords never reach Meta or the cache key; confirm chip and
  cited title bound model embellishment.
  Cons: server transiently sees coords (mitigated: never logged or stored, httpx URL logging silenced).
- (b) Browser-direct Wikipedia lookup from the client.
  Pros: the server never sees coords.
  Cons: no fixture replay for the offline demo; per-client User-Agent and rate-limit handling; lookup logic outside
  pytest; Wikimedia still sees coords.
- (c) EXIF-only (no geolocation or typed fallback).
  Pros: smallest surface; no browser permission prompt.
  Cons: photo pickers often strip GPS, so the feature silently does nothing for many users; no path for a photo taken
  elsewhere.

## Decision

(a). Toggle off -> no /place call, the confirmed place is discarded, no auto place on /associate (a typed place is
still allowed). Without a place, /associate prompt args and cache key are byte-identical to before (digest pinned).
Offline demo: synthetic room photo + demo place sidecar (Little Round Top 39.7922,-77.2366) + recorded /place replay
(Kev Q8, 2026-10-27); a real own-room photo may replace it later.

## Why this over the others

Only (a) keeps the feature demoable offline from recorded fixtures and testable end to end while keeping coords out of
Meta calls, the cache key and storage; (b) loses replay and server-side rate-limit control for a privacy gain that
Wikimedia exposure already caps; (c) fails whenever a picker strips GPS.

## Consequences

- 0009 amended: with the toggle on, GPS is read client-side from the original file only; the uploaded bytes are still
  the EXIF-free re-encode and GPS is never sent to Meta or stored.
- Residual cons (accepted): the server transiently sees coords; Wikimedia sees coords; the model may embellish place
  facts (mitigated by the confirm chip and cited title); low value for home palaces; photo pickers may strip GPS
  (geolocation fallback).
- Wikipedia extracts are CC BY-SA 4.0: shown and prompted text needs attribution (README Credits).
- Place is part of the association cache key; existing fixtures replay unchanged.
