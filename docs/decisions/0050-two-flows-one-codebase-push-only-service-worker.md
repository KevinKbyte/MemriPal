# 0050: Phone and desktop flows share one codebase via a breakpoint and capability checks; service worker is push-only

Status: Accepted
Relates: [0045](0045-map-first-shell-tabs-and-panel-placement.md) (shell),
[0049](0049-recall-schedule-and-push-reminders.md) (push), [0032](0032-capacitor-android-shell.md) (Capacitor).
Date: 2026-11-03
Source: demo-flow eval (agent-workflow plan note memripal-2026-11-03-demo-flow-eval-h28), findings Df, Dg. Kev,
2026-11-03: phone notifications (0049) need a service worker, so the eval's "no service worker" no longer holds.

## Context

The demo has a phone flow (walk, capture, recall) and a desktop flow (plan a route, memorize). Constraints:

- One stylesheet already switches at a single breakpoint: `@media (min-width: 900px)` (`static/style.css:789`).
- Assets are unversioned (`<script type="module" src="/static/app.js">`, `static/index.html:227`) and served by a
  plain `StaticFiles` with ETag only (`src/memripal/static_files.py::static_files`), so a caching service worker
  could pin stale JS with no version to bust.
- Web push ([0049](0049-recall-schedule-and-push-reminders.md)) requires a service worker; a same-origin one is
  allowed by the CSP. The Capacitor build uses local notifications instead.

## Options considered

Flows:

- (a) One codebase: the 900 px breakpoint plus capability checks (touch, camera, geolocation); never hide a feature,
  only reorder flows and pick the default tab; a `?flow=` override for screenshots only (chosen).
  Pros: one DOM and one test suite; every feature reachable on both; no build split.
  Cons: each screen must lay out at both widths.
- (b) Two apps or two entry pages.
  Pros: each tuned to its device.
  Cons: duplicated ids and flows, the split 0045 rejected for tabs; two Capacitor bundles to reason about.
- (c) User-agent sniffing.
  Pros: simple switch.
  Cons: unreliable; wrong on tablets and desktop touch screens.

Service worker:

- (a) Push-only service worker at root `/sw.js`, network-first with no asset caching, not registered under
  Capacitor (chosen).
  Pros: enables web push; no cached asset can go stale, so unversioned assets stay safe; Capacitor keeps its
  bundled assets and local notifications.
  Cons: a root route for `/sw.js` (scope must be `/`); no offline web mode.
- (b) No service worker.
  Pros: nothing to go stale.
  Cons: no web push, which Kev chose for reminders.
- (c) A caching (offline-first) service worker.
  Pros: offline web app.
  Cons: with unversioned assets it serves stale JS after a deploy; needs asset versioning first.

## Decision

Flows (a), service worker (a). `scripts/screenshot_ui.py` adds `has_touch` / `is_mobile` to its 375 px page so the
phone flow renders as on a phone.

## Why this over the others

Flows: (a) keeps one DOM and every feature on both devices; (b) duplicates what 0045 consolidated, (c) guesses wrong.
Service worker: push needs one, which rules out (b); (c) breaks deploys while assets are unversioned. A push-only,
network-first worker gets notifications with no staleness risk.

## Consequences

- New root route serving `/sw.js`: a worker under `/static/` could only control `/static/`.
- CSP review: `connect-src` for the push subscription flow; `worker-src` falls back to `default-src 'self'`.
- Registration is skipped when running under Capacitor.
- Offline web caching stays out until assets are versioned.
