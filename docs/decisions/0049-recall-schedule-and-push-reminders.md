# 0049: Recall schedule is countdown doubling with an S+1d floor; in-app due list baseline, web push for phone reminders

Status: Accepted (stretch)
Relates: [0048](0048-memorize-breakdown-and-route-recommendation.md) (`remember_by`),
[0050](0050-two-flows-one-codebase-push-only-service-worker.md) (service worker),
[0032](0032-capacitor-android-shell.md) (Capacitor), [0025](0025-passcode-gate-and-host-allowlist.md) (auth).
Date: 2026-11-03
Source: demo-flow eval (agent-workflow plan note memripal-2026-11-03-demo-flow-eval-h28), findings De, R3. Kev,
2026-11-03: reminders are stretch 1; channel = phone notifications (chose push over in-app + .ics).

## Context

A memorized item may carry a deadline (`remember_by`). The app should schedule reviews before it and remind the user
on their phone. Constraints:

- Judges use the hosted URL, mostly on phones; the app also ships as a Capacitor Android build
  ([0032](0032-capacitor-android-shell.md)).
- iOS delivers web push only to Home Screen PWAs (16.4+), and the permission prompt must follow a user gesture. The
  Capacitor Android WebView has no Web Push. Browsers have no server-free future notification (Notification Triggers
  ended).
- Server push needs a durable subscription store and a periodic tick; the backend is otherwise stateless
  ([0003](0003-stateless-backend-client-state.md)).
- CSP is `default-src 'self'` with no `connect-src` (`src/memripal/security_headers.py::SECURITY_HEADERS`).

## Options considered

Schedule:

- (a) Countdown doubling from the deadline T: anchors T-1d, T-2d, T-4d, T-8d ... kept if >= S+1d (fixed floor), drop
  an anchor within 1d of the previous, plus S+10min and S+1h on day S; a failed recall adds a +1d re-review; no
  deadline = 1, 3, 7, 14, 30, 60, 120 d; T within 1d of S = same-day +10m / +1h / +4h; deadline passed = no schedule,
  offer a new date (chosen). Simulated S = 11-03 18:00, T = 11-21: 18:10, 19:00, 11-05, 11-13, 11-17, 11-19, 11-20;
  T = S+12h: 18:10, 19:00, 22:00; passed: [].
  Pros: spacing grows toward the deadline (Cepeda 2008, pubmed 19076480); a pure function, testable on these values.
  Cons: a fixed rule, not adaptive per item.
- (b) An adaptive SRS (SM-2 style).
  Pros: per-item tuning.
  Cons: needs grading history; ignores a hard deadline.

Reminder channel (the in-app due list in the Recall tab is the baseline under every option):

- (a) Web push: service worker + VAPID + `pywebpush` (2.5.0), a durable subscription store, a Cloud Scheduler OIDC
  tick that sends due reminders, and its own auth on `/push/*`; plus `@capacitor/local-notifications` in the
  Capacitor Android build (chosen by Kev).
  Pros: real phone notifications from the hosted URL; Android Chrome works directly, iOS after Add to Home Screen;
  the Capacitor build notifies on-device with no server.
  Cons: the largest build here: a store, a scheduler, VAPID key custody, a service worker, a new authed route, a CSP
  `connect-src` review; iOS needs the Home Screen step.
- (b) In-app due list + `.ics` download (`VEVENT` + `VALARM`).
  Pros: no service worker, permission or CSP change; the phone's calendar fires the alarm.
  Cons: not a notification from the app; one manual import per item; a schedule change needs a re-download.
- (c) Capacitor local notifications only.
  Pros: on-device, no server.
  Cons: nothing for the hosted URL judges use; plugin not installed yet.
- (d) In-app due list only.
  Pros: no new surface.
  Cons: no reminder when the app is closed.

## Decision

Schedule (a) as a pure module. Channel (a): the in-app due list is built first (the schedule module needs it either
way), then web push for the hosted URL and `@capacitor/local-notifications` for the Capacitor build. `.ics` (b) is
kept as a cheap fallback where push is unavailable (iOS outside the Home Screen).

## Why this over the others

Schedule: (a) honours the deadline and is a pure function with fixed, simulated values; SM-2 ignores the deadline.
Channel: Kev chose phone notifications. Judges open the hosted URL, so (c) alone reaches none of them and (d) none
when the app is closed; (b) is a calendar import, not an app notification. Only (a) notifies from the hosted URL and,
with the plugin, from the Capacitor build.

## Consequences

- New: VAPID keys (secret custody as in [0005](0005-api-key-custody.md)), a durable subscription store, a Cloud
  Scheduler job with OIDC to a tick endpoint, auth on `/push/*`, and the root service worker
  ([0050](0050-two-flows-one-codebase-push-only-service-worker.md)).
- CSP needs a `connect-src` review for the push service endpoint.
- iOS: the permission prompt sits behind a button tap; the UI explains Add to Home Screen.
- `@capacitor/local-notifications` is a new dependency in the Android build.
- Stretch: lands only after the must-haves; the due list alone ships if push runs out of time.
